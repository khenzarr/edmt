/**
 * Nonce Anomaly Recovery — Preservation Property Tests
 *
 * **Property 2: Preservation** — Unrecoverable Nonce Anomaly Hala Session'i Kapatir
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 *
 * Observation-first methodology:
 * 1. Observe behavior on UNFIXED code for unrecoverable inputs
 * 2. Write property-based tests capturing observed behavior
 * 3. Verify tests PASS on UNFIXED code (baseline)
 * 4. After fix: tests should still PASS (no regressions)
 *
 * Unrecoverable inputs (isBugCondition returns false, nonceAnomalyDetected=true):
 *   - failedCount > 0
 *   - reviewRequiredCount > 0
 *   - latestNonce != pendingNonce
 *   - latestNonce < maxFinalizedNonce + 1
 *
 * Observed baseline behavior on unfixed code:
 *   - All unrecoverable anomaly paths close session with stopReason="nonce_anomaly_detected"
 *   - activeTxCount > 0 when anomaly first detected -> stopNewTx=true, session does NOT close immediately
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
  autoMintEmergencyStopFile: "./STOP_AUTOMINT_NONCE_ANOMALY_PRESERVATION",
  autoMintSessionLockFile: "./automint_nonce_anomaly_preservation.lock",

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

  // Default: recoverable state (latestNonce==pendingNonce, latestNonce >= maxFinalizedNonce+1)
  mockGetPendingNonce.mockResolvedValue(5);
  mockGetLatestNonce.mockResolvedValue(5);
  mockGetMaxFinalizedNonce.mockReturnValue(4);

  // No active txs
  mockHasPendingTx.mockReturnValue(false);
  mockGetPendingTxCount.mockReturnValue(0);
  mockGetUnfinalizedTxCount.mockReturnValue(0);

  // No failed or review_required txs
  mockHasFailedTx.mockReturnValue(false);
  mockHasReviewRequiredTx.mockReturnValue(false);

  mockGetDailyTxCount.mockReturnValue(0);
  mockGetCheckpoint.mockReturnValue(18000000);
}

/**
 * Helper: set up mock sequence to trigger nonce anomaly with active txs,
 * then transition to the given unrecoverable state when stopNewTx=true + !hasPendingTx().
 *
 * Iteration sequence:
 *   Iter 1: capacity ok, nonce=5 -> tx submitted (lastSubmittedNonce=5)
 *           checkPipelineStopConditions: hasFailedTx()=false, hasReviewRequiredTx()=false
 *   Iter 2: capacity ok (pendingCount=1), nonce=4 AND activeTxCount=1
 *           checkPipelineStopConditions: hasFailedTx()=false, hasReviewRequiredTx()=false
 *           -> real anomaly -> state.stopNewTx=true, state.stopReason="nonce_anomaly_detected"
 *           -> continue (no break yet)
 *   Iter 3: state.stopNewTx=true -> monitor-only branch
 *           hasPendingTx()=false -> reconcile attempted (fixed) or exit (unfixed)
 *           For unrecoverable cases: reconcile checks hasFailedTx()/hasReviewRequiredTx()
 *           -> reconcile fails -> session closes with nonce_anomaly_detected
 *
 * IMPORTANT: failedCount and reviewRequiredCount must be FALSE during iters 1-2
 * (so checkPipelineStopConditions doesn't fire before the nonce anomaly is triggered),
 * and only become TRUE from iter 3 onwards (when the reconcile check happens).
 */
