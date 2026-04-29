/**
 * Review Required Reconciliation — reconciler.ts
 *
 * Resolves `review_required` tx records by performing multi-step evidence-based
 * verification. Only records that pass ALL checks are promoted to
 * `finalized` / `successful_mint`. Records that fail any check remain
 * `review_required` and continue to block automint.
 *
 * Safety rules (NEVER violated):
 *   - No private key required
 *   - No on-chain transactions sent
 *   - Dry-run is the default; --fix flag required for DB writes
 *   - Receipt.status=1 required before any promotion
 *   - EDMT owner must match our wallet address
 *   - EDMT mint_tx_hash must match our tx hash
 *   - Finality check enforced when RECONCILE_REQUIRE_FINALITY=true
 *   - last_successful_mint_block only updated if block > current value
 */

import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import {
  getReviewRequiredTxs,
  updateTxStatusWithReason,
  upsertBlockResult,
  getBlockResultByBlock,
  insertReconcileEvent,
  getCheckpointRaw,
  setCheckpointRaw,
  updateHighBurnCandidateStatus,
} from "./db.js";
import { getTransactionReceipt, getCurrentBlockNumber } from "./ethClient.js";
import { getBlockStatus } from "./edmtClient.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ReconcileDecision = {
  MARK_FINALIZED: "MARK_FINALIZED",
  MARK_FAILED: "MARK_FAILED",
  LEAVE_REVIEW_REQUIRED: "LEAVE_REVIEW_REQUIRED",
} as const;

export type ReconcileDecisionType = (typeof ReconcileDecision)[keyof typeof ReconcileDecision];

export interface ReconcileTxRow {
  id: number;
  block: number;
  tx_hash: string;
  status: string;
  reason: string | null;
  updated_at: string;
}

export interface ReconcileResult {
  tx: ReconcileTxRow;
  decision: ReconcileDecisionType;
  reason: string;
  dryRun: boolean;
}

export interface ReconcileReport {
  total: number;
  finalized: number;
  failed: number;
  leftReviewRequired: number;
  dryRun: boolean;
  results: ReconcileResult[];
}

export interface ReconcileOpts {
  /** If true, no DB writes are performed (default: true) */
  dryRun: boolean;
  /** If true, DB writes are applied */
  fix: boolean;
  /** Filter to a specific block number */
  blockFilter?: number;
  /** Filter to a specific tx hash */
  txFilter?: string;
  /** Override RECONCILE_REQUIRE_FINALITY config */
  requireFinality?: boolean;
  /** Override RECONCILE_MIN_CONFIRMATIONS config */
  minConfirmations?: number;
  /** Override current block number (for testing) */
  currentBlockNumber?: number;
}

// ---------------------------------------------------------------------------
// Core: resolveReviewRequired
// ---------------------------------------------------------------------------

/**
 * Resolve a single `review_required` tx record.
 *
 * Implements isBugCondition(X) check:
 *   1. Fetch receipt — missing → LEAVE_REVIEW_REQUIRED (receipt_missing)
 *   2. receipt.status !== 1 → LEAVE_REVIEW_REQUIRED (receipt_failed)
 *   3. Fetch EDMT block status
 *   4. edmtStatusConfirmed=false → LEAVE_REVIEW_REQUIRED (edmt_api_unavailable)
 *   5. minted_by !== walletAddress → LEAVE_REVIEW_REQUIRED (owner_mismatch)
 *   6. mint_tx_hash !== tx.tx_hash → LEAVE_REVIEW_REQUIRED (tx_hash_mismatch)
 *   7. RECONCILE_REQUIRE_FINALITY=true AND confirmations < min → LEAVE_REVIEW_REQUIRED (insufficient_confirmations)
 *   8. All checks pass → MARK_FINALIZED
 */
