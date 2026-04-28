/**
 * Checkpoint manager.
 * All progress is persisted to SQLite immediately after each definitive decision.
 * In-memory state is NEVER considered sufficient — every advance writes to DB.
 *
 * Checkpoint advance rules:
 *   minted, not_eligible, successful_mint  → advance block + 1
 *   beyond_current_head                    → do NOT advance (retry same block)
 *   unknown / error                        → do NOT advance (write to errors table)
 */

import { config } from "./config.js";
import { getCheckpointRaw, setCheckpointRaw, recordError } from "./db.js";
import { logger, LogEvent } from "./logger.js";
import type { BlockStatus, CheckpointKey } from "./types.js";

// ---------------------------------------------------------------------------
// Definitive statuses that allow checkpoint to advance
// ---------------------------------------------------------------------------

const ADVANCE_STATUSES: ReadonlySet<BlockStatus> = new Set(["minted", "not_eligible"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise checkpoint on bot startup.
 * If last_scanned_block already exists in DB, it is preserved.
 * Otherwise it is seeded with START_BLOCK from config.
 */
export function initCheckpoint(): number {
  const existing = getCheckpointRaw("last_scanned_block");
  if (existing !== undefined) {
    const block = parseInt(existing, 10);
    logger.info(
      { event: LogEvent.CHECKPOINT_HELD, key: "last_scanned_block", block },
      "Resuming from existing checkpoint"
    );
    return block;
  }

  const startBlock = config.startBlock;
  setCheckpointRaw("last_scanned_block", String(startBlock));
  logger.info(
    { event: LogEvent.CHECKPOINT_ADVANCED, key: "last_scanned_block", block: startBlock },
    "Checkpoint initialised with START_BLOCK"
  );
  return startBlock;
}

/**
 * Read a checkpoint value. Returns undefined if not set.
 */
export function getCheckpoint(key: CheckpointKey): number | undefined {
  const raw = getCheckpointRaw(key);
  if (raw === undefined) return undefined;
  const val = parseInt(raw, 10);
  return isNaN(val) ? undefined : val;
}

/**
 * Write a checkpoint value directly.
 */
export function setCheckpoint(key: CheckpointKey, block: number): void {
  setCheckpointRaw(key, String(block));
  logger.debug({ event: LogEvent.CHECKPOINT_ADVANCED, key, block }, "Checkpoint updated");
}

/**
 * Advance last_scanned_block to block + 1 if the status is definitive.
 * For "successful_mint" (post-finality), also advances.
 * For "submitted" (pipeline mode — tx sent, scan can continue), also advances.
 * For "beyond_current_head" and "unknown", does NOT advance.
 */
export function advanceScannedBlock(
  block: number,
  status: BlockStatus | "successful_mint" | "submitted"
): void {
  if (
    status === "successful_mint" ||
    status === "submitted" ||
    ADVANCE_STATUSES.has(status as BlockStatus)
  ) {
    const next = block + 1;
    setCheckpointRaw("last_scanned_block", String(next));
    logger.info(
      {
        event: LogEvent.CHECKPOINT_ADVANCED,
        key: "last_scanned_block",
        block: next,
        reason: status,
      },
      `Checkpoint advanced to ${next} after ${status}`
    );
    return;
  }

  // beyond_current_head or unknown — hold checkpoint
  logger.debug(
    { event: LogEvent.CHECKPOINT_HELD, key: "last_scanned_block", block, reason: status },
    `Checkpoint held at ${block} due to ${status}`
  );
}

/**
 * Record that a mint tx was successfully submitted.
 */
export function setSubmittedBlock(block: number): void {
  setCheckpointRaw("last_submitted_block", String(block));
  logger.info(
    { event: LogEvent.CHECKPOINT_ADVANCED, key: "last_submitted_block", block },
    `last_submitted_block set to ${block}`
  );
}

/**
 * Record that a mint tx reached finality and was confirmed by EDMT indexer.
 * Also advances last_scanned_block to block + 1.
 */
export function setSuccessfulMintBlock(block: number): void {
  setCheckpointRaw("last_successful_mint_block", String(block));
  logger.info(
    { event: LogEvent.CHECKPOINT_ADVANCED, key: "last_successful_mint_block", block },
    `last_successful_mint_block set to ${block}`
  );
  // Advance scanner past this block
  advanceScannedBlock(block, "successful_mint");
}

/**
 * Record the last finalised tx hash.
 */
export function setFinalizedTx(txHash: string): void {
  setCheckpointRaw("last_finalized_tx", txHash);
}

/**
 * Record a checkpoint error (unknown/API failure) without advancing.
 */
export function recordCheckpointError(
  block: number,
  stage: string,
  message: string,
  stack?: string
): void {
  recordError({ block, stage, message, stack });
  logger.warn(
    { event: LogEvent.CHECKPOINT_HELD, block, stage, message },
    "Checkpoint NOT advanced due to error"
  );
}
