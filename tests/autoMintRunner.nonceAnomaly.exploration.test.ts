/**
 * Nonce Anomaly Recovery — Bug Condition Exploration Test
 *
 * **Property 1: Bug Condition** — Recoverable Nonce Anomaly Session'ı Kapatmaz
 *
 * **Validates: Requirements 1.1, 1.2**
 *
 * CRITICAL: This test MUST FAIL on unfixed code — failure confirms the bug exists.
 * DO NOT attempt to fix the test or the code when it fails.
 * NOTE: This test encodes the expected behavior — it will validate the fix when it
 *       passes after implementation.
 * GOAL: Surface counterexamples that demonstrate the bug exists.
 *
 * Bug Condition (isBugCondition):
 *   X.nonceAnomalyDetected = true
 *   AND X.activeTxCount = 0
 *   AND X.failedCount = 0
 *   AND X.reviewRequiredCount = 0
 *   AND X.latestNonce == X.pendingNonce
 *   AND X.latestNonce >= X.maxFinalizedNonce + 1
 *
 * On unfixed code: runAutoMint() returns stopReason="nonce_anomaly_detected"
 * when the bug condition holds — this is the bug.
 *
 * Expected (fixed) behavior: runAutoMint() does NOT return
 * stopReason="nonce_anomaly_detected" when the bug condition holds.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mutable config
// ---------------------------------------------------------------------------
const mockConfig = {
  dryRun: false,
  enableLiveMint: true,
  privateKey: "0xdeadbeef",

  unattendedAutoMint: true,
  autoMintMaxTxPerSession: 999,
  autoMintMaxTxPerDay: 999,
  autoMintMaxRuntimeMinutes: 0,
  autoMintPollIntervalMs: 0,
  autoMintConfirmEachTx: false,
  autoMintMinWalletBalanceEth: 0.001,
  autoMintRequireHotWalletBalanceMaxEth: 0.02,
  autoMintStopOnFirstError: false,
  autoMintStopOnReviewRequired: true,
  autoMintStopOnFeeRequired: false,
  autoMintOnlyNoFeeBlocks: true,
  autoMintAllowedStartBlock: undefined as number | undefined,
  autoMintAllowedStopBlock: undefined as number | undefined,
  autoMintCooldownAfterTxMs: 0,
  autoMintEmergencyStopFile: "./STOP_AUTOMINT_NONCE_ANOMALY_EXPLORATION",
  autoMintSessionLockFile: "./automint_nonce_anomaly_exploration.lock",

  autoMintPipelineMode: true,
  autoMintMaxPendingTxs: 3,
  autoMintMaxUnfinalizedTxs: 10,
  autoMintTxSpacingMs: 0,
  autoMintStopOnPendingTxFailure: true,
  autoMintReconcileIntervalMs: 0,
  autoMintRequireIncludedBeforeNextTx: false,

  allowMultiplePendingTx: false,
  requireManualConfirmationForFirstTx: false,
  startBlock: 18000000,

  // Optional features — disabled
  highBurnPriorityMode: false,
  autoReconcileReviewRequired: false,
};

vi.mock("../src/config.js", () => ({
  get config() {
    return mockConfig;
  },
  isLiveMintEnabled: () => !mockConfig.dryRun && mockConfig.enableLiveMint,
  hasPrivateKey: () => mockConfig.privateKey.length > 0,
}));

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LogEvent: {
    BOT_START: "bot_start",
    BOT_STOP: "bot_stop",
    MINT_GATE_FAILED: "mint_gate_failed",
    MINT_SUBMITTED: "mint_submitted",
    RPC_ERROR: "rpc_error",
    CHECKPOINT_ADVANCED: "checkpoint_advanced",
    PIPELINE_MODE_ENABLED: "pipeline_mode_enabled",
    PIPELINE_TX_SPACING_WAIT: "pipeline_tx_spacing_wait",
    PIPELINE_PENDING_CAPACITY_AVAILABLE: "pipeline_pending_capacity_available",
    PIPELINE_PENDING_CAPACITY_FULL: "pipeline_pending_capacity_full",
    PIPELINE_TX_SUBMITTED: "pipeline_tx_submitted",
    PIPELINE_MONITOR_POLL: "pipeline_monitor_poll",
    PIPELINE_FINALIZED_RECONCILED: "pipeline_finalized_reconciled",
    PIPELINE_NONCE_ANOMALY: "pipeline_nonce_anomaly",
    PIPELINE_DUPLICATE_PREVENTED: "pipeline_duplicate_prevented",
    PIPELINE_NONCE_STATE_CHECK: "pipeline_nonce_state_check",
    PIPELINE_NONCE_STATE_RECONCILED: "pipeline_nonce_state_reconciled",
    PIPELINE_NONCE_STATE_MISMATCH: "pipeline_nonce_state_mismatch",
    RECONCILE_STARTED: "reconcile_started",
    RECONCILE_FINISHED: "reconcile_finished",
    HIGH_BURN_MODE_ENABLED: "high_burn_mode_enabled",
    HIGH_BURN_TIER_STARTED: "high_burn_tier_started",
  },
}));

// ---------------------------------------------------------------------------
// Mock fs (lock file + emergency stop)
// ---------------------------------------------------------------------------
const mockFsExistsSync = vi.fn(() => false);
const mockFsWriteFileSync = vi.fn();
const mockFsUnlinkSync = vi.fn();
const mockFsReadFileSync = vi.fn(() =>
  JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() })
);

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
  writeFileSync: (...args: unknown[]) => mockFsWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
  readFileSync: (...args: unknown[]) => mockFsReadFileSync(...args),
}));

// ---------------------------------------------------------------------------
// Mock blockScanner
// ---------------------------------------------------------------------------
const mockDecideBlock = vi.fn();

vi.mock("../src/blockScanner.js", () => ({
  decideBlock: (...args: unknown[]) => mockDecideBlock(...args),
}));

// ---------------------------------------------------------------------------
// Mock mintExecutor
// ---------------------------------------------------------------------------
const mockExecute = vi.fn();
const mockResetRunState = vi.fn();

vi.mock("../src/mintExecutor.js", () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
  resetRunState: () => mockResetRunState(),
}));

// ---------------------------------------------------------------------------
// Mock txMonitor
// ---------------------------------------------------------------------------
const mockPoll = vi.fn(() => Promise.resolve());

vi.mock("../src/txMonitor.js", () => ({
  poll: () => mockPoll(),
}));

// ---------------------------------------------------------------------------
// Mock ethClient
// ---------------------------------------------------------------------------
const mockGetWalletBalanceEth = vi.fn(() => Promise.resolve(0.01));
const mockGetWallet = vi.fn(() => ({ address: "0xWALLET" }));
const mockGetPendingNonce = vi.fn(() => Promise.resolve(5));
// getLatestNonce — may not exist yet on unfixed code; mock it returning 5
const mockGetLatestNonce = vi.fn(() => Promise.resolve(5));

vi.mock("../src/ethClient.js", () => ({
  getWalletBalanceEth: (...args: unknown[]) => mockGetWalletBalanceEth(...args),
  getWallet: () => mockGetWallet(),
  getPendingNonce: (...args: unknown[]) => mockGetPendingNonce(...args),
  getLatestNonce: (...args: unknown[]) => mockGetLatestNonce(...args),
}));

// ---------------------------------------------------------------------------
// Mock db
// ---------------------------------------------------------------------------
const mockHasPendingTx = vi.fn(() => false);
const mockGetDailyTxCount = vi.fn(() => 0);
const mockHasReviewRequiredTx = vi.fn(() => false);
const mockHasFailedTx = vi.fn(() => false);
const mockGetPendingTxCount = vi.fn(() => 0);
const mockGetUnfinalizedTxCount = vi.fn(() => 0);
// getMaxFinalizedNonce — may not exist yet on unfixed code; mock it returning 4
const mockGetMaxFinalizedNonce = vi.fn(() => 4);

vi.mock("../src/db.js", () => ({
  hasPendingTx: () => mockHasPendingTx(),
  getDailyTxCount: () => mockGetDailyTxCount(),
  hasReviewRequiredTx: () => mockHasReviewRequiredTx(),
  hasFailedTx: () => mockHasFailedTx(),
  getPendingTxCount: () => mockGetPendingTxCount(),
  getUnfinalizedTxCount: () => mockGetUnfinalizedTxCount(),
  getMaxFinalizedNonce: () => mockGetMaxFinalizedNonce(),
  insertTx: vi.fn(),
  upsertBlockResult: vi.fn(),
  recordError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock checkpoint
// ---------------------------------------------------------------------------
const mockGetCheckpoint = vi.fn(() => 18000000);
const mockAdvanceScannedBlock = vi.fn();

vi.mock("../src/checkpoint.js", () => ({
  getCheckpoint: (...args: unknown[]) => mockGetCheckpoint(...args),
  advanceScannedBlock: (...args: unknown[]) => mockAdvanceScannedBlock(...args),
  recordCheckpointError: vi.fn(),
  setCheckpoint: vi.fn(),
  initCheckpoint: vi.fn(),
  setSubmittedBlock: vi.fn(),
  setSuccessfulMintBlock: vi.fn(),
  setFinalizedTx: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  vi.resetAllMocks();

  mockFsExistsSync.mockReturnValue(false);
  mockFsWriteFileSync.mockImplementation(() => {});
  mockFsUnlinkSync.mockImplementation(() => {});

  mockDecideBlock.mockResolvedValue({ status: "beyond_current_head" });
  mockExecute.mockResolvedValue({ status: "submitted", txHash: "0xtxhash" });
  mockPoll.mockResolvedValue(undefined);
  mockGetWalletBalanceEth.mockResolvedValue(0.01);
  mockGetWallet.mockReturnValue({ address: "0xWALLET" });

  // Bug condition state:
  // pendingNonce=5, latestNonce=5, maxFinalizedNonce=4
  // → latestNonce == pendingNonce (5 == 5) ✓
  // → latestNonce >= maxFinalizedNonce + 1 (5 >= 4+1 = 5) ✓
  mockGetPendingNonce.mockResolvedValue(5);
  mockGetLatestNonce.mockResolvedValue(5);
  mockGetMaxFinalizedNonce.mockReturnValue(4);

  // No active txs — all finalized
  mockHasPendingTx.mockReturnValue(false);
  mockGetPendingTxCount.mockReturnValue(0);
  mockGetUnfinalizedTxCount.mockReturnValue(0);

  // No failed or review_required txs
  mockHasFailedTx.mockReturnValue(false);
  mockHasReviewRequiredTx.mockReturnValue(false);

  mockGetDailyTxCount.mockReturnValue(0);
  mockGetCheckpoint.mockReturnValue(18000000);
}

// ---------------------------------------------------------------------------
// Bug Condition Exploration Test
//
// Property 1: Recoverable Nonce Anomaly Session'ı Kapatmaz
// Validates: Requirements 1.1, 1.2
// ---------------------------------------------------------------------------

describe("Nonce Anomaly Recovery — Bug Condition Exploration (Property 1)", () => {
  beforeEach(resetMocks);

  /**
   * Bug Condition Exploration Test
   *
   * Setup:
   *   - state.stopNewTx = true (simulated by having nonce anomaly trigger first)
   *   - state.stopReason = "nonce_anomaly_detected"
   *   - hasPendingTx() = false (no active txs — all finalized)
   *   - hasFailedTx() = false
   *   - hasReviewRequiredTx() = false
   *   - getUnfinalizedTxCount() = 0
   *   - getPendingNonce() = 5
   *   - getLatestNonce() = 5  (latestNonce == pendingNonce ✓)
   *   - getMaxFinalizedNonce() = 4  (latestNonce >= maxFinalizedNonce+1 ✓)
   *
   * isBugCondition = true for this state.
   *
   * EXPECTED (fixed) behavior:
   *   runAutoMint() does NOT return stopReason="nonce_anomaly_detected"
   *   → session should reconcile and continue (or exit with a different reason)
   *
   * ON UNFIXED CODE:
   *   This assertion FAILS because the unfixed code returns
   *   stopReason="nonce_anomaly_detected" — proving the bug exists.
   *
   * Counterexample documented:
   *   runAutoMint() with recoverable nonce anomaly state returns
   *   stopReason="nonce_anomaly_detected" instead of continuing.
   */
  it(
    "Property 1: runAutoMint() with recoverable nonce anomaly (isBugCondition=true) " +
      "does NOT return stopReason='nonce_anomaly_detected'",
    async () => {
      // -----------------------------------------------------------------------
      // Simulate the pipeline reaching the bug condition:
      //
      // The bug is in the stopNewTx=true branch:
      //   if (state.stopNewTx) {
      //     if (!hasPendingTx()) {
      //       stopReason = state.stopReason;  // ← BUG: exits with nonce_anomaly_detected
      //       break;
      //     }
      //   }
      //
      // To trigger this path we need:
      //   1. state.stopNewTx = true (set when nonce anomaly detected with activeTxCount > 0)
      //   2. hasPendingTx() = false (all txs finalized)
      //
      // Iteration sequence:
      //   Iter 1: capacity ok, nonce=5 → tx submitted (lastSubmittedNonce=5)
      //   Iter 2: capacity ok (pendingCount=1), nonce=4 AND activeTxCount=1
      //           → real anomaly → state.stopNewTx=true, state.stopReason="nonce_anomaly_detected"
      //           → continue (no break yet)
      //   Iter 3: state.stopNewTx=true → monitor-only branch
      //           hasPendingTx()=false → BUG: exits with nonce_anomaly_detected
      //           EXPECTED (fixed): reconcile attempted, stopNewTx=false, loop continues
      //   Iter 4 (fixed only): nonce=5 → tx submitted
      //   Iter 5 (fixed only): beyond_current_head → loop exits normally
      // -----------------------------------------------------------------------

      // Track call counts to correctly sequence mock returns.
      // In iter 1: getPendingTxCount() called once (capacity), getUnfinalizedTxCount() called twice
      //            (capacity + nonce check debug log), getPendingNonce() called once
      // In iter 2: getPendingTxCount() called once (capacity), getUnfinalizedTxCount() called twice
      //            (capacity + nonce check activeTxCount), getPendingNonce() called once
      // In iter 3: state.stopNewTx=true → hasPendingTx() called → bug triggers

      // getPendingTxCount sequence:
      //   iter 1 capacity: 0 (below limit → ok)
      //   iter 2 capacity: 1 (below limit of 3 → ok, so nonce check is reached)
      //   iter 3+: 0
      mockGetPendingTxCount
        .mockReturnValueOnce(0) // iter 1: capacity
        .mockReturnValueOnce(1) // iter 2: capacity (1 pending, below max=3 → ok)
        .mockReturnValue(0); // iter 3+

      // getUnfinalizedTxCount sequence:
      //   iter 1 capacity: 0
      //   iter 1 nonce debug: 0
      //   iter 2 capacity: 1 (below max=10 → ok)
      //   iter 2 nonce debug: 1
      //   iter 2 nonce anomaly check (activeTxCount): 1 → real anomaly!
      //   iter 3+: 0
      mockGetUnfinalizedTxCount
        .mockReturnValueOnce(0) // iter 1: capacity
        .mockReturnValueOnce(0) // iter 1: nonce debug log
        .mockReturnValueOnce(1) // iter 2: capacity
        .mockReturnValueOnce(1) // iter 2: nonce debug log
        .mockReturnValueOnce(1) // iter 2: activeTxCount check → real anomaly
        .mockReturnValue(0); // iter 3+: all finalized

      // getPendingNonce sequence:
      //   iter 1: 5 → no anomaly (lastSubmittedNonce undefined)
      //   iter 2: 4 → anomaly (4 < lastSubmittedNonce+1 = 6)
      //   iter 3 (reconcile, fixed code only): 5
      //   iter 4 (fixed code only): 5
      mockGetPendingNonce
        .mockResolvedValueOnce(5) // iter 1: ok
        .mockResolvedValueOnce(4) // iter 2: anomaly trigger
        .mockResolvedValue(5); // iter 3+ (reconcile + normal)

      // getLatestNonce (used by fixed code in reconcile):
      //   latestNonce=5 == pendingNonce=5 ✓
      //   latestNonce=5 >= maxFinalizedNonce+1=5 ✓
      mockGetLatestNonce.mockResolvedValue(5);

      // maxFinalizedNonce=4 → latestNonce(5) >= 4+1=5 ✓
      mockGetMaxFinalizedNonce.mockReturnValue(4);

      // hasPendingTx: false throughout (all txs finalized when stopNewTx check runs)
      mockHasPendingTx.mockReturnValue(false);

      // No failed or review_required txs
      mockHasFailedTx.mockReturnValue(false);
      mockHasReviewRequiredTx.mockReturnValue(false);

      // Block decisions:
      //   iter 1: mintable → tx submitted
      //   iter 2: anomaly detected → stopNewTx=true, continue (no decideBlock)
      //   iter 3: stopNewTx=true → monitor-only (no decideBlock)
      //   iter 4 (fixed only): mintable → tx submitted
      //   iter 5 (fixed only): beyond_current_head → exit
      mockDecideBlock
        .mockResolvedValueOnce({
          status: "mintable" as const,
          block: 18000000,
          feeRequired: false,
          edmtStatusConfirmed: true,
          burnGwei: 100n,
        })
        .mockResolvedValueOnce({
          status: "mintable" as const,
          block: 18000001,
          feeRequired: false,
          edmtStatusConfirmed: true,
          burnGwei: 100n,
        })
        .mockResolvedValue({ status: "beyond_current_head" });

      mockExecute.mockResolvedValue({ status: "submitted", txHash: "0xtxhash" });

      const { runAutoMint } = await import("../src/autoMintRunner.js");
      const report = await runAutoMint();

      // -----------------------------------------------------------------------
      // ASSERTION: The fixed code should NOT return nonce_anomaly_detected
      // when the bug condition holds (recoverable anomaly).
      //
      // ON UNFIXED CODE: This assertion FAILS.
      // The unfixed code returns stopReason="nonce_anomaly_detected" because
      // the stopNewTx=true + !hasPendingTx() path exits immediately without
      // attempting nonce reconcile.
      //
      // Counterexample: report.stopReason === "nonce_anomaly_detected"
      // -----------------------------------------------------------------------
      expect(report.stopReason).not.toBe("nonce_anomaly_detected");
    }
  );
});