export async function resolveReviewRequired(
  tx: ReconcileTxRow,
  opts: ReconcileOpts
): Promise<ReconcileResult> {
  const requireFinality = opts.requireFinality ?? config.reconcileRequireFinality;
  const minConfirmations = opts.minConfirmations ?? config.reconcileMinConfirmations;

  logger.info(
    { event: LogEvent.RECONCILE_CANDIDATE_FOUND, block: tx.block, txHash: tx.tx_hash },
    `Reconciler: checking tx ${tx.tx_hash} (block ${tx.block})`
  );

  // -------------------------------------------------------------------------
  // Step 1: Fetch receipt
  // -------------------------------------------------------------------------
  let receipt: Awaited<ReturnType<typeof getTransactionReceipt>>;
  try {
    receipt = await getTransactionReceipt(tx.tx_hash);
  } catch (err) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_RECEIPT_MISSING,
        block: tx.block,
        txHash: tx.tx_hash,
        err: String(err),
      },
      `Reconciler: receipt fetch failed for ${tx.tx_hash}`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "receipt_missing",
      dryRun: opts.dryRun,
    };
  }

  if (!receipt) {
    logger.info(
      { event: LogEvent.RECONCILE_RECEIPT_MISSING, block: tx.block, txHash: tx.tx_hash },
      `Reconciler: no receipt for ${tx.tx_hash} — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "receipt_missing",
      dryRun: opts.dryRun,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Check receipt.status
  // -------------------------------------------------------------------------
  if (receipt.status !== 1) {
    logger.info(
      {
        event: LogEvent.RECONCILE_RECEIPT_FAILED,
        block: tx.block,
        txHash: tx.tx_hash,
        receiptStatus: receipt.status,
      },
      `Reconciler: receipt.status=${receipt.status} for ${tx.tx_hash} — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "receipt_failed",
      dryRun: opts.dryRun,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: Finality check (confirmations)
  // -------------------------------------------------------------------------
  if (requireFinality) {
    let currentBlock: number;
    try {
      currentBlock = opts.currentBlockNumber ?? (await getCurrentBlockNumber());
    } catch (err) {
      logger.warn(
        {
          event: LogEvent.RECONCILE_LEFT_REVIEW_REQUIRED,
          block: tx.block,
          txHash: tx.tx_hash,
          err: String(err),
        },
        `Reconciler: cannot get current block number — leaving review_required`
      );
      return {
        tx,
        decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
        reason: "rpc_unavailable",
        dryRun: opts.dryRun,
      };
    }

    const includedInBlock = receipt.blockNumber;
    const confirmations = currentBlock - includedInBlock;

    if (confirmations < minConfirmations) {
      logger.info(
        {
          event: LogEvent.RECONCILE_LEFT_REVIEW_REQUIRED,
          block: tx.block,
          txHash: tx.tx_hash,
          confirmations,
          required: minConfirmations,
        },
        `Reconciler: only ${confirmations}/${minConfirmations} confirmations — leaving review_required`
      );
      return {
        tx,
        decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
        reason: "insufficient_confirmations",
        dryRun: opts.dryRun,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: EDMT API verification
  // -------------------------------------------------------------------------
  let blockStatus: Awaited<ReturnType<typeof getBlockStatus>>;
  try {
    blockStatus = await getBlockStatus(tx.block);
  } catch (err) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_LEFT_REVIEW_REQUIRED,
        block: tx.block,
        txHash: tx.tx_hash,
        err: String(err),
      },
      `Reconciler: EDMT API call failed for block ${tx.block} — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "edmt_api_unavailable",
      dryRun: opts.dryRun,
    };
  }

  // EDMT API must confirm status
  if (!blockStatus.edmtStatusConfirmed) {
    logger.warn(
      { event: LogEvent.RECONCILE_LEFT_REVIEW_REQUIRED, block: tx.block, txHash: tx.tx_hash },
      `Reconciler: EDMT API unconfirmed for block ${tx.block} — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "edmt_api_unavailable",
      dryRun: opts.dryRun,
    };
  }

  // -------------------------------------------------------------------------
  // Step 5: Owner match
  // -------------------------------------------------------------------------
  const { getWallet } = await import("./ethClient.js");
  let walletAddress: string;
  try {
    walletAddress = getWallet().address;
  } catch {
    logger.warn(
      { event: LogEvent.RECONCILE_LEFT_REVIEW_REQUIRED, block: tx.block, txHash: tx.tx_hash },
      `Reconciler: wallet not available — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "wallet_unavailable",
      dryRun: opts.dryRun,
    };
  }

  const apiOwner = blockStatus.owner ?? "";
  if (!apiOwner || apiOwner.toLowerCase() !== walletAddress.toLowerCase()) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_OWNER_MISMATCH,
        block: tx.block,
        txHash: tx.tx_hash,
        expectedOwner: walletAddress,
        actualOwner: apiOwner,
      },
      `Reconciler: owner mismatch for block ${tx.block} — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "owner_mismatch",
      dryRun: opts.dryRun,
    };
  }

  // -------------------------------------------------------------------------
  // Step 6: TX hash match
  // -------------------------------------------------------------------------
  const apiMintTx = blockStatus.mintTx ?? "";
  if (!apiMintTx || apiMintTx.toLowerCase() !== tx.tx_hash.toLowerCase()) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_TX_HASH_MISMATCH,
        block: tx.block,
        txHash: tx.tx_hash,
        apiMintTx,
      },
      `Reconciler: tx hash mismatch for block ${tx.block} — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "tx_hash_mismatch",
      dryRun: opts.dryRun,
    };
  }

  // -------------------------------------------------------------------------
  // All checks passed — MARK_FINALIZED
  // -------------------------------------------------------------------------
  logger.info(
    {
      event: LogEvent.RECONCILE_EDMT_VERIFIED,
      block: tx.block,
      txHash: tx.tx_hash,
      owner: apiOwner,
    },
    `Reconciler: all checks passed for block ${tx.block} — MARK_FINALIZED`
  );

  return {
    tx,
    decision: ReconcileDecision.MARK_FINALIZED,
    reason: "all_checks_passed",
    dryRun: opts.dryRun,
  };
}

// ---------------------------------------------------------------------------
// Apply decision
// ---------------------------------------------------------------------------

/**
 * Apply a reconcile decision to the database.
 * In dry-run mode: logs only, no DB writes.
 * In fix mode: updates txs, block_results, checkpoints, and inserts reconcile_event.
 */
export function applyDecision(
  tx: ReconcileTxRow,
  decision: ReconcileDecisionType,
  reason: string,
  opts: ReconcileOpts
): void {
  const isWrite = !opts.dryRun && opts.fix;

  if (decision === ReconcileDecision.MARK_FINALIZED) {
    logger.info(
      {
        event: LogEvent.RECONCILE_FINALIZED,
        block: tx.block,
        txHash: tx.tx_hash,
        dryRun: opts.dryRun,
      },
      `Reconciler: ${opts.dryRun ? "[DRY-RUN] would mark" : "marking"} block ${tx.block} as finalized/successful_mint`
    );

    if (isWrite) {
      // Update txs.status → finalized
      updateTxStatusWithReason(tx.tx_hash, "finalized", reason);

      // Update block_results.status → successful_mint
      upsertBlockResult({ block: tx.block, status: "successful_mint", mintTx: tx.tx_hash });

      // Update last_successful_mint_block checkpoint (only if block > current value)
      const currentCheckpointRaw = getCheckpointRaw("last_successful_mint_block");
      const currentCheckpoint = currentCheckpointRaw ? parseInt(currentCheckpointRaw, 10) : -1;
      if (tx.block > currentCheckpoint) {
        setCheckpointRaw("last_successful_mint_block", String(tx.block));
        logger.info(
          {
            event: LogEvent.CHECKPOINT_ADVANCED,
            key: "last_successful_mint_block",
            block: tx.block,
          },
          `Reconciler: last_successful_mint_block updated to ${tx.block}`
        );
      }

      // Update high_burn_candidates if exists
      try {
        const blockResult = getBlockResultByBlock(tx.block);
        if (blockResult) {
          updateHighBurnCandidateStatus(tx.block, "finalized");
        }
      } catch {
        // high_burn_candidates update is best-effort
      }

      // Insert reconcile event for audit trail
      insertReconcileEvent({
        block: tx.block,
        txHash: tx.tx_hash,
        previousStatus: tx.status,
        newStatus: "finalized",
        decision,
        reason,
        dryRun: false,
      });
    } else {
      // Dry-run: insert event with dry_run=true for audit trail
      insertReconcileEvent({
        block: tx.block,
        txHash: tx.tx_hash,
        previousStatus: tx.status,
        newStatus: "finalized",
        decision,
        reason,
        dryRun: true,
      });
    }
  } else if (decision === ReconcileDecision.MARK_FAILED) {
    logger.info(
      {
        event: LogEvent.RECONCILE_LEFT_REVIEW_REQUIRED,
        block: tx.block,
        txHash: tx.tx_hash,
        reason,
        dryRun: opts.dryRun,
      },
      `Reconciler: ${opts.dryRun ? "[DRY-RUN] would mark" : "marking"} block ${tx.block} as failed`
    );

    if (isWrite) {
      updateTxStatusWithReason(tx.tx_hash, "failed", reason);
      upsertBlockResult({ block: tx.block, status: "failed", reason });
      insertReconcileEvent({
        block: tx.block,
        txHash: tx.tx_hash,
        previousStatus: tx.status,
        newStatus: "failed",
        decision,
        reason,
        dryRun: false,
      });
    }
  } else {
    // LEAVE_REVIEW_REQUIRED
    logger.info(
      {
        event: LogEvent.RECONCILE_LEFT_REVIEW_REQUIRED,
        block: tx.block,
        txHash: tx.tx_hash,
        reason,
        dryRun: opts.dryRun,
      },
      `Reconciler: leaving block ${tx.block} as review_required (reason: ${reason})`
    );

    // Always insert event for audit trail (even in dry-run)
    insertReconcileEvent({
      block: tx.block,
      txHash: tx.tx_hash,
      previousStatus: tx.status,
      newStatus: "review_required",
      decision,
      reason,
      dryRun: opts.dryRun,
    });
  }
}

// ---------------------------------------------------------------------------
// reconcileAll
// ---------------------------------------------------------------------------

/**
 * Process all `review_required` tx records.
 * Optionally filter by block or tx hash.
 * Returns a report of all decisions made.
 */
export async function reconcileAll(opts: ReconcileOpts): Promise<ReconcileReport> {
  logger.info(
    { event: LogEvent.RECONCILE_STARTED, dryRun: opts.dryRun, fix: opts.fix },
    `Reconciler: starting reconcileAll (dryRun=${opts.dryRun}, fix=${opts.fix})`
  );

  let txs = getReviewRequiredTxs();

  // Apply filters
  if (opts.blockFilter !== undefined) {
    txs = txs.filter((tx) => tx.block === opts.blockFilter);
  }
  if (opts.txFilter !== undefined) {
    txs = txs.filter((tx) => tx.tx_hash.toLowerCase() === opts.txFilter!.toLowerCase());
  }

  const report: ReconcileReport = {
    total: txs.length,
    finalized: 0,
    failed: 0,
    leftReviewRequired: 0,
    dryRun: opts.dryRun,
    results: [],
  };

  if (txs.length === 0) {
    logger.info(
      { event: LogEvent.RECONCILE_FINISHED, total: 0 },
      "Reconciler: no review_required records found"
    );
    return report;
  }

  logger.info(
    { event: LogEvent.RECONCILE_STARTED, total: txs.length },
    `Reconciler: processing ${txs.length} review_required record(s)`
  );

  for (const tx of txs) {
    const result = await resolveReviewRequired(tx, opts);
    applyDecision(tx, result.decision, result.reason, opts);

    report.results.push(result);

    if (result.decision === ReconcileDecision.MARK_FINALIZED) {
      report.finalized++;
    } else if (result.decision === ReconcileDecision.MARK_FAILED) {
      report.failed++;
    } else {
      report.leftReviewRequired++;
    }
  }

  logger.info(
    {
      event: LogEvent.RECONCILE_FINISHED,
      total: report.total,
      finalized: report.finalized,
      failed: report.failed,
      leftReviewRequired: report.leftReviewRequired,
      dryRun: opts.dryRun,
    },
    `Reconciler: finished — ${report.finalized} finalized, ${report.failed} failed, ${report.leftReviewRequired} left review_required`
  );

  return report;
}
