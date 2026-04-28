/**
 * High Burn Indexer — scans Ethereum blocks and indexes high-burn candidates.
 *
 * Computes burnGwei = floor(baseFeePerGas * gasUsed / 1e9) for each block,
 * assigns it to a tier bucket via assignTier(), and writes qualifying blocks
 * to the high_burn_candidates table.
 *
 * Exported for testability:
 *   - assignTier(burnEth, tiers): number | null
 *   - indexBlockRange(from, to, minEth, opts): Promise<IndexSummary>
 */

import { getBlock } from "./ethClient.js";
import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { upsertHighBurnCandidate, countHighBurnCandidatesByTier, getDb } from "./db.js";

// ---------------------------------------------------------------------------
// Tier assignment
// ---------------------------------------------------------------------------

/**
 * Assign a block to its tier bucket.
 *
 * Algorithm:
 *   1. Sort tiers descending.
 *   2. Find the largest tier value where burnEth >= tier.
 *   3. Return that tier value, or null if burnEth < min(tiers).
 *
 * Examples (tiers = [100,90,50,20,10,5,4,3,2,1,0.5,0.25,0.1]):
 *   burnEth=99.9  → 90
 *   burnEth=90.0  → 90
 *   burnEth=89.999 → 50
 *   burnEth=4.7   → 4
 *   burnEth=3.99  → 3
 *   burnEth=0.09  → null
 */
export function assignTier(burnEth: number, tiers: number[]): number | null {
  const sorted = [...tiers].sort((a, b) => b - a); // descending
  for (const tier of sorted) {
    if (burnEth >= tier) return tier;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Index summary
// ---------------------------------------------------------------------------

export interface IndexSummary {
  scanned: number;
  discovered: number;
  cached: number;
  skipped: number;
  belowTier: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Terminal statuses — skip-seen check
// ---------------------------------------------------------------------------

const SKIP_SEEN_STATUSES = new Set([
  "submitted",
  "finalized",
  "minted_elsewhere",
  "skipped",
  "fee_required_skipped",
  "not_eligible",
]);

// ---------------------------------------------------------------------------
// Main indexing function
// ---------------------------------------------------------------------------

/**
 * Index a range of blocks for high-burn candidates.
 *
 * @param fromBlock  Start block (inclusive). Minimum 12965000 (EIP-1559).
 * @param toBlock    End block (inclusive). If undefined, uses current chain head.
 * @param minEth     Minimum burn ETH threshold for indexing.
 * @param opts       Options: useCache, cacheTtlHours, skipAlreadySeen, batchSize, maxPerTier, tiers
 */
export async function indexBlockRange(
  fromBlock: number,
  toBlock: number,
  minEth: number,
  opts: {
    useCache: boolean;
    cacheTtlHours: number;
    skipAlreadySeen: boolean;
    batchSize: number;
    maxPerTier: number;
    tiers: number[];
    concurrency?: number;
  }
): Promise<IndexSummary> {
  const summary: IndexSummary = {
    scanned: 0,
    discovered: 0,
    cached: 0,
    skipped: 0,
    belowTier: 0,
    errors: 0,
  };

  const effectiveFrom = Math.max(fromBlock, 12965000);
  const db = getDb();
  const concurrency = opts.concurrency ?? 5;

  // Process blocks in concurrent micro-batches
  for (let batchStart = effectiveFrom; batchStart <= toBlock; batchStart += concurrency) {
    const batchEnd = Math.min(batchStart + concurrency - 1, toBlock);
    const blockNums: number[] = [];

    // Pre-filter: cache check (synchronous DB reads) before issuing RPC calls
    for (let block = batchStart; block <= batchEnd; block++) {
      if (opts.useCache) {
        const cached = db
          .prepare("SELECT status, seen_at FROM high_burn_candidates WHERE block = ?")
          .get(block) as { status: string; seen_at: string } | undefined;

        if (cached) {
          if (opts.skipAlreadySeen && SKIP_SEEN_STATUSES.has(cached.status)) {
            logger.debug(
              { event: LogEvent.HIGH_BURN_SKIP_SEEN, block, status: cached.status },
              `High burn: skipping block ${block} (status=${cached.status})`
            );
            summary.skipped++;
            continue;
          }
          const seenAt = new Date(cached.seen_at).getTime();
          const ageHours = (Date.now() - seenAt) / 3_600_000;
          if (ageHours <= opts.cacheTtlHours) {
            logger.debug(
              { event: LogEvent.HIGH_BURN_CACHE_HIT, block, seenAt: cached.seen_at },
              `High burn: cache hit for block ${block}`
            );
            summary.cached++;
            continue;
          }
        }
      }
      blockNums.push(block);
    }

    if (blockNums.length === 0) continue;

    // Fetch all blocks in this micro-batch concurrently
    const results = await Promise.allSettled(
      blockNums.map(async (block) => {
        const blockData = await getBlock(block);
        return { block, blockData };
      })
    );

    for (const result of results) {
      if (result.status === "rejected") {
        summary.errors++;
        logger.warn(
          { event: LogEvent.RPC_ERROR, err: String(result.reason) },
          `High burn indexer: RPC error in concurrent batch`
        );
        continue;
      }

      const { block, blockData } = result.value;

      try {
        summary.scanned++;

        if (
          !blockData ||
          blockData.baseFeePerGas === null ||
          blockData.baseFeePerGas === undefined
        ) {
          summary.belowTier++;
          continue;
        }

        // --- Burn calculation ---
        const baseFee: bigint = blockData.baseFeePerGas;
        const gasUsed: bigint = blockData.gasUsed;
        const burnGwei = (baseFee * gasUsed) / BigInt(1_000_000_000);
        const burnEth = Number(burnGwei) / 1_000_000_000;

        // --- Tier assignment ---
        const tierEth = assignTier(burnEth, opts.tiers);
        if (tierEth === null || burnEth < minEth) {
          summary.belowTier++;
          continue;
        }

        // --- Capacity check ---
        const currentCount = countHighBurnCandidatesByTier(tierEth);
        if (currentCount >= opts.maxPerTier) {
          summary.skipped++;
          continue;
        }

        // --- Upsert ---
        upsertHighBurnCandidate({ block, burnGwei, burnEth, tierEth });
        summary.discovered++;

        logger.debug(
          {
            event: LogEvent.HIGH_BURN_CANDIDATE_DISCOVERED,
            block,
            burnGwei: burnGwei.toString(),
            burnEth,
            tierEth,
          },
          `High burn: discovered block ${block} (burnEth=${burnEth.toFixed(4)}, tier=${tierEth})`
        );
      } catch (err) {
        summary.errors++;
        logger.warn(
          { event: LogEvent.RPC_ERROR, block, err: String(err) },
          `High burn indexer: error processing block ${block}`
        );
      }
    }
  }

  return summary;
}

/**
 * Get the current chain head block number for use as default toBlock.
 * Re-exported from ethClient for convenience.
 */
export { getCurrentBlockNumber } from "./ethClient.js";

/**
 * Config defaults for indexBlockRange opts.
 */
export function defaultIndexOpts() {
  return {
    useCache: config.highBurnUseCache,
    cacheTtlHours: config.highBurnCacheTtlHours,
    skipAlreadySeen: config.highBurnSkipAlreadySeen,
    batchSize: config.highBurnBatchSize,
    maxPerTier: config.highBurnMaxCandidatesPerTier,
    tiers: config.highBurnMinEthTiers,
  };
}
