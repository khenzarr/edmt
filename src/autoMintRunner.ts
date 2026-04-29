/**
 * AutoMintRunner — unattended automatic mint session manager.
 *
 * Activation requirements (ALL must be true):
 *   - UNATTENDED_AUTO_MINT=true
 *   - ENABLE_LIVE_MINT=true
 *   - DRY_RUN=false  (enforced by MintExecutor Gate 1)
 *   - PRIVATE_KEY present
 *   - No existing live lock file
 *   - No emergency stop file
 *
 * Safety guarantees:
 *   - Gate 1–12 in MintExecutor are NEVER bypassed
 *   - PRIVATE_KEY is NEVER logged or included in AutoMintReport
 *   - Fee-required blocks are skipped by default (AUTO_MINT_ONLY_NO_FEE_BLOCKS=true)
 *   - EDMT API confirmation (edmtStatusConfirmed=true) is required for every tx
 *   - Session, daily, and runtime limits are enforced before each tx
 */

import * as fs from "fs";
import * as crypto from "crypto";
import { config, hasPrivateKey } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { decideBlock } from "./blockScanner.js";
import { execute, resetRunState } from "./mintExecutor.js";
import { poll } from "./txMonitor.js";
import { getWalletBalanceEth, getWallet, getPendingNonce } from "./ethClient.js";
import {
  getDailyTxCount,
  hasPendingTx,
  getPendingTxCount,
  getUnfinalizedTxCount,
  hasReviewRequiredTx,
  hasFailedTx,
  updateHighBurnCandidateStatus,
} from "./db.js";
import { getCheckpoint, advanceScannedBlock, recordCheckpointError } from "./checkpoint.js";
import { getNextHighBurnCandidate, TierManager, defaultSelectorOpts } from "./highBurnSelector.js";
import { getBlockStatus } from "./edmtClient.js";
import type { AutoMintReport, StopReason, BlockResult } from "./types.js";

// ---------------------------------------------------------------------------
// High Burn candidate EDMT resolution
// ---------------------------------------------------------------------------

/**
 * Result of resolving a high burn candidate against the EDMT API.
 *
 * "proceed"  → candidate is mintable, edmtStatusConfirmed=true, feeRequired=false (or fee allowed)
 * "skip"     → candidate should be skipped this cycle (status updated in DB), try next
 * "exhaust"  → candidate is terminal (minted_elsewhere / not_eligible / fee_required_skipped)
 * "unknown"  → EDMT API unconfirmed; candidate marked unknown with backoff
 */
export type HighBurnResolveOutcome =
  | { action: "proceed"; blockResult: BlockResult }
  | { action: "skip" }
  | { action: "exhaust" }
  | { action: "unknown" };

/**
 * Resolve a high burn candidate against the EDMT API and update DB accordingly.
 *
 * Invariant: "proceed" is ONLY returned when:
 *   - EDMT API responded successfully (edmtStatusConfirmed=true)
 *   - status === "mintable"
 *   - minted_by is null/undefined
 *   - feeRequired=false OR (feeRequired=true AND HIGH_BURN_ONLY_NO_FEE=false)
 */