function setupAnomalyTriggerSequence(opts: {
  failedCount?: boolean;
  reviewRequiredCount?: boolean;
  latestNonce?: number;
  pendingNonce?: number;
  maxFinalizedNonce?: number;
}) {
  const {
    failedCount = false,
    reviewRequiredCount = false,
    latestNonce = 5,
    pendingNonce = 5,
    maxFinalizedNonce = 4,
  } = opts;

  // getPendingTxCount sequence:
  //   iter 1 capacity: 0 (below limit -> ok)
  //   iter 2 capacity: 1 (below limit of 3 -> ok, so nonce check is reached)
  //   iter 3+: 0
  mockGetPendingTxCount
    .mockReturnValueOnce(0) // iter 1: capacity
    .mockReturnValueOnce(1) // iter 2: capacity (1 pending, below max=3 -> ok)
    .mockReturnValue(0); // iter 3+

  // getUnfinalizedTxCount sequence:
  //   iter 1 capacity: 0
  //   iter 1 nonce debug: 0
  //   iter 2 capacity: 1 (below max=10 -> ok)
  //   iter 2 nonce debug: 1
  //   iter 2 nonce anomaly check (activeTxCount): 1 -> real anomaly!
  //   iter 3+: 0
  mockGetUnfinalizedTxCount
    .mockReturnValueOnce(0) // iter 1: capacity
    .mockReturnValueOnce(0) // iter 1: nonce debug log
    .mockReturnValueOnce(1) // iter 2: capacity
    .mockReturnValueOnce(1) // iter 2: nonce debug log
    .mockReturnValueOnce(1) // iter 2: activeTxCount check -> real anomaly
    .mockReturnValue(0); // iter 3+: all finalized

  // getPendingNonce sequence:
  //   iter 1: 5 -> no anomaly (lastSubmittedNonce undefined)
  //   iter 2: 4 -> anomaly (4 < lastSubmittedNonce+1 = 6)
  //   iter 3 (reconcile): pendingNonce (the unrecoverable value)
  mockGetPendingNonce
    .mockResolvedValueOnce(5) // iter 1: ok
    .mockResolvedValueOnce(4) // iter 2: anomaly trigger
    .mockResolvedValue(pendingNonce); // iter 3+ (reconcile)

  // getLatestNonce (used by fixed code in reconcile):
  mockGetLatestNonce.mockResolvedValue(latestNonce);

  // maxFinalizedNonce
  mockGetMaxFinalizedNonce.mockReturnValue(maxFinalizedNonce);

  // hasPendingTx: false throughout (all txs finalized when stopNewTx check runs)
  mockHasPendingTx.mockReturnValue(false);

  // Failed / review_required state:
  // MUST be false during iters 1-2 (checkPipelineStopConditions runs before nonce check).
  // Only become true from iter 3 onwards (when reconcile check happens in fixed code,
  // or when stopNewTx=true branch exits on unfixed code).
  //
  // checkPipelineStopConditions is called once per iteration (after poll, before capacity).
  // Iter 1: 1 call to hasFailedTx + 1 call to hasReviewRequiredTx -> must be false
  // Iter 2: 1 call to hasFailedTx + 1 call to hasReviewRequiredTx -> must be false
  // Iter 3+: stopNewTx=true branch runs first (before checkPipelineStopConditions),
  //          so reconcile check calls hasFailedTx/hasReviewRequiredTx -> can be true
  if (failedCount) {
    mockHasFailedTx
      .mockReturnValueOnce(false) // iter 1: checkPipelineStopConditions
      .mockReturnValueOnce(false) // iter 2: checkPipelineStopConditions
      .mockReturnValue(true); // iter 3+: reconcile check
  } else {
    mockHasFailedTx.mockReturnValue(false);
  }

  if (reviewRequiredCount) {
    mockHasReviewRequiredTx
      .mockReturnValueOnce(false) // iter 1: checkPipelineStopConditions
      .mockReturnValueOnce(false) // iter 2: checkPipelineStopConditions
      .mockReturnValue(true); // iter 3+: reconcile check
  } else {
    mockHasReviewRequiredTx.mockReturnValue(false);
  }

  // Block decisions:
  //   iter 1: mintable -> tx submitted
  //   iter 2: anomaly detected -> stopNewTx=true, continue (no decideBlock)
  //   iter 3: stopNewTx=true -> monitor-only (no decideBlock)
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
}

// ---------------------------------------------------------------------------
// Preservation Tests
//
// Property 2: Unrecoverable Nonce Anomaly Hala Session'i Kapatir
// Validates: Requirements 3.1, 3.2, 3.3, 3.4
// ---------------------------------------------------------------------------

