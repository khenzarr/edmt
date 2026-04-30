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
  markTxDropped,
  markBlockRetryable,
} from "./db.js";
import {
  getTransactionReceipt,
  getCurrentBlockNumber,
  getTransaction,
  getLatestNonce,
} from "./ethClient.js";
import { getBlockStatus } from "./edmtClient.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ReconcileDecision = {
  MARK_FINALIZED: "MARK_FINALIZED",
  MARK_FAILED: "MARK_FAILED",
  LEAVE_REVIEW_REQUIRED: "LEAVE_REVIEW_REQUIRED",
  MARK_DROPPED_RETRYABLE: "MARK_DROPPED_RETRYABLE",
  MARK_DROPPED_MINTED: "MARK_DROPPED_MINTED",
} as const;

export type ReconcileDecisionType = (typeof ReconcileDecision)[keyof typeof ReconcileDecision];

export interface ReconcileTxRow {
  id: number;
  block: number;
  tx_hash: string;
  status: string;
  reason: string | null;
  updated_at: string;
  nonce: number;
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
  dropped: number;
  retryable: number;
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
  /** If true, attempt dropped/replaced tx resolution for receipt_missing records */
  fixDropped?: boolean;
  /**
   * If true, attempt force-drop resolution for receipt_missing records where
   * nonce has NOT advanced (latestNonce === txNonce). Requires explicit --force-drop
   * CLI flag. Only applies when combined with a --tx or --block filter.
   * Safety: all 11 eligibility checks must pass before any DB write.
   */
  forceDrop?: boolean;
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
// Dropped TX Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dropped/replaced tx record.
 *
 * Multi-step evidence-based check:
 *   1. getTransactionReceipt — not null → not dropped, leave for normal reconcile
 *   2. getTransaction — not null → tx still pending, LEAVE_REVIEW_REQUIRED (tx_still_pending)
 *   3. getLatestNonce — latestNonce <= txNonce → nonce not advanced, LEAVE_REVIEW_REQUIRED (nonce_not_advanced)
 *   4. All checks passed → tx confirmed dropped
 *   5. getBlockStatus (EDMT API)
 *   6. EDMT status mintable → MARK_DROPPED_RETRYABLE
 *   7. EDMT status minted → MARK_DROPPED_MINTED
 *   8. EDMT status unknown / API unavailable → LEAVE_REVIEW_REQUIRED (edmt_api_unavailable)
 */
export async function resolveDroppedTx(
  tx: {
    id: number;
    block: number;
    tx_hash: string;
    status: string;
    reason: string | null;
    nonce: number;
    updated_at: string;
  },
  opts: ReconcileOpts
): Promise<ReconcileResult> {
  // Step 1: Check receipt again (safety — should be null, but verify)
  const receipt = await getTransactionReceipt(tx.tx_hash);
  if (receipt !== null) {
    // Receipt appeared — not dropped, leave for normal reconcile
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "receipt_appeared",
      dryRun: opts.dryRun,
    };
  }

  // Step 2: Check if tx is still known to the node (pending/mempool)
  const txOnChain = await getTransaction(tx.tx_hash);
  if (txOnChain !== null) {
    logger.info(
      { event: LogEvent.RECONCILE_TX_STILL_PENDING, txHash: tx.tx_hash, block: tx.block },
      `Reconciler: tx ${tx.tx_hash} still known to node — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "tx_still_pending",
      dryRun: opts.dryRun,
    };
  }

  // Step 3: Check if wallet nonce has advanced past this tx's nonce
  const { getWallet } = await import("./ethClient.js");
  let walletAddress: string;
  try {
    walletAddress = getWallet().address;
  } catch {
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "wallet_unavailable",
      dryRun: opts.dryRun,
    };
  }

  const latestNonce = await getLatestNonce(walletAddress);
  if (latestNonce <= tx.nonce) {
    logger.info(
      {
        event: LogEvent.RECONCILE_NONCE_NOT_ADVANCED,
        txHash: tx.tx_hash,
        block: tx.block,
        latestNonce,
        txNonce: tx.nonce,
      },
      `Reconciler: latestNonce(${latestNonce}) <= txNonce(${tx.nonce}) — cannot confirm dropped`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "nonce_not_advanced",
      dryRun: opts.dryRun,
    };
  }

  // Dropped confirmed: receipt=null, tx not found, latestNonce > txNonce
  logger.info(
    {
      event: LogEvent.RECONCILE_DROPPED_DETECTED,
      txHash: tx.tx_hash,
      block: tx.block,
      latestNonce,
      txNonce: tx.nonce,
    },
    `Reconciler: tx ${tx.tx_hash} confirmed dropped (latestNonce=${latestNonce} > txNonce=${tx.nonce})`
  );

  // Step 4: Check EDMT API for block status
  let blockStatus: Awaited<ReturnType<typeof getBlockStatus>>;
  try {
    blockStatus = await getBlockStatus(tx.block);
  } catch (err) {
    logger.warn(
      { event: LogEvent.RPC_ERROR, txHash: tx.tx_hash, block: tx.block, err: String(err) },
      `Reconciler: EDMT API failed for block ${tx.block} — leaving review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "edmt_api_unavailable",
      dryRun: opts.dryRun,
    };
  }