export async function resolveHighBurnCandidate(
  candidate: {
    block: number;
    burn_gwei: string;
    burn_eth: number;
    tier_eth: number;
    fee_required: number | null;
    edmt_status: string | null;
    attempts: number;
  },
  sessionId: string
): Promise<HighBurnResolveOutcome> {
  // Always increment attempts + last_attempt_at on every resolution attempt
  updateHighBurnCandidateStatus(candidate.block, "discovered", { incrementAttempts: true });

  let apiResult: BlockResult;
  try {
    apiResult = await getBlockStatus(candidate.block);
  } catch (err) {
    logger.warn(
      { event: LogEvent.RPC_ERROR, sessionId, block: candidate.block, err: String(err) },
      `High burn: EDMT API call failed for block ${candidate.block}`
    );
    updateHighBurnCandidateStatus(candidate.block, "unknown", {
      skip_reason: `edmt_api_error: ${String(err)}`,
    });
    return { action: "unknown" };
  }

  if (!apiResult.edmtStatusConfirmed) {
    // EDMT API unavailable / RPC fallback only — cannot confirm
    logger.warn(
      {
        event: LogEvent.BLOCK_UNKNOWN,
        sessionId,
        block: candidate.block,
        reason: apiResult.reason,
      },
      `High burn: edmtStatusConfirmed=false for block ${candidate.block} — marking unknown`
    );
    updateHighBurnCandidateStatus(candidate.block, "unknown", {
      skip_reason: "edmt_status_unconfirmed",
    });
    return { action: "unknown" };
  }

  // EDMT API confirmed — handle each status
  switch (apiResult.status) {
    case "minted": {
      logger.info(
        {
          event: LogEvent.HIGH_BURN_CANDIDATE_MINTED_ELSEWHERE,
          sessionId,
          block: candidate.block,
          owner: apiResult.owner,
          mintTx: apiResult.mintTx,
        },
        `High burn: block ${candidate.block} already minted by ${apiResult.owner ?? "unknown"}`
      );
      updateHighBurnCandidateStatus(candidate.block, "minted_elsewhere", {
        edmt_status: "minted",
        minted_by: apiResult.owner,
        mint_tx_hash: apiResult.mintTx,
      });
      return { action: "exhaust" };
    }

    case "not_eligible": {
      logger.info(
        {
          event: LogEvent.BLOCK_NOT_ELIGIBLE,
          sessionId,
          block: candidate.block,
          reason: apiResult.reason,
        },
        `High burn: block ${candidate.block} not eligible — ${apiResult.reason ?? ""}`
      );
      updateHighBurnCandidateStatus(candidate.block, "not_eligible", {
        edmt_status: "not_eligible",
        skip_reason: apiResult.reason ?? "api_not_eligible",
      });
      return { action: "exhaust" };
    }

    case "beyond_current_head":
    case "unknown": {
      logger.warn(
        {
          event: LogEvent.BLOCK_UNKNOWN,
          sessionId,
          block: candidate.block,
          status: apiResult.status,
          reason: apiResult.reason,
        },
        `High burn: block ${candidate.block} status=${apiResult.status} — marking unknown`
      );
      updateHighBurnCandidateStatus(candidate.block, "unknown", {
        edmt_status: apiResult.status,
        skip_reason: apiResult.reason ?? apiResult.status,
      });
      return { action: "unknown" };
    }

    case "mintable": {
      // Update edmt_status in DB
      const feeRequired = apiResult.feeRequired ?? false;

      updateHighBurnCandidateStatus(candidate.block, "discovered", {
        edmt_status: "mintable",
        fee_required: feeRequired,
      });

      // Fee filter
      if (feeRequired && config.highBurnOnlyNoFee) {
        logger.info(
          {
            event: LogEvent.MINT_GATE_FAILED,
            sessionId,
            block: candidate.block,
            reason: "fee_required + HIGH_BURN_ONLY_NO_FEE=true",
          },
          `High burn: block ${candidate.block} fee_required=true + HIGH_BURN_ONLY_NO_FEE=true — skipping`
        );
        updateHighBurnCandidateStatus(candidate.block, "fee_required_skipped", {
          skip_reason: "fee_required",
        });
        return { action: "exhaust" };
      }

      logger.info(
        {
          event: LogEvent.HIGH_BURN_CANDIDATE_SELECTED,
          sessionId,
          block: candidate.block,
          burnEth: candidate.burn_eth,
          tierEth: candidate.tier_eth,
          feeRequired,
          edmtStatusConfirmed: true,
        },
        `High burn: block ${candidate.block} confirmed mintable (burnEth=${candidate.burn_eth.toFixed(4)}, tier=${candidate.tier_eth})`
      );

      return {
        action: "proceed",
        blockResult: {
          block: candidate.block,
          status: "mintable",
          burnGwei: BigInt(candidate.burn_gwei),
          feeRequired,
          edmtStatusConfirmed: true,
        },
      };
    }

    default: {
      // Unrecognised status — treat as unknown
      updateHighBurnCandidateStatus(candidate.block, "unknown", {
        skip_reason: `unrecognised_status: ${apiResult.status}`,
      });
      return { action: "unknown" };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string;
  startedAt: Date;
  startBlock: number;
  currentBlock: number;
  blocksScanned: number;
  txSentThisSession: number;
  txHashes: string[];
  errors: string[];
  // Pipeline mode fields
  lastTxSentAt: number;
  stopNewTx: boolean;
  stopReason: StopReason;
}

// ---------------------------------------------------------------------------
// Lock file helpers
// ---------------------------------------------------------------------------

interface LockFileContent {
  pid: number;
  startedAt: string;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): "acquired" | "live_lock" | "stale_replaced" {
  const lockPath = config.autoMintSessionLockFile;

  if (fs.existsSync(lockPath)) {
    try {
      const raw = fs.readFileSync(lockPath, "utf8");
      const content = JSON.parse(raw) as LockFileContent;
      if (isProcessRunning(content.pid)) {
        logger.warn(
          { event: LogEvent.BOT_START, lockPath, pid: content.pid },
          `AutoMintRunner: lock file exists with live PID ${content.pid} — refusing to start`
        );
        return "live_lock";
      }
      // Stale lock — remove and continue
      fs.unlinkSync(lockPath);
      logger.info(
        { event: LogEvent.BOT_START, lockPath, stalePid: content.pid },
        "AutoMintRunner: removed stale lock file"
      );
    } catch {
      // Unreadable lock — treat as stale
      fs.unlinkSync(lockPath);
      logger.warn(
        { event: LogEvent.BOT_START, lockPath },
        "AutoMintRunner: removed unreadable lock file"
      );
    }
  }

  const content: LockFileContent = { pid: process.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(lockPath, JSON.stringify(content), "utf8");
  logger.info(
    { event: LogEvent.BOT_START, lockPath, pid: process.pid },
    "AutoMintRunner: lock file created"
  );
  return fs.existsSync(lockPath) ? "acquired" : "stale_replaced";
}

function releaseLock(): void {
  const lockPath = config.autoMintSessionLockFile;
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
      logger.info({ event: LogEvent.BOT_STOP, lockPath }, "AutoMintRunner: lock file released");
    }
  } catch (err) {
    logger.warn(
      { event: LogEvent.BOT_STOP, lockPath, err: String(err) },
      "AutoMintRunner: failed to release lock file"
    );
  }
}

// ---------------------------------------------------------------------------
// Emergency stop check
// ---------------------------------------------------------------------------

function isEmergencyStopRequested(): boolean {
  return fs.existsSync(config.autoMintEmergencyStopFile);
}

// ---------------------------------------------------------------------------
// Session limit checks
// ---------------------------------------------------------------------------

function checkSessionLimits(state: SessionState): StopReason | null {
  if (state.txSentThisSession >= config.autoMintMaxTxPerSession) {
    return "session_tx_limit_reached";
  }
  const dailyCount = getDailyTxCount();
  if (dailyCount >= config.autoMintMaxTxPerDay) {
    return "daily_tx_limit_reached";
  }
  if (config.autoMintMaxRuntimeMinutes > 0) {
    const elapsedMs = Date.now() - state.startedAt.getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    if (elapsedMinutes >= config.autoMintMaxRuntimeMinutes) {
      return "max_runtime_exceeded";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wallet balance check
// ---------------------------------------------------------------------------

async function checkWalletBalance(
  address: string
): Promise<"ok" | "too_low" | "too_high" | "error"> {
  try {
    const balance = await getWalletBalanceEth(address);
    if (balance < config.autoMintMinWalletBalanceEth) return "too_low";
    if (balance > config.autoMintRequireHotWalletBalanceMaxEth) return "too_high";
    return "ok";
  } catch (err) {
    logger.warn(
      { event: LogEvent.RPC_ERROR, err: String(err) },
      "AutoMintRunner: wallet balance check failed"
    );
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Build early-exit report (before session starts / lock acquired)
// ---------------------------------------------------------------------------

function earlyExitReport(stopReason: StopReason, startBlock: number): AutoMintReport {
  const now = new Date().toISOString();
  return {
    sessionId: crypto.randomUUID(),
    startedAt: now,
    endedAt: now,
    startBlock,
    blocksScanned: 0,
    txSentThisSession: 0,
    stopReason,
    txHashes: [],
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pipeline mode helpers
// ---------------------------------------------------------------------------

/**
 * Check pipeline capacity.
 * Returns "ok" if both pending and unfinalized counts are below their limits.
 * Exported for testability.
 */
export function checkPipelineCapacity(
  pendingCount: number,
  unfinalizedCount: number,
  maxPending: number,
  maxUnfinalized: number
): "ok" | "pending_full" | "unfinalized_full" {
  if (pendingCount >= maxPending) return "pending_full";
  if (unfinalizedCount >= maxUnfinalized) return "unfinalized_full";
  return "ok";
}

/**
 * Check pipeline stop conditions after TxMonitor.poll().
 * Returns a StopReason if the pipeline should stop, null otherwise.
 * Exported for testability.
 */
export async function checkPipelineStopConditions(
  _state: SessionState
): Promise<StopReason | null> {
  // 1. review_required check
  if (config.autoMintStopOnReviewRequired && hasReviewRequiredTx()) {
    return "review_required_detected";
  }
  // 2. failed tx check
  if (config.autoMintStopOnPendingTxFailure && hasFailedTx()) {
    return "pending_tx_failure_detected";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAutoMint(): Promise<AutoMintReport> {
  // -------------------------------------------------------------------------
  // Pre-condition checks (before lock acquisition)
  // -------------------------------------------------------------------------
  const startBlock = getCheckpoint("last_scanned_block") ?? config.startBlock;

  if (!config.unattendedAutoMint) {
    logger.warn(
      { event: LogEvent.BOT_START },
      "AutoMintRunner: UNATTENDED_AUTO_MINT=false — not starting"
    );
    return earlyExitReport("unattended_auto_mint_disabled", startBlock);
  }

  if (!config.enableLiveMint) {
    logger.warn(
      { event: LogEvent.BOT_START },
      "AutoMintRunner: ENABLE_LIVE_MINT=false — not starting"
    );
    return earlyExitReport("live_mint_disabled", startBlock);
  }

  if (!hasPrivateKey()) {
    logger.warn(
      { event: LogEvent.BOT_START },
      "AutoMintRunner: PRIVATE_KEY not set — not starting"
    );
    return earlyExitReport("no_private_key", startBlock);
  }

  // -------------------------------------------------------------------------
  // Lock file acquisition
  // -------------------------------------------------------------------------
  const lockResult = acquireLock();
  if (lockResult === "live_lock") {
    return earlyExitReport("lock_file_exists", startBlock);
  }

  // -------------------------------------------------------------------------
  // Session initialisation
  // -------------------------------------------------------------------------
  const sessionId = crypto.randomUUID();
  const startedAt = new Date();

  const state: SessionState = {
    sessionId,
    startedAt,
    startBlock,
    currentBlock: startBlock,
    blocksScanned: 0,
    txSentThisSession: 0,
    txHashes: [],
    errors: [],
    lastTxSentAt: 0,
    stopNewTx: false,
    stopReason: "completed",
  };

  // Override REQUIRE_MANUAL_CONFIRMATION when autoMintConfirmEachTx=false
  if (!config.autoMintConfirmEachTx) {
    (config as Record<string, unknown>)["requireManualConfirmationForFirstTx"] = false;
  }

  resetRunState();

  logger.info(
    {
      event: LogEvent.BOT_START,
      sessionId,
      startBlock,
      maxTxPerSession: config.autoMintMaxTxPerSession,
      maxTxPerDay: config.autoMintMaxTxPerDay,
      maxRuntimeMinutes: config.autoMintMaxRuntimeMinutes,
      onlyNoFeeBlocks: config.autoMintOnlyNoFeeBlocks,
    },
    `AutoMintRunner: session ${sessionId} started at block ${startBlock}`
  );

  if (config.autoMintPipelineMode) {
    logger.info(
      {
        event: LogEvent.PIPELINE_MODE_ENABLED,
        sessionId,
        maxPendingTxs: config.autoMintMaxPendingTxs,
        maxUnfinalizedTxs: config.autoMintMaxUnfinalizedTxs,
        txSpacingMs: config.autoMintTxSpacingMs,
        reconcileIntervalMs: config.autoMintReconcileIntervalMs,
        stopOnPendingTxFailure: config.autoMintStopOnPendingTxFailure,
      },
      "AutoMintRunner: pipeline mode enabled"
    );
  }

  if (config.highBurnPriorityMode) {
    logger.info(
      {
        event: LogEvent.HIGH_BURN_MODE_ENABLED,
        sessionId,
        activeTierEth: config.highBurnActiveTierEth,
        tiers: config.highBurnMinEthTiers,
        onExhausted: config.highBurnOnExhausted,
      },
      "AutoMintRunner: high burn priority mode enabled"
    );
  }

  // Wallet address for balance checks
  let walletAddress: string;
  try {
    walletAddress = getWallet().address;
  } catch {
    releaseLock();
    return earlyExitReport("no_private_key", startBlock);
  }

  // -------------------------------------------------------------------------
  // Auto-reconcile startup integration
  // If AUTO_RECONCILE_REVIEW_REQUIRED=true and review_required records exist,
  // attempt to reconcile them before starting the session.
  // If any remain after reconcile, abort with review_required_detected.
  // -------------------------------------------------------------------------
  if (config.autoReconcileReviewRequired && hasReviewRequiredTx()) {
    logger.info(
      { event: LogEvent.RECONCILE_STARTED, sessionId },
      "AutoMintRunner: review_required records found — attempting auto-reconcile before session start"
    );
    try {
      const { reconcileAll } = await import("./reconciler.js");
      const reconcileReport = await reconcileAll({ dryRun: false, fix: true });
      logger.info(
        {
          event: LogEvent.RECONCILE_FINISHED,
          sessionId,
          total: reconcileReport.total,
          finalized: reconcileReport.finalized,
          failed: reconcileReport.failed,
          leftReviewRequired: reconcileReport.leftReviewRequired,
        },
        `AutoMintRunner: auto-reconcile complete — ${reconcileReport.finalized} finalized, ${reconcileReport.leftReviewRequired} still review_required`
      );
    } catch (err) {
      logger.warn(
        { event: LogEvent.RECONCILE_FINISHED, sessionId, err: String(err) },
        "AutoMintRunner: auto-reconcile threw an error — proceeding to review_required check"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Graceful shutdown handler
  // -------------------------------------------------------------------------
  let shutdownRequested = false;
  const onShutdown = () => {
    shutdownRequested = true;
  };
  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);

  let stopReason: StopReason = "completed";

  // Max consecutive beyond_current_head polls before giving up.
  // Derived from runtime limit / poll interval so tests with maxRuntimeMinutes=0
  // or pollIntervalMs=0 exit after a single beyond_current_head cycle.
  const maxConsecutiveBeyondHead = Math.max(
    1,
    Math.ceil(
      (config.autoMintMaxRuntimeMinutes * 60_000) / Math.max(1, config.autoMintPollIntervalMs)
    )
  );
  let consecutiveBeyondHead = 0;

  // -------------------------------------------------------------------------
  // Poll loop — branches on pipeline mode
  // -------------------------------------------------------------------------
  try {
    if (config.autoMintPipelineMode) {
      // =======================================================================
      // PIPELINE MODE LOOP
      // =======================================================================
      let lastSubmittedNonce: number | undefined;

      // Initialize TierManager for high burn mode
      const highBurnTierManager = config.highBurnPriorityMode
        ? new TierManager(config.highBurnActiveTierEth, config.highBurnMinEthTiers)
        : null;

      if (highBurnTierManager) {
        logger.info(
          { event: LogEvent.HIGH_BURN_TIER_STARTED, tierEth: config.highBurnActiveTierEth },
          `High burn: starting with tier ${config.highBurnActiveTierEth} ETH`
        );
      }

      while (!shutdownRequested) {
        // ① Pre-checks: emergency stop
        if (isEmergencyStopRequested()) {
          logger.warn(
            {
              event: LogEvent.BOT_STOP,
              sessionId,
              emergencyStopFile: config.autoMintEmergencyStopFile,
            },
            "AutoMintRunner: emergency stop file detected — halting new tx (pipeline)"
          );
          stopReason = "emergency_stop_file_detected";
          break;
        }

        // ① Pre-checks: session limits
        const limitReason = checkSessionLimits(state);
        if (limitReason) {
          logger.info(
            { event: LogEvent.BOT_STOP, sessionId, reason: limitReason },
            `AutoMintRunner: session limit reached — ${limitReason}`
          );
          stopReason = limitReason;
          break;
        }

        // ① Pre-checks: allowed stop block
        if (
          config.autoMintAllowedStopBlock !== undefined &&
          state.currentBlock > config.autoMintAllowedStopBlock
        ) {
          stopReason = "allowed_stop_block_reached";
          break;
        }

        // ① Pre-checks: wallet balance
        const balanceStatus = await checkWalletBalance(walletAddress);
        if (balanceStatus === "too_low") {
          logger.warn(
            { event: LogEvent.MINT_GATE_FAILED, sessionId, reason: "wallet_balance_too_low" },
            "AutoMintRunner: wallet balance too low — waiting (pipeline)"
          );
          await sleep(config.autoMintReconcileIntervalMs);
          continue;
        }
        if (balanceStatus === "too_high") {
          logger.warn(
            { event: LogEvent.MINT_GATE_FAILED, sessionId, reason: "wallet_balance_too_high" },
            "AutoMintRunner: wallet balance too high — stopping session (pipeline)"
          );
          stopReason = "wallet_balance_high";
          break;
        }
        if (balanceStatus === "error") {
          await sleep(config.autoMintReconcileIntervalMs);
          continue;
        }

        // ② Monitor Phase: TxMonitor.poll()
        logger.debug(
          { event: LogEvent.PIPELINE_MONITOR_POLL, sessionId },
          "AutoMintRunner: pipeline monitor poll"
        );
        try {
          await poll();
        } catch (err) {
          logger.warn(
            { event: LogEvent.RPC_ERROR, sessionId, err: String(err) },
            "AutoMintRunner: TxMonitor.poll() failed in pipeline mode — continuing"
          );
        }

        // ③ Stop condition check (after poll)
        if (state.stopNewTx) {
          // Already flagged — keep monitoring but don't send new tx
          logger.info(
            { event: LogEvent.BOT_STOP, sessionId, reason: state.stopReason },
            `AutoMintRunner: pipeline stopNewTx=true (${state.stopReason}) — monitoring only`
          );
          // If no more pending/included txs, we can exit
          if (!hasPendingTx()) {
            stopReason = state.stopReason;
            break;
          }
          await sleep(config.autoMintReconcileIntervalMs);
          continue;
        }

        const pipelineStopReason = await checkPipelineStopConditions(state);
        if (pipelineStopReason) {
          logger.warn(
            { event: LogEvent.BOT_STOP, sessionId, reason: pipelineStopReason },
            `AutoMintRunner: pipeline stop condition detected — ${pipelineStopReason}`
          );
          state.stopNewTx = true;
          state.stopReason = pipelineStopReason;
          await sleep(config.autoMintReconcileIntervalMs);
          continue;
        }

        // ④ Capacity check
        const pendingCount = getPendingTxCount();
        const unfinalizedCount = getUnfinalizedTxCount();
        const capacityResult = checkPipelineCapacity(
          pendingCount,
          unfinalizedCount,
          config.autoMintMaxPendingTxs,
          config.autoMintMaxUnfinalizedTxs
        );

        if (capacityResult !== "ok") {
          logger.debug(
            {
              event: LogEvent.PIPELINE_PENDING_CAPACITY_FULL,
              sessionId,
              pendingCount,
              unfinalizedCount,
              capacityResult,
            },
            `AutoMintRunner: pipeline capacity full (${capacityResult}) — waiting`
          );
          await sleep(config.autoMintReconcileIntervalMs);
          continue;
        }

        logger.debug(
          {
            event: LogEvent.PIPELINE_PENDING_CAPACITY_AVAILABLE,
            sessionId,
            pendingCount,
            unfinalizedCount,
          },
          "AutoMintRunner: pipeline capacity available"
        );

        // ⑤ Tx spacing check
        const elapsed = Date.now() - state.lastTxSentAt;
        if (state.lastTxSentAt > 0 && elapsed < config.autoMintTxSpacingMs) {
          const remaining = config.autoMintTxSpacingMs - elapsed;
          logger.debug(
            {
              event: LogEvent.PIPELINE_TX_SPACING_WAIT,
              sessionId,
              remainingMs: remaining,
            },
            `AutoMintRunner: pipeline tx spacing wait — ${remaining}ms remaining`
          );
          await sleep(Math.min(remaining, config.autoMintReconcileIntervalMs));
          continue;
        }

        // ⑥ Nonce check before scan/send
        let expectedNonce: number | undefined;
        try {
          const currentNonce = await getPendingNonce(walletAddress);

          logger.debug(
            {
              event: LogEvent.PIPELINE_NONCE_STATE_CHECK,
              sessionId,
              currentNonce,
              lastSubmittedNonce,
              activeTxCount: getUnfinalizedTxCount(),
            },
            "AutoMintRunner: pipeline nonce state check"
          );

          if (lastSubmittedNonce !== undefined && currentNonce < lastSubmittedNonce + 1) {
            // Nonce appears behind expected. Check if this is a real anomaly or
            // a false positive caused by RPC propagation delay after all txs finalized.
            const activeTxCount = getUnfinalizedTxCount();

            if (activeTxCount === 0) {
              // All txs are finalized — RPC pending nonce lag is a false positive.
              // Reconcile: reset lastSubmittedNonce to align with provider state.
              logger.info(
                {
                  event: LogEvent.PIPELINE_NONCE_STATE_RECONCILED,
                  sessionId,
                  currentNonce,
                  lastSubmittedNonce,
                  activeTxCount,
                },
                "AutoMintRunner: nonce lag with no active txs — reconciling, pipeline continues"
              );
              lastSubmittedNonce = currentNonce - 1;
              expectedNonce = currentNonce;
            } else {
              // Active pending/included txs exist and nonce is behind — real anomaly.
              logger.error(
                {
                  event: LogEvent.PIPELINE_NONCE_STATE_MISMATCH,
                  sessionId,
                  currentNonce,
                  lastSubmittedNonce,
                  activeTxCount,
                },
                "AutoMintRunner: nonce mismatch with active txs — stopping new tx"
              );
              logger.error(
                {
                  event: LogEvent.PIPELINE_NONCE_ANOMALY,
                  sessionId,
                  currentNonce,
                  lastSubmittedNonce,
                },
                "AutoMintRunner: nonce anomaly detected — stopping new tx"
              );
              state.stopNewTx = true;
              state.stopReason = "nonce_anomaly_detected";
              await sleep(config.autoMintReconcileIntervalMs);
              continue;
            }
          } else {
            expectedNonce = currentNonce;
          }
        } catch (err) {
          logger.warn(
            { event: LogEvent.RPC_ERROR, sessionId, err: String(err) },
            "AutoMintRunner: getPendingNonce failed — skipping this cycle"
          );
          await sleep(config.autoMintReconcileIntervalMs);
          continue;
        }

        // ⑥ Scan/Send Phase: decideBlock (or high burn candidate if mode=true)
        let blockResult;

        if (config.highBurnPriorityMode) {
          // HIGH BURN MODE: select candidate from tier, then resolve via EDMT API
          const candidate = getNextHighBurnCandidate(
            highBurnTierManager!.getActiveTier(),
            defaultSelectorOpts()
          );

          if (!candidate) {
            // No candidate in active tier — try downgrade
            const downgraded = highBurnTierManager!.tryDowngrade();
            if (!downgraded) {
              if (config.highBurnOnExhausted === "stop") {
                stopReason = "high_burn_all_tiers_exhausted";
                break;
              } else if (config.highBurnOnExhausted === "wait") {
                await sleep(config.autoMintReconcileIntervalMs);
                continue;
              } else {
                // fallback_sequential
                blockResult = await decideBlock(state.currentBlock).catch((err) => {
                  const msg = `decideBlock(${state.currentBlock}) threw: ${String(err)}`;
                  logger.error({ event: LogEvent.RPC_ERROR, sessionId, err: String(err) }, msg);
                  state.errors.push(msg);
                  return null;
                });
                if (!blockResult) {
                  if (config.autoMintStopOnFirstError) {
                    stopReason = "first_error_stop";
                    break;
                  }
                  await sleep(config.autoMintReconcileIntervalMs);
                  continue;
                }
              }
            } else {
              await sleep(config.autoMintReconcileIntervalMs);
              continue;
            }
          } else {
            // Resolve candidate via EDMT API — edmtStatusConfirmed REQUIRED before any mint decision
            const resolved = await resolveHighBurnCandidate(candidate, sessionId);
            if (resolved.action === "proceed") {
              blockResult = resolved.blockResult;
            } else {
              // skip / exhaust / unknown — move to next iteration
              await sleep(config.autoMintReconcileIntervalMs);
              continue;
            }
          }
        } else {
          // SEQUENTIAL/PIPELINE MODE: normal decideBlock
          try {
            blockResult = await decideBlock(state.currentBlock);
          } catch (err) {
            const msg = `decideBlock(${state.currentBlock}) threw: ${String(err)}`;
            logger.error({ event: LogEvent.RPC_ERROR, sessionId, err: String(err) }, msg);
            state.errors.push(msg);
            if (config.autoMintStopOnFirstError) {
              stopReason = "first_error_stop";
              break;
            }
            await sleep(config.autoMintReconcileIntervalMs);
            continue;
          }
        }

        state.blocksScanned++;

        switch (blockResult.status) {
          case "beyond_current_head":
            consecutiveBeyondHead++;
            if (consecutiveBeyondHead >= maxConsecutiveBeyondHead) {
              // If no pending txs, we're done
              if (!hasPendingTx()) {
                stopReason = "completed";
                break;
              }
              // Still have pending txs — keep monitoring
              consecutiveBeyondHead = 0;
            }
            await sleep(config.autoMintReconcileIntervalMs);
            continue;

          case "not_eligible":
            consecutiveBeyondHead = 0;
            advanceScannedBlock(state.currentBlock, "not_eligible");
            state.currentBlock++;
            continue;

          case "minted":
            consecutiveBeyondHead = 0;
            advanceScannedBlock(state.currentBlock, "minted");
            state.currentBlock++;
            continue;

          case "unknown":
            // In pipeline mode, unknown does NOT advance checkpoint
            recordCheckpointError(
              state.currentBlock,
              "autoMintRunner:unknown",
              blockResult.reason ?? "Unknown block status"
            );
            if (config.autoMintStopOnFirstError) {
              stopReason = "first_error_stop";
              break;
            }
            await sleep(config.autoMintReconcileIntervalMs);
            continue;

          case "mintable":
            consecutiveBeyondHead = 0;
            break; // fall through to mint logic
        }

        if (blockResult.status !== "mintable") break;

        // Fee filtering
        if (blockResult.feeRequired) {
          if (config.autoMintOnlyNoFeeBlocks) {
            logger.info(
              { event: LogEvent.MINT_GATE_FAILED, sessionId, block: state.currentBlock },
              "AutoMintRunner: feeRequired=true + onlyNoFeeBlocks=true — skipping block (pipeline)"
            );
            advanceScannedBlock(state.currentBlock, "not_eligible");
            state.currentBlock++;
            continue;
          }
          if (config.autoMintStopOnFeeRequired) {
            logger.warn(
              { event: LogEvent.MINT_GATE_FAILED, sessionId, block: state.currentBlock },
              "AutoMintRunner: feeRequired=true + stopOnFeeRequired=true — stopping session (pipeline)"
            );
            stopReason = "fee_required_block_detected";
            break;
          }
        }

        // Allowed start block
        if (
          config.autoMintAllowedStartBlock !== undefined &&
          state.currentBlock < config.autoMintAllowedStartBlock
        ) {
          advanceScannedBlock(state.currentBlock, "not_eligible");
          state.currentBlock++;
          continue;
        }

        // Execute mint in pipeline mode
        let mintResult;
        try {
          mintResult = await execute(blockResult, {
            mode: "automint",
            pipelineMode: true,
            expectedNonce,
          });
        } catch (err) {
          const msg = `execute(${state.currentBlock}) threw: ${String(err)}`;
          logger.error({ event: LogEvent.RPC_ERROR, sessionId, err: String(err) }, msg);
          state.errors.push(msg);
          if (config.autoMintStopOnFirstError) {
            stopReason = "first_error_stop";
            break;
          }
          await sleep(config.autoMintReconcileIntervalMs);
          continue;
        }

        if (mintResult.status === "submitted" && mintResult.txHash) {
          state.txSentThisSession++;
          state.txHashes.push(mintResult.txHash);
          state.lastTxSentAt = Date.now();
          lastSubmittedNonce = expectedNonce;

          // Advance scan checkpoint after submit (pipeline mode)
          if (!config.highBurnPriorityMode) {
            advanceScannedBlock(state.currentBlock, "submitted");
          }
          state.currentBlock++;

          // Update high burn candidate status if in high burn mode
          if (config.highBurnPriorityMode) {
            updateHighBurnCandidateStatus(blockResult.block, "submitted");
            logger.info(
              {
                event: LogEvent.HIGH_BURN_CANDIDATE_SUBMITTED,
                sessionId,
                block: blockResult.block,
                txHash: mintResult.txHash,
                nonce: expectedNonce,
                tierEth: highBurnTierManager?.getActiveTier(),
              },
              `High burn: tx submitted for block ${blockResult.block}`
            );
          }

          logger.info(
            {
              event: LogEvent.PIPELINE_TX_SUBMITTED,
              sessionId,
              block: state.currentBlock - 1,
              txHash: mintResult.txHash,
              nonce: expectedNonce,
            },
            `AutoMintRunner: pipeline tx submitted for block ${state.currentBlock - 1}`
          );
        } else {
          // Tx was skipped/blocked by a gate — advance and continue
          if (!config.highBurnPriorityMode) {
            state.currentBlock++;
          } else {
            state.currentBlock++;
          }
        }

        await sleep(config.autoMintReconcileIntervalMs);
      }
    } else {
      // =======================================================================
      // SEQUENTIAL MODE LOOP
      // =======================================================================

      // Initialize TierManager for high burn mode (sequential)
      const seqHighBurnTierManager = config.highBurnPriorityMode
        ? new TierManager(config.highBurnActiveTierEth, config.highBurnMinEthTiers)
        : null;

      if (seqHighBurnTierManager) {
        logger.info(
          { event: LogEvent.HIGH_BURN_TIER_STARTED, tierEth: config.highBurnActiveTierEth },
          `High burn: starting with tier ${config.highBurnActiveTierEth} ETH (sequential)`
        );
      }

      while (!shutdownRequested) {
        // 1. Emergency stop check
        if (isEmergencyStopRequested()) {
          logger.warn(
            {
              event: LogEvent.BOT_STOP,
              sessionId,
              emergencyStopFile: config.autoMintEmergencyStopFile,
            },
            "AutoMintRunner: emergency stop file detected — halting session"
          );
          stopReason = "emergency_stop_file_detected";
          break;
        }

        // 2. Session limits
        const limitReason = checkSessionLimits(state);
        if (limitReason) {
          logger.info(
            { event: LogEvent.BOT_STOP, sessionId, reason: limitReason },
            `AutoMintRunner: session limit reached — ${limitReason}`
          );
          stopReason = limitReason;
          break;
        }

        // 3. Allowed stop block
        if (
          config.autoMintAllowedStopBlock !== undefined &&
          state.currentBlock > config.autoMintAllowedStopBlock
        ) {
          stopReason = "allowed_stop_block_reached";
          break;
        }

        // 4. Wallet balance check
        const balanceStatus = await checkWalletBalance(walletAddress);
        if (balanceStatus === "too_low") {
          logger.warn(
            { event: LogEvent.MINT_GATE_FAILED, sessionId, reason: "wallet_balance_too_low" },
            "AutoMintRunner: wallet balance too low — waiting"
          );
          await sleep(config.autoMintPollIntervalMs);
          continue;
        }
        if (balanceStatus === "too_high") {
          logger.warn(
            { event: LogEvent.MINT_GATE_FAILED, sessionId, reason: "wallet_balance_too_high" },
            "AutoMintRunner: wallet balance too high — stopping session"
          );
          stopReason = "wallet_balance_high";
          break;
        }
        if (balanceStatus === "error") {
          // RPC error on balance check — skip this cycle
          await sleep(config.autoMintPollIntervalMs);
          continue;
        }

        // 5. Pending tx check — poll for finality before waiting
        if (!config.allowMultiplePendingTx && hasPendingTx()) {
          try {
            await poll();
          } catch (err) {
            logger.warn(
              { event: LogEvent.RPC_ERROR, sessionId, err: String(err) },
              "AutoMintRunner: TxMonitor.poll() failed while waiting for pending tx"
            );
          }
          if (hasPendingTx()) {
            logger.info(
              { event: LogEvent.MINT_GATE_FAILED, sessionId },
              "AutoMintRunner: pending tx exists — waiting"
            );
            await sleep(config.autoMintPollIntervalMs);
            continue;
          }
          // Pending tx cleared — check review_required
          if (config.autoMintStopOnReviewRequired) {
            if (hasReviewRequiredTx()) {
              logger.warn(
                { event: LogEvent.BOT_STOP, sessionId },
                "AutoMintRunner: review_required detected — stopping session"
              );
              stopReason = "review_required_detected";
              break;
            }
          }
        }

        // 6. Decide block (or high burn candidate)
        let blockResult;

        if (config.highBurnPriorityMode && seqHighBurnTierManager) {
          // HIGH BURN MODE: select candidate from tier, then resolve via EDMT API
          const candidate = getNextHighBurnCandidate(
            seqHighBurnTierManager.getActiveTier(),
            defaultSelectorOpts()
          );

          if (!candidate) {
            const downgraded = seqHighBurnTierManager.tryDowngrade();
            if (!downgraded) {
              if (config.highBurnOnExhausted === "stop") {
                stopReason = "high_burn_all_tiers_exhausted";
                break;
              } else if (config.highBurnOnExhausted === "wait") {
                await sleep(config.autoMintPollIntervalMs);
                continue;
              } else {
                // fallback_sequential
                try {
                  blockResult = await decideBlock(state.currentBlock);
                } catch (err) {
                  const msg = `decideBlock(${state.currentBlock}) threw: ${String(err)}`;
                  logger.error({ event: LogEvent.RPC_ERROR, sessionId, err: String(err) }, msg);
                  state.errors.push(msg);
                  if (config.autoMintStopOnFirstError) {
                    stopReason = "first_error_stop";
                    break;
                  }
                  await sleep(config.autoMintPollIntervalMs);
                  continue;
                }
              }
            } else {
              await sleep(config.autoMintPollIntervalMs);
              continue;
            }
          } else {
            // Resolve candidate via EDMT API — edmtStatusConfirmed REQUIRED before any mint decision
            const resolved = await resolveHighBurnCandidate(candidate, sessionId);
            if (resolved.action === "proceed") {
              blockResult = resolved.blockResult;
            } else {
              // skip / exhaust / unknown — move to next iteration
              await sleep(config.autoMintPollIntervalMs);
              continue;
            }
          }
        } else {
          // SEQUENTIAL MODE: normal decideBlock
          try {
            blockResult = await decideBlock(state.currentBlock);
          } catch (err) {
            const msg = `decideBlock(${state.currentBlock}) threw: ${String(err)}`;
            logger.error({ event: LogEvent.RPC_ERROR, sessionId, err: String(err) }, msg);
            state.errors.push(msg);
            if (config.autoMintStopOnFirstError) {
              stopReason = "first_error_stop";
              break;
            }
            await sleep(config.autoMintPollIntervalMs);
            continue;
          }
        }

        state.blocksScanned++;

        switch (blockResult.status) {
          case "beyond_current_head":
            consecutiveBeyondHead++;
            if (consecutiveBeyondHead >= maxConsecutiveBeyondHead) {
              stopReason = "completed";
              break;
            }
            await sleep(config.autoMintPollIntervalMs);
            continue;

          case "not_eligible":
            consecutiveBeyondHead = 0;
            advanceScannedBlock(state.currentBlock, "not_eligible");
            state.currentBlock++;
            await sleep(config.autoMintPollIntervalMs);
            continue;

          case "minted":
            consecutiveBeyondHead = 0;
            advanceScannedBlock(state.currentBlock, "minted");
            state.currentBlock++;
            await sleep(config.autoMintPollIntervalMs);
            continue;

          case "unknown":
            recordCheckpointError(
              state.currentBlock,
              "autoMintRunner:unknown",
              blockResult.reason ?? "Unknown block status"
            );
            if (config.autoMintStopOnFirstError) {
              stopReason = "first_error_stop";
              break;
            }
            await sleep(config.autoMintPollIntervalMs);
            continue;

          case "mintable":
            consecutiveBeyondHead = 0;
            break; // fall through to mint logic below
        }

        if (blockResult.status !== "mintable") break;

        // 7. Fee filtering
        if (blockResult.feeRequired) {
          if (config.autoMintOnlyNoFeeBlocks) {
            logger.info(
              { event: LogEvent.MINT_GATE_FAILED, sessionId, block: state.currentBlock },
              "AutoMintRunner: feeRequired=true + onlyNoFeeBlocks=true — skipping block"
            );
            advanceScannedBlock(state.currentBlock, "not_eligible");
            state.currentBlock++;
            await sleep(config.autoMintPollIntervalMs);
            continue;
          }
          if (config.autoMintStopOnFeeRequired) {
            logger.warn(
              { event: LogEvent.MINT_GATE_FAILED, sessionId, block: state.currentBlock },
              "AutoMintRunner: feeRequired=true + stopOnFeeRequired=true — stopping session"
            );
            stopReason = "fee_required_block_detected";
            break;
          }
        }

        // 8. Allowed start block
        if (
          config.autoMintAllowedStartBlock !== undefined &&
          state.currentBlock < config.autoMintAllowedStartBlock
        ) {
          advanceScannedBlock(state.currentBlock, "not_eligible");
          state.currentBlock++;
          continue;
        }

        // 9. Execute mint (Gate 1–12 enforced inside MintExecutor; Gate 11 bypassed in automint mode)
        let mintResult;
        try {
          mintResult = await execute(blockResult, { mode: "automint" });
        } catch (err) {
          const msg = `execute(${state.currentBlock}) threw: ${String(err)}`;
          logger.error({ event: LogEvent.RPC_ERROR, sessionId, err: String(err) }, msg);
          state.errors.push(msg);
          if (config.autoMintStopOnFirstError) {
            stopReason = "first_error_stop";
            break;
          }
          await sleep(config.autoMintPollIntervalMs);
          continue;
        }

        if (mintResult.status === "submitted" && mintResult.txHash) {
          state.txSentThisSession++;
          state.txHashes.push(mintResult.txHash);

          // Update high burn candidate status if in high burn mode
          if (config.highBurnPriorityMode) {
            updateHighBurnCandidateStatus(blockResult.block, "submitted");
            logger.info(
              {
                event: LogEvent.HIGH_BURN_CANDIDATE_SUBMITTED,
                sessionId,
                block: blockResult.block,
                txHash: mintResult.txHash,
                tierEth: seqHighBurnTierManager?.getActiveTier(),
              },
              `High burn: tx submitted for block ${blockResult.block}`
            );
          } else {
            state.currentBlock++;
          }

          // 10. TxMonitor poll
          try {
            await poll();
          } catch (err) {
            logger.warn(
              { event: LogEvent.RPC_ERROR, sessionId, err: String(err) },
              "AutoMintRunner: TxMonitor.poll() failed — continuing"
            );
          }

          // 11. Cooldown
          await sleep(config.autoMintCooldownAfterTxMs);
        } else {
          // Tx was skipped/blocked by a gate — advance and continue
          state.currentBlock++;
        }

        await sleep(config.autoMintPollIntervalMs);
      }
    }
  } finally {
    process.off("SIGINT", onShutdown);
    process.off("SIGTERM", onShutdown);
    releaseLock();
  }

  const endedAt = new Date().toISOString();
  const report: AutoMintReport = {
    sessionId,
    startedAt: startedAt.toISOString(),
    endedAt,
    startBlock,
    endBlock: state.currentBlock,
    blocksScanned: state.blocksScanned,
    txSentThisSession: state.txSentThisSession,
    stopReason,
    txHashes: state.txHashes,
    errors: state.errors,
  };

  logger.info(
    { event: LogEvent.BOT_STOP, sessionId, stopReason, txSent: state.txSentThisSession },
    `AutoMintRunner: session ${sessionId} ended — ${stopReason}`
  );

  return report;
}
