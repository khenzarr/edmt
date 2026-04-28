/**
 * BlockScanner — scans blocks sequentially and decides their mint status.
 *
 * Checkpoint advance rules:
 *   minted, not_eligible  → advance checkpoint block + 1
 *   beyond_current_head   → BEYOND_HEAD_BEHAVIOR (wait/skip/stop)
 *   unknown               → hold checkpoint, record error
 *   mintable              → return to caller for minting
 */

import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { getBlockStatus } from "./edmtClient.js";
import { advanceScannedBlock, getCheckpoint, recordCheckpointError } from "./checkpoint.js";
import { upsertBlockResult } from "./db.js";
import type { BlockResult, ScanBatchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the next block number to scan based on current checkpoint and direction.
 */
export function getNextCandidate(): number {
  const checkpoint = getCheckpoint("last_scanned_block");
  return checkpoint ?? config.startBlock;
}

/**
 * Decide the status of a single block, applying all eligibility rules.
 * This is the core decision function — all status transitions go through here.
 */
export async function decideBlock(blockNumber: number): Promise<BlockResult> {
  // Pre-flight: EIP-1559 check (no API call needed)
  if (blockNumber < 12965000) {
    const result: BlockResult = {
      block: blockNumber,
      status: "not_eligible",
      reason: "pre_eip1559",
      edmtStatusConfirmed: false,
    };
    upsertBlockResult({
      block: blockNumber,
      status: "not_eligible",
      reason: "pre_eip1559",
    });
    logger.info(
      { event: LogEvent.BLOCK_NOT_ELIGIBLE, block: blockNumber, reason: "pre_eip1559" },
      `Block ${blockNumber} not eligible: pre_eip1559`
    );
    return result;
  }

  // Query EDMT API (with RPC fallback)
  const result = await getBlockStatus(blockNumber);

  // Persist result to block_results table
  upsertBlockResult({
    block: blockNumber,
    status: result.status,
    burnGwei: result.burnGwei,
    feeRequired: result.feeRequired,
    requiredFeeGwei: result.requiredFeeGwei,
    owner: result.owner,
    mintTx: result.mintTx,
    reason: result.reason,
  });

  // Apply burn eligibility check (if we have burn data)
  if (
    result.status === "mintable" &&
    result.burnGwei !== undefined &&
    result.burnGwei < config.minBurnGwei
  ) {
    const overridden: BlockResult = {
      ...result,
      status: "not_eligible",
      reason: "burn_lt_1",
    };
    upsertBlockResult({
      block: blockNumber,
      status: "not_eligible",
      reason: "burn_lt_1",
      burnGwei: result.burnGwei,
    });
    logger.info(
      {
        event: LogEvent.BLOCK_NOT_ELIGIBLE,
        block: blockNumber,
        burnGwei: result.burnGwei.toString(),
        reason: "burn_lt_1",
      },
      `Block ${blockNumber} not eligible: burn_lt_1`
    );
    return overridden;
  }

  // Log the decision
  switch (result.status) {
    case "mintable":
      logger.info(
        {
          event: LogEvent.BLOCK_MINTABLE,
          block: blockNumber,
          burnGwei: result.burnGwei?.toString(),
          feeRequired: result.feeRequired,
          edmtStatusConfirmed: result.edmtStatusConfirmed,
        },
        `Block ${blockNumber} is mintable`
      );
      break;
    case "minted":
      logger.info(
        { event: LogEvent.BLOCK_MINTED, block: blockNumber, owner: result.owner },
        `Block ${blockNumber} already minted`
      );
      break;
    case "beyond_current_head":
      logger.info(
        { event: LogEvent.BLOCK_BEYOND_HEAD, block: blockNumber, reason: result.reason },
        `Block ${blockNumber} beyond current head`
      );
      break;
    case "not_eligible":
      logger.info(
        { event: LogEvent.BLOCK_NOT_ELIGIBLE, block: blockNumber, reason: result.reason },
        `Block ${blockNumber} not eligible: ${result.reason}`
      );
      break;
    case "unknown":
      logger.warn(
        { event: LogEvent.BLOCK_UNKNOWN, block: blockNumber, reason: result.reason },
        `Block ${blockNumber} status unknown: ${result.reason}`
      );
      break;
  }

  return result;
}

/**
 * Scan a batch of blocks up to MAX_BLOCKS_PER_RUN.
 * Returns when a mintable block is found, the batch limit is reached,
 * STOP_BLOCK is reached, or BEYOND_HEAD_BEHAVIOR=stop is triggered.
 */
export async function scanBatch(): Promise<{
  result: ScanBatchResult;
  mintableBlock?: BlockResult;
}> {
  const stats: ScanBatchResult = {
    processed: 0,
    mintable: 0,
    minted: 0,
    notEligible: 0,
    beyondHead: 0,
    unknown: 0,
    stopped: false,
  };

  let currentBlock = getNextCandidate();

  for (let i = 0; i < config.maxBlocksPerRun; i++) {
    // STOP_BLOCK check
    if (config.stopBlock !== undefined && currentBlock > config.stopBlock) {
      logger.info(
        { event: LogEvent.BOT_STOP, block: currentBlock, stopBlock: config.stopBlock },
        "Reached STOP_BLOCK — halting scan"
      );
      stats.stopped = true;
      break;
    }

    const blockResult = await decideBlock(currentBlock);
    stats.processed++;

    switch (blockResult.status) {
      case "mintable":
        stats.mintable++;
        return { result: stats, mintableBlock: blockResult };

      case "minted":
        stats.minted++;
        advanceScannedBlock(currentBlock, "minted");
        currentBlock = nextBlock(currentBlock);
        break;

      case "not_eligible":
        stats.notEligible++;
        advanceScannedBlock(currentBlock, "not_eligible");
        currentBlock = nextBlock(currentBlock);
        break;

      case "beyond_current_head":
        stats.beyondHead++;
        await handleBeyondHead(currentBlock);
        if (config.beyondHeadBehavior === "stop") {
          stats.stopped = true;
          return { result: stats };
        }
        if (config.beyondHeadBehavior === "skip") {
          advanceScannedBlock(currentBlock, "not_eligible"); // treat as skip
          currentBlock = nextBlock(currentBlock);
        }
        // "wait" — retry same block (don't advance currentBlock)
        break;

      case "unknown":
        stats.unknown++;
        recordCheckpointError(
          currentBlock,
          "blockScanner:unknown",
          blockResult.reason ?? "Unknown block status from EDMT API"
        );
        // Do NOT advance — retry on next run
        return { result: stats };
    }
  }

  return { result: stats };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nextBlock(current: number): number {
  return config.scanDirection === "descending" ? current - 1 : current + 1;
}

async function handleBeyondHead(blockNumber: number): Promise<void> {
  switch (config.beyondHeadBehavior) {
    case "wait":
      logger.info(
        {
          event: LogEvent.BLOCK_BEYOND_HEAD,
          block: blockNumber,
          waitMs: config.pollIntervalMs,
          behavior: "wait",
        },
        `Block ${blockNumber} beyond head — waiting ${config.pollIntervalMs}ms`
      );
      await sleep(config.pollIntervalMs);
      break;
    case "skip":
      logger.info(
        { event: LogEvent.BLOCK_BEYOND_HEAD, block: blockNumber, behavior: "skip" },
        `Block ${blockNumber} beyond head — skipping`
      );
      break;
    case "stop":
      logger.info(
        { event: LogEvent.BLOCK_BEYOND_HEAD, block: blockNumber, behavior: "stop" },
        `Block ${blockNumber} beyond head — stopping bot`
      );
      break;
  }
}