  if (!blockStatus.edmtStatusConfirmed) {
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "edmt_api_unavailable",
      dryRun: opts.dryRun,
    };
  }

  if (blockStatus.status === "mintable") {
    logger.info(
      { event: LogEvent.RECONCILE_DROPPED_RETRYABLE, txHash: tx.tx_hash, block: tx.block },
      `Reconciler: dropped tx block ${tx.block} still mintable — marking retryable`
    );
    return {
      tx,
      decision: ReconcileDecision.MARK_DROPPED_RETRYABLE,
      reason: "dropped_block_retryable",
      dryRun: opts.dryRun,
    };
  }

  if (blockStatus.status === "minted") {
    logger.info(
      {
        event: LogEvent.RECONCILE_DROPPED_MINTED,
        txHash: tx.tx_hash,
        block: tx.block,
        owner: blockStatus.owner,
      },
      `Reconciler: dropped tx block ${tx.block} minted by ${blockStatus.owner ?? "unknown"} — marking minted`
    );
    return {
      tx,
      decision: ReconcileDecision.MARK_DROPPED_MINTED,
      reason: "dropped_block_minted_elsewhere",
      dryRun: opts.dryRun,
    };
  }

  // Unknown/other EDMT status — safer to leave as review_required
  return {
    tx,
    decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
    reason: "edmt_status_unknown",
    dryRun: opts.dryRun,
  };
}

// ---------------------------------------------------------------------------
// Force Drop Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a tx that is stuck in review_required with receipt_missing, where
 * the nonce has NOT advanced (latestNonce === txNonce). This is the "nonce
 * stalled" edge case that resolveDroppedTx cannot handle automatically.
 *
 * Safety: ALL of the following must be true before any decision is made:
 *   1. txs.status = review_required
 *   2. getTransaction(txHash) = null  (tx not found on node)
 *   3. getTransactionReceipt(txHash) = null  (no receipt)
 *   4. latestNonce >= txNonce  (nonce at or past this tx — safe to drop)
 *   5. pendingNonce === latestNonce  (no pending txs in mempool for this nonce)
 *   6. EDMT API block status = mintable  (block still available)
 *   7. minted_by = null  (block not minted by anyone)
 *   8. mint_tx_hash = null  (no mint tx recorded)
 *   9. No other submitted/included/finalized tx for the same block
 *  10. No other active tx (pending/included/submitted) for the same nonce
 *  11. forceDrop flag explicitly set in opts
 *
 * Returns MARK_DROPPED_RETRYABLE if all checks pass.
 * Returns LEAVE_REVIEW_REQUIRED with a specific rejection reason otherwise.
 */
