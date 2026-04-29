/**
 * Rate-limit-aware historical high-burn RPC scanner.
 *
 * This is the fallback path when EDMT's pending API is not enough. It scans
 * Ethereum blocks in resumable chunks, computes burn, and stores candidates in
 * high_burn_candidates.
 *
 * CLI:
 *   npm run highburn:scan-resume -- --from 12965000 --to 24986812 --min-eth 1
 *   npm run highburn:scan-resume -- --min-eth 0.05 --chunk-size 5000 --concurrency 1
 */

import { config } from "../src/config.js";
import {
  getDb,
  getCheckpointRaw,
  recordError,
  setCheckpointRaw,
  upsertHighBurnCandidate,
} from "../src/db.js";
import { getBlock, getCurrentBlockNumber } from "../src/ethClient.js";
import { assignTier } from "../src/highBurnIndexer.js";

const CHECKPOINT_KEY = "highburn_rpc_scan_next_block";
const LAST_TO_BLOCK_KEY = "highburn_rpc_scan_to_block";
const LAST_MIN_ETH_KEY = "highburn_rpc_scan_min_eth";

interface ScanOpts {
  from?: number;
  to?: number;
  minEth: number;
  chunkSize: number;
  concurrency: number;
  requestDelayMs: number;
  rateLimitCooldownMs: number;
  maxRetries: number;
  maxBlocks: number;
  reset: boolean;
  dryRun: boolean;
  checkpointKey: string;
}

interface ScanReport {
  mode: "highburn_scan_resume";
  dryRun: boolean;
  from: number;
  to: number;
  minEth: number;
  scanned: number;
  discovered: number;
  belowMin: number;
  missing: number;
  errors: number;
  rateLimitSleeps: number;
  nextBlock: number;
  stoppedReason: string;
}

function parseArgs(): ScanOpts {
  const args = process.argv.slice(2);
  const opts: ScanOpts = {
    minEth: 1,
    chunkSize: config.highBurnRpcScanChunkSize,
    concurrency: config.highBurnRpcScanConcurrency,
    requestDelayMs: config.highBurnRpcScanRequestDelayMs,
    rateLimitCooldownMs: config.highBurnRpcScanRateLimitCooldownMs,
    maxRetries: config.highBurnRpcScanMaxRetries,
    maxBlocks: 0,
    reset: false,
    dryRun: false,
    checkpointKey: CHECKPOINT_KEY,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--from" && next) opts.from = parseInt(args[++i], 10);
    else if (arg === "--to" && next) opts.to = parseInt(args[++i], 10);
    else if (arg === "--min-eth" && next) opts.minEth = parseFloat(args[++i]);
    else if (arg === "--chunk-size" && next) opts.chunkSize = parseInt(args[++i], 10);
    else if (arg === "--concurrency" && next) opts.concurrency = parseInt(args[++i], 10);
    else if (arg === "--delay-ms" && next) opts.requestDelayMs = parseInt(args[++i], 10);
    else if (arg === "--rate-limit-cooldown-ms" && next) {
      opts.rateLimitCooldownMs = parseInt(args[++i], 10);
    } else if (arg === "--max-retries" && next) opts.maxRetries = parseInt(args[++i], 10);
    else if (arg === "--max-blocks" && next) opts.maxBlocks = parseInt(args[++i], 10);
    else if (arg === "--checkpoint-key" && next) opts.checkpointKey = args[++i];
    else if (arg === "--reset") opts.reset = true;
    else if (arg === "--dry-run") opts.dryRun = true;
  }

  if (!Number.isFinite(opts.minEth) || opts.minEth < 0) {
    throw new Error("--min-eth must be a non-negative number");
  }
  if (!Number.isInteger(opts.chunkSize) || opts.chunkSize <= 0) {
    throw new Error("--chunk-size must be a positive integer");
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer");
  }
  return opts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  return /429|rate|too many|limit|quota/i.test(String(err));
}

function burnGweiToEth(burnGwei: bigint): number {
  return Number(burnGwei) / 1_000_000_000;
}

function tierForBurn(burnEth: number, minEth: number): number {
  return assignTier(burnEth, config.highBurnMinEthTiers) ?? minEth;
}