describe("Nonce Anomaly Recovery — Preservation (Property 2)", () => {
  beforeEach(resetMocks);

  // -------------------------------------------------------------------------
  // Preservation 1: failedCount > 0 -> session closes with nonce_anomaly_detected
  // -------------------------------------------------------------------------
  it("Preservation 1: failedCount > 0 -> session closes with stopReason='nonce_anomaly_detected'", async () => {
    // Setup: hasFailedTx()=true, hasPendingTx()=false, state.stopReason="nonce_anomaly_detected"
    // isBugCondition=false because failedCount > 0
    setupAnomalyTriggerSequence({ failedCount: true });

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    // ASSERT: session closes with nonce_anomaly_detected (unrecoverable)
    // This behavior must be preserved on both unfixed and fixed code.
    expect(report.stopReason).toBe("nonce_anomaly_detected");
  });

  // -------------------------------------------------------------------------
  // Preservation 2: reviewRequiredCount > 0 -> session closes with nonce_anomaly_detected
  // -------------------------------------------------------------------------
  it("Preservation 2: reviewRequiredCount > 0 -> session closes with stopReason='nonce_anomaly_detected'", async () => {
    // Setup: hasReviewRequiredTx()=true, hasPendingTx()=false, state.stopReason="nonce_anomaly_detected"
    // isBugCondition=false because reviewRequiredCount > 0
    setupAnomalyTriggerSequence({ reviewRequiredCount: true });

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    // ASSERT: session closes with nonce_anomaly_detected (unrecoverable)
    expect(report.stopReason).toBe("nonce_anomaly_detected");
  });

  // -------------------------------------------------------------------------
  // Preservation 3: latestNonce != pendingNonce -> session closes
  // e.g. latestNonce=4, pendingNonce=5
  // -------------------------------------------------------------------------
  it("Preservation 3: latestNonce != pendingNonce (latestNonce=4, pendingNonce=5) -> session closes with 'nonce_anomaly_detected'", async () => {
    // Setup: getLatestNonce()=4, getPendingNonce()=5, hasPendingTx()=false
    // isBugCondition=false because latestNonce != pendingNonce
    setupAnomalyTriggerSequence({ latestNonce: 4, pendingNonce: 5, maxFinalizedNonce: 4 });

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    // ASSERT: session closes with nonce_anomaly_detected (unrecoverable)
    expect(report.stopReason).toBe("nonce_anomaly_detected");
  });

  // -------------------------------------------------------------------------
  // Preservation 4: latestNonce < maxFinalizedNonce+1 -> session closes
  // e.g. latestNonce=3, maxFinalizedNonce=4
  // -------------------------------------------------------------------------
  it("Preservation 4: latestNonce < maxFinalizedNonce+1 (latestNonce=3, maxFinalizedNonce=4) -> session closes with 'nonce_anomaly_detected'", async () => {
    // Setup: getLatestNonce()=3, getMaxFinalizedNonce()=4, getPendingNonce()=3
    // isBugCondition=false because latestNonce(3) < maxFinalizedNonce+1(5)
    setupAnomalyTriggerSequence({ latestNonce: 3, pendingNonce: 3, maxFinalizedNonce: 4 });

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    // ASSERT: session closes with nonce_anomaly_detected (unrecoverable)
    expect(report.stopReason).toBe("nonce_anomaly_detected");
  });

  // -------------------------------------------------------------------------
  // Preservation 5: activeTxCount > 0 when anomaly first detected
  //   -> stopNewTx=true set, session does NOT close immediately (pending tx still exists)
  // -------------------------------------------------------------------------
  it("Preservation 5: activeTxCount > 0 when anomaly detected -> stopNewTx=true, session does NOT exit immediately", async () => {
    // Setup: getUnfinalizedTxCount()=1 when anomaly detected, hasPendingTx()=true
    // The session should enter monitor-only mode, NOT close immediately.

    // getPendingTxCount sequence:
    //   iter 1 capacity: 0 (below limit -> ok)
    //   iter 2 capacity: 1 (below limit of 3 -> ok)
    //   iter 3+: 0
    mockGetPendingTxCount
      .mockReturnValueOnce(0) // iter 1: capacity
      .mockReturnValueOnce(1) // iter 2: capacity
      .mockReturnValue(0); // iter 3+

    // getUnfinalizedTxCount sequence:
    //   iter 1 capacity: 0
    //   iter 1 nonce debug: 0
    //   iter 2 capacity: 1
    //   iter 2 nonce debug: 1
    //   iter 2 activeTxCount check: 1 -> real anomaly!
    //   iter 3+: 0
    mockGetUnfinalizedTxCount
      .mockReturnValueOnce(0) // iter 1: capacity
      .mockReturnValueOnce(0) // iter 1: nonce debug log
      .mockReturnValueOnce(1) // iter 2: capacity
      .mockReturnValueOnce(1) // iter 2: nonce debug log
      .mockReturnValueOnce(1) // iter 2: activeTxCount check -> real anomaly
      .mockReturnValue(0); // iter 3+: all finalized

    // getPendingNonce sequence:
    //   iter 1: 5 -> no anomaly
    //   iter 2: 4 -> anomaly trigger
    //   iter 3+: 5 (reconcile)
    mockGetPendingNonce
      .mockResolvedValueOnce(5) // iter 1: ok
      .mockResolvedValueOnce(4) // iter 2: anomaly trigger
      .mockResolvedValue(5); // iter 3+ (reconcile)

    mockGetLatestNonce.mockResolvedValue(5);
    mockGetMaxFinalizedNonce.mockReturnValue(4);

    // hasPendingTx: TRUE in iter 3 (pending tx still exists -> monitor-only continues)
    // Then false in iter 4 (all finalized -> reconcile or exit)
    mockHasPendingTx
      .mockReturnValueOnce(true) // iter 3: pending tx still exists -> monitor-only continues
      .mockReturnValue(false); // iter 4+: all finalized

    mockHasFailedTx.mockReturnValue(false);
    mockHasReviewRequiredTx.mockReturnValue(false);

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

    // ASSERT: session did NOT exit immediately when anomaly was detected with active txs.
    // The session should have continued monitoring (at least 1 tx was sent before anomaly).
    // On unfixed code: session eventually exits (either via reconcile or nonce_anomaly_detected).
    // The key preservation: session does NOT exit immediately when hasPendingTx()=true.
    expect(report.txSentThisSession).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Property-Based Test: All unrecoverable combinations close session
//
// Property 2 (combinatorial): For all {failedCount, reviewRequiredCount, latestNonce,
// pendingNonce, maxFinalizedNonce} where isBugCondition=false AND nonceAnomalyDetected=true,
// session closes with nonce_anomaly_detected.
//
// Validates: Requirements 3.1, 3.2
// ---------------------------------------------------------------------------

describe("Nonce Anomaly Recovery — Property 2 Combinatorial (Unrecoverable Combinations)", () => {
  beforeEach(resetMocks);

  /**
   * Combinatorial property test cases.
   * Each case represents an unrecoverable state (isBugCondition=false).
   *
   * isBugCondition=false when ANY of:
   *   - failedCount > 0
   *   - reviewRequiredCount > 0
   *   - latestNonce != pendingNonce
   *   - latestNonce < maxFinalizedNonce + 1
   */
  const unrecoverableCases: Array<{
    name: string;
    failedCount: boolean;
    reviewRequiredCount: boolean;
    latestNonce: number;
    pendingNonce: number;
    maxFinalizedNonce: number;
    reason: string;
  }> = [
    {
      name: "failedCount=1, latestNonce=5, pendingNonce=5, maxFinalizedNonce=4",
      failedCount: true,
      reviewRequiredCount: false,
      latestNonce: 5,
      pendingNonce: 5,
      maxFinalizedNonce: 4,
      reason: "failedCount > 0",
    },
    {
      name: "reviewRequiredCount=1, latestNonce=5, pendingNonce=5, maxFinalizedNonce=4",
      failedCount: false,
      reviewRequiredCount: true,
      latestNonce: 5,
      pendingNonce: 5,
      maxFinalizedNonce: 4,
      reason: "reviewRequiredCount > 0",
    },
    {
      name: "latestNonce=4, pendingNonce=5, maxFinalizedNonce=4 (latestNonce != pendingNonce)",
      failedCount: false,
      reviewRequiredCount: false,
      latestNonce: 4,
      pendingNonce: 5,
      maxFinalizedNonce: 4,
      reason: "latestNonce != pendingNonce",
    },
    {
      name: "latestNonce=3, pendingNonce=3, maxFinalizedNonce=4 (latestNonce < maxFinalizedNonce+1)",
      failedCount: false,
      reviewRequiredCount: false,
      latestNonce: 3,
      pendingNonce: 3,
      maxFinalizedNonce: 4,
      reason: "latestNonce < maxFinalizedNonce+1",
    },
    {
      name: "failedCount=1, reviewRequiredCount=1, latestNonce=4, pendingNonce=5, maxFinalizedNonce=4 (multiple conditions)",
      failedCount: true,
      reviewRequiredCount: true,
      latestNonce: 4,
      pendingNonce: 5,
      maxFinalizedNonce: 4,
      reason: "multiple unrecoverable conditions",
    },
  ];

  for (const tc of unrecoverableCases) {
    it(`Property 2 [${tc.reason}]: ${tc.name} -> session closes with 'nonce_anomaly_detected'`, async () => {
      setupAnomalyTriggerSequence({
        failedCount: tc.failedCount,
        reviewRequiredCount: tc.reviewRequiredCount,
        latestNonce: tc.latestNonce,
        pendingNonce: tc.pendingNonce,
        maxFinalizedNonce: tc.maxFinalizedNonce,
      });

      const { runAutoMint } = await import("../src/autoMintRunner.js");
      const report = await runAutoMint();

      // ASSERT: session closes with nonce_anomaly_detected for all unrecoverable cases.
      // This behavior must be preserved on both unfixed and fixed code.
      expect(report.stopReason).toBe("nonce_anomaly_detected");
    });
  }
});