export async function resolveForceDropTx(
  tx: ReconcileTxRow,
  opts: ReconcileOpts
): Promise<ReconcileResult> {
  const txHash = tx.tx_hash;
  const block = tx.block;
  const txNonce = tx.nonce;

  logger.info(
    {
      event: LogEvent.RECONCILE_FORCE_DROP_REQUESTED,
      block,
      txHash,
      txNonce,
    },
    `Reconciler: force-drop requested for tx ${txHash} (block ${block}, nonce ${txNonce})`
  );

  // Check 11: forceDrop flag must be explicitly set
  if (!opts.forceDrop) {
    logger.warn(
      { event: LogEvent.RECONCILE_FORCE_DROP_REJECTED, block, txHash, reason: "flag_not_set" },
      `Reconciler: force-drop rejected — forceDrop flag not set`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_flag_not_set",
      dryRun: opts.dryRun,
    };
  }

  // Check 1: tx must be review_required (caller guarantees this, but verify)
  if (tx.status !== "review_required") {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        reason: "not_review_required",
        status: tx.status,
      },
      `Reconciler: force-drop rejected — tx status is ${tx.status}, not review_required`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_not_review_required",
      dryRun: opts.dryRun,
    };
  }

  // Check 3: getTransactionReceipt must be null
  let receipt: Awaited<ReturnType<typeof getTransactionReceipt>>;
  try {
    receipt = await getTransactionReceipt(txHash);
  } catch (err) {
    logger.warn(
      { event: LogEvent.RECONCILE_FORCE_DROP_REJECTED, block, txHash, err: String(err) },
      `Reconciler: force-drop rejected — receipt fetch failed`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_receipt_fetch_failed",
      dryRun: opts.dryRun,
    };
  }

  if (receipt !== null) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        reason: "receipt_found",
      },
      `Reconciler: force-drop rejected — receipt found (tx is not dropped)`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_receipt_found",
      dryRun: opts.dryRun,
    };
  }

  // Check 2: getTransaction must be null (tx not in mempool)
  let txOnChain: Awaited<ReturnType<typeof getTransaction>>;
  try {
    txOnChain = await getTransaction(txHash);
  } catch (err) {
    logger.warn(
      { event: LogEvent.RECONCILE_FORCE_DROP_REJECTED, block, txHash, err: String(err) },
      `Reconciler: force-drop rejected — getTransaction failed`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_get_tx_failed",
      dryRun: opts.dryRun,
    };
  }

  if (txOnChain !== null) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        reason: "tx_still_pending",
      },
      `Reconciler: force-drop rejected — tx still known to node (pending)`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_tx_still_pending",
      dryRun: opts.dryRun,
    };
  }

  // Checks 4 & 5: latestNonce and pendingNonce
  const { getWallet } = await import("./ethClient.js");
  let walletAddress: string;
  try {
    walletAddress = getWallet().address;
  } catch {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        reason: "wallet_unavailable",
      },
      `Reconciler: force-drop rejected — wallet not available`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_wallet_unavailable",
      dryRun: opts.dryRun,
    };
  }

  let latestNonce: number;
  let pendingNonce: number;
  try {
    const { getPendingNonce } = await import("./ethClient.js");
    [latestNonce, pendingNonce] = await Promise.all([
      getLatestNonce(walletAddress),
      getPendingNonce(walletAddress),
    ]);
  } catch (err) {
    logger.warn(
      { event: LogEvent.RECONCILE_FORCE_DROP_REJECTED, block, txHash, err: String(err) },
      `Reconciler: force-drop rejected — nonce fetch failed`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_nonce_fetch_failed",
      dryRun: opts.dryRun,
    };
  }

  // Check 4: latestNonce must be >= txNonce (nonce at or past this tx)
  if (latestNonce < txNonce) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        latestNonce,
        txNonce,
        reason: "nonce_behind_tx",
      },
      `Reconciler: force-drop rejected — latestNonce(${latestNonce}) < txNonce(${txNonce})`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_nonce_behind_tx",
      dryRun: opts.dryRun,
    };
  }

  // Check 5: pendingNonce must equal latestNonce (no pending txs in mempool)
  if (pendingNonce !== latestNonce) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        latestNonce,
        pendingNonce,
        reason: "pending_nonce_mismatch",
      },
      `Reconciler: force-drop rejected — pendingNonce(${pendingNonce}) !== latestNonce(${latestNonce}) — mempool not clear`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_pending_nonce_mismatch",
      dryRun: opts.dryRun,
    };
  }

  // Checks 9 & 10: DB safety checks — no conflicting active txs
  const { findTxsByBlock, findTxsByNonce } = await import("./db.js");

  // Check 9: no other submitted/included/finalized tx for the same block
  const blockTxs = findTxsByBlock(block);
  const activeBlockTxs = blockTxs.filter(
    (t) =>
      t.tx_hash.toLowerCase() !== txHash.toLowerCase() &&
      ["submitted", "included", "finalized", "pending"].includes(t.status)
  );
  if (activeBlockTxs.length > 0) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        reason: "active_tx_for_block",
        conflictingTxs: activeBlockTxs.map((t) => t.tx_hash),
      },
      `Reconciler: force-drop rejected — block ${block} has other active txs`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_active_tx_for_block",
      dryRun: opts.dryRun,
    };
  }

  // Check 10: no other active tx for the same nonce
  const nonceTxs = findTxsByNonce(txNonce);
  const activeNonceTxs = nonceTxs.filter(
    (t) =>
      t.tx_hash.toLowerCase() !== txHash.toLowerCase() &&
      ["submitted", "included", "finalized", "pending"].includes(t.status)
  );
  if (activeNonceTxs.length > 0) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        txNonce,
        reason: "active_tx_for_nonce",
        conflictingTxs: activeNonceTxs.map((t) => t.tx_hash),
      },
      `Reconciler: force-drop rejected — nonce ${txNonce} has other active txs`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_active_tx_for_nonce",
      dryRun: opts.dryRun,
    };
  }

  // Checks 6, 7, 8: EDMT API verification
  let blockStatus: Awaited<ReturnType<typeof getBlockStatus>>;
  try {
    blockStatus = await getBlockStatus(block);
  } catch (err) {
    logger.warn(
      { event: LogEvent.RECONCILE_FORCE_DROP_REJECTED, block, txHash, err: String(err) },
      `Reconciler: force-drop rejected — EDMT API call failed for block ${block}`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_edmt_api_unavailable",
      dryRun: opts.dryRun,
    };
  }

  if (!blockStatus.edmtStatusConfirmed) {
    logger.warn(
      { event: LogEvent.RECONCILE_FORCE_DROP_REJECTED, block, txHash, reason: "edmt_unconfirmed" },
      `Reconciler: force-drop rejected — EDMT API unconfirmed for block ${block}`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_edmt_unconfirmed",
      dryRun: opts.dryRun,
    };
  }

  // Check 6: block must be mintable
  if (blockStatus.status !== "mintable") {
    // Special case: if block is minted by someone else, mark as minted_elsewhere
    if (blockStatus.status === "minted") {
      const apiOwner = blockStatus.owner ?? "";
      const apiMintTx = blockStatus.mintTx ?? "";

      // Check 7 & 8: minted_by and mint_tx_hash must be null for retryable
      // If minted by someone else → MARK_DROPPED_MINTED
      logger.warn(
        {
          event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
          block,
          txHash,
          reason: "block_minted_elsewhere",
          owner: apiOwner,
          mintTx: apiMintTx,
        },
        `Reconciler: force-drop — block ${block} already minted by ${apiOwner || "unknown"} — marking dropped/minted`
      );
      return {
        tx,
        decision: ReconcileDecision.MARK_DROPPED_MINTED,
        reason: "force_drop_block_minted_elsewhere",
        dryRun: opts.dryRun,
      };
    }

    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        reason: "block_not_mintable",
        blockStatus: blockStatus.status,
      },
      `Reconciler: force-drop rejected — block ${block} status is ${blockStatus.status}, not mintable`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_block_not_mintable",
      dryRun: opts.dryRun,
    };
  }

  // Check 7: minted_by must be null
  if (blockStatus.owner !== null && blockStatus.owner !== undefined && blockStatus.owner !== "") {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        reason: "minted_by_not_null",
        owner: blockStatus.owner,
      },
      `Reconciler: force-drop rejected — block ${block} has owner ${blockStatus.owner}`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_minted_by_not_null",
      dryRun: opts.dryRun,
    };
  }

  // Check 8: mint_tx_hash must be null
  if (
    blockStatus.mintTx !== null &&
    blockStatus.mintTx !== undefined &&
    blockStatus.mintTx !== ""
  ) {
    logger.warn(
      {
        event: LogEvent.RECONCILE_FORCE_DROP_REJECTED,
        block,
        txHash,
        reason: "mint_tx_not_null",
        mintTx: blockStatus.mintTx,
      },
      `Reconciler: force-drop rejected — block ${block} has mint_tx ${blockStatus.mintTx}`
    );
    return {
      tx,
      decision: ReconcileDecision.LEAVE_REVIEW_REQUIRED,
      reason: "force_drop_mint_tx_not_null",
      dryRun: opts.dryRun,
    };
  }

  // All 11 checks passed — eligible for force-drop
  logger.info(
    {
      event: LogEvent.RECONCILE_FORCE_DROP_ELIGIBLE,
      block,
      txHash,
      txNonce,
      latestNonce,
      pendingNonce,
    },
    `Reconciler: force-drop ELIGIBLE for tx ${txHash} (block ${block}, nonce ${txNonce}, latestNonce=${latestNonce}, pendingNonce=${pendingNonce})`
  );

  return {
    tx,
    decision: ReconcileDecision.MARK_DROPPED_RETRYABLE,
    reason: "force_dropped_tx_not_found_receipt_missing_block_mintable",
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
  } else if (decision === ReconcileDecision.MARK_DROPPED_RETRYABLE) {
    logger.info(
      {
        event: reason.startsWith("force_dropped_")
          ? LogEvent.RECONCILE_FORCE_DROP_APPLIED
          : LogEvent.RECONCILE_DROPPED_RETRYABLE,
        block: tx.block,
        txHash: tx.tx_hash,
        dryRun: opts.dryRun,
        reason,
      },
      `Reconciler: ${opts.dryRun ? "[DRY-RUN] would mark" : "marking"} tx ${tx.tx_hash} as dropped, block ${tx.block} as retryable`
    );

    if (isWrite) {
      markTxDropped(tx.tx_hash, reason);
      markBlockRetryable(tx.block, reason);
      insertReconcileEvent({
        block: tx.block,
        txHash: tx.tx_hash,
        previousStatus: tx.status,
        newStatus: "dropped",
        decision,
        reason,
        dryRun: false,
      });
    } else {
      insertReconcileEvent({
        block: tx.block,
        txHash: tx.tx_hash,
        previousStatus: tx.status,
        newStatus: "dropped",
        decision,
        reason,
        dryRun: true,
      });
    }
  } else if (decision === ReconcileDecision.MARK_DROPPED_MINTED) {
    logger.info(
      {
        event: LogEvent.RECONCILE_DROPPED_MINTED,
        block: tx.block,
        txHash: tx.tx_hash,
        dryRun: opts.dryRun,
      },
      `Reconciler: ${opts.dryRun ? "[DRY-RUN] would mark" : "marking"} tx ${tx.tx_hash} as dropped, block ${tx.block} as minted`
    );

    if (isWrite) {
      markTxDropped(tx.tx_hash, reason);
      upsertBlockResult({ block: tx.block, status: "minted", reason });
      insertReconcileEvent({
        block: tx.block,
        txHash: tx.tx_hash,
        previousStatus: tx.status,
        newStatus: "dropped",
        decision,
        reason,
        dryRun: false,
      });
    } else {
      insertReconcileEvent({
        block: tx.block,
        txHash: tx.tx_hash,
        previousStatus: tx.status,
        newStatus: "dropped",
        decision,
        reason,
        dryRun: true,
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
    dropped: 0,
    retryable: 0,
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
    let finalResult = result;

    // If fixDropped is enabled and resolveReviewRequired returned receipt_missing,
    // attempt dropped tx resolution
    if (
      opts.fixDropped === true &&
      result.decision === ReconcileDecision.LEAVE_REVIEW_REQUIRED &&
      result.reason === "receipt_missing"
    ) {
      finalResult = await resolveDroppedTx(tx, opts);
    }

    // If forceDrop is enabled and result is still receipt_missing (nonce not advanced),
    // attempt force-drop resolution
    if (
      opts.forceDrop === true &&
      finalResult.decision === ReconcileDecision.LEAVE_REVIEW_REQUIRED &&
      (finalResult.reason === "receipt_missing" || finalResult.reason === "nonce_not_advanced")
    ) {
      finalResult = await resolveForceDropTx(tx, opts);
    }

    applyDecision(tx, finalResult.decision, finalResult.reason, opts);

    report.results.push(finalResult);

    if (finalResult.decision === ReconcileDecision.MARK_FINALIZED) {
      report.finalized++;
    } else if (finalResult.decision === ReconcileDecision.MARK_FAILED) {
      report.failed++;
    } else if (finalResult.decision === ReconcileDecision.MARK_DROPPED_RETRYABLE) {
      report.dropped++;
      report.retryable++;
    } else if (finalResult.decision === ReconcileDecision.MARK_DROPPED_MINTED) {
      report.dropped++;
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
      dropped: report.dropped,
      retryable: report.retryable,
      dryRun: opts.dryRun,
    },
    `Reconciler: finished — ${report.finalized} finalized, ${report.failed} failed, ${report.dropped} dropped, ${report.retryable} retryable, ${report.leftReviewRequired} left review_required`
  );

  return report;
}