async function fetchBlockWithRetry(
  blockNumber: number,
  opts: ScanOpts,
  report: ScanReport
): Promise<Awaited<ReturnType<typeof getBlock>>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    if (opts.requestDelayMs > 0) await sleep(opts.requestDelayMs);

    try {
      return await getBlock(blockNumber);
    } catch (err) {
      lastError = err;
      const rateLimited = isRateLimitError(err);
      const waitMs = rateLimited
        ? opts.rateLimitCooldownMs
        : Math.min(1000 * 2 ** (attempt - 1), 30_000);
      if (rateLimited) report.rateLimitSleeps++;
      console.warn(
        `block ${blockNumber}: RPC error attempt ${attempt}/${opts.maxRetries}; retrying in ${waitMs}ms (${String(err)})`
      );
      await sleep(waitMs);
    }
  }

  recordError({
    block: blockNumber,
    stage: "highburn-scan-resume:getBlock",
    message: `getBlock failed after ${opts.maxRetries} retries: ${String(lastError)}`,
  });
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function scanOneBlock(blockNumber: number, opts: ScanOpts, report: ScanReport) {
  const block = await fetchBlockWithRetry(blockNumber, opts, report);
  report.scanned++;

  if (!block || block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
    report.missing++;
    return;
  }

  const burnGwei = (block.baseFeePerGas * block.gasUsed) / BigInt(1_000_000_000);
  const burnEth = burnGweiToEth(burnGwei);

  if (burnEth < opts.minEth) {
    report.belowMin++;
    return;
  }

  report.discovered++;
  if (!opts.dryRun) {
    upsertHighBurnCandidate({
      block: blockNumber,
      burnGwei,
      burnEth,
      tierEth: tierForBurn(burnEth, opts.minEth),
    });
  }
}

async function resolveStartBlock(opts: ScanOpts): Promise<number> {
  if (opts.from !== undefined) return Math.max(opts.from, 12965000);
  if (!opts.reset) {
    const raw = getCheckpointRaw(opts.checkpointKey);
    if (raw !== undefined) {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed)) return Math.max(parsed, 12965000);
    }
  }
  return Math.max(config.highBurnScanStartBlock, 12965000);
}

async function resolveEndBlock(opts: ScanOpts): Promise<number> {
  if (opts.to !== undefined) return opts.to;
  if (config.highBurnScanEndBlock !== undefined) return config.highBurnScanEndBlock;
  return await getCurrentBlockNumber();
}

async function main(): Promise<void> {
  const opts = parseArgs();
  getDb();

  const from = await resolveStartBlock(opts);
  const to = await resolveEndBlock(opts);
  const effectiveTo =
    opts.maxBlocks > 0 ? Math.min(to, from + opts.maxBlocks - 1) : Math.max(to, from);

  const report: ScanReport = {
    mode: "highburn_scan_resume",
    dryRun: opts.dryRun,
    from,
    to: effectiveTo,
    minEth: opts.minEth,
    scanned: 0,
    discovered: 0,
    belowMin: 0,
    missing: 0,
    errors: 0,
    rateLimitSleeps: 0,
    nextBlock: from,
    stoppedReason: "",
  };

  console.log(`\n=== High Burn RPC Scan [${opts.dryRun ? "DRY-RUN" : "WRITE"}] ===`);
  console.log(
    `  range=${from}-${effectiveTo} minEth=${opts.minEth} chunkSize=${opts.chunkSize} concurrency=${opts.concurrency}`
  );

  for (let chunkStart = from; chunkStart <= effectiveTo; chunkStart += opts.chunkSize) {
    const chunkEnd = Math.min(chunkStart + opts.chunkSize - 1, effectiveTo);
    console.log(`\nScanning chunk ${chunkStart}-${chunkEnd}`);

    for (let batchStart = chunkStart; batchStart <= chunkEnd; batchStart += opts.concurrency) {
      const batchEnd = Math.min(batchStart + opts.concurrency - 1, chunkEnd);
      const blocks: number[] = [];
      for (let block = batchStart; block <= batchEnd; block++) blocks.push(block);

      const results = await Promise.allSettled(
        blocks.map((block) => scanOneBlock(block, opts, report))
      );

      for (const result of results) {
        if (result.status === "rejected") {
          report.errors++;
          console.warn(`scan batch error: ${String(result.reason)}`);
        }
      }

      report.nextBlock = batchEnd + 1;
      if (!opts.dryRun) setCheckpointRaw(opts.checkpointKey, String(report.nextBlock));
    }

    if (!opts.dryRun) {
      setCheckpointRaw(LAST_TO_BLOCK_KEY, String(effectiveTo));
      setCheckpointRaw(LAST_MIN_ETH_KEY, String(opts.minEth));
    }

    console.log(
      `chunk done: scanned=${report.scanned} discovered=${report.discovered} errors=${report.errors} next=${report.nextBlock}`
    );
  }

  report.stoppedReason = report.nextBlock > effectiveTo ? "completed" : "stopped";
  console.log("\n=== Scan Report ===");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(`Fatal error: ${String(err)}`);
  process.exit(1);
});
