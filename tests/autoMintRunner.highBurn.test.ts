/**
 * AutoMintRunner — High Burn Priority Mode integration tests
 *
 * Tests:
 *  - HIGH_BURN_ON_EXHAUSTED=fallback_sequential → decideBlock() called
 *  - HIGH_BURN_ON_EXHAUSTED=stop → session stops
 *  - Pipeline mode + high burn candidate → execute() called with pipelineMode:true
 *  - Duplicate prevention works in high burn mode
 *  - HIGH_BURN_PRIORITY_MODE=false regression → existing behavior unchanged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mutable config
// ---------------------------------------------------------------------------
const mockConfig = {
  // Core
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
  autoMintRequireHotWalletBalanceMaxEth: 0.15,
  autoMintStopOnFirstError: false,
  autoMintStopOnReviewRequired: true,
  autoMintStopOnFeeRequired: false,
  autoMintOnlyNoFeeBlocks: true,
  autoMintAllowedStartBlock: undefined as number | undefined,
  autoMintAllowedStopBlock: undefined as number | undefined,
  autoMintCooldownAfterTxMs: 0,
  autoMintEmergencyStopFile: "./STOP_AUTOMINT_HB_TEST",
  autoMintSessionLockFile: "./automint_hb_test.lock",
  allowMultiplePendingTx: false,
  requireManualConfirmationForFirstTx: false,
  startBlock: 18000000,
  // Pipeline
  autoMintPipelineMode: true,
  autoMintMaxPendingTxs: 3,
  autoMintMaxUnfinalizedTxs: 10,
  autoMintTxSpacingMs: 0,
  autoMintStopOnPendingTxFailure: true,
  autoMintReconcileIntervalMs: 0,
  autoMintRequireIncludedBeforeNextTx: false,
  // High burn
  highBurnPriorityMode: true,
  highBurnActiveTierEth: 4,
  highBurnMinEthTiers: [100, 90, 50, 20, 10, 5, 4, 3, 2, 1, 0.5, 0.25, 0.1],
  highBurnOnlyNoFee: true,
  highBurnOnlyMintable: true,
  highBurnUnknownRetryMinutes: 30,
  highBurnOnExhausted: "fallback_sequential" as "fallback_sequential" | "wait" | "stop",
};

vi.mock("../src/config.js", () => ({
  get config() {
    return mockConfig;
  },
  isLiveMintEnabled: () => !mockConfig.dryRun && mockConfig.enableLiveMint,
  hasPrivateKey: () => mockConfig.privateKey.length > 0,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LogEvent: {
    BOT_START: "bot_start",
    BOT_STOP: "bot_stop",
    MINT_GATE_FAILED: "mint_gate_failed",
    MINT_SUBMITTED: "mint_submitted",
    RPC_ERROR: "rpc_error",
    CHECKPOINT_ADVANCED: "checkpoint_advanced",
    PIPELINE_MODE_ENABLED: "pipeline_mode_enabled",
    PIPELINE_MONITOR_POLL: "pipeline_monitor_poll",
    PIPELINE_PENDING_CAPACITY_AVAILABLE: "pipeline_pending_capacity_available",
    PIPELINE_PENDING_CAPACITY_FULL: "pipeline_pending_capacity_full",
    PIPELINE_TX_SUBMITTED: "pipeline_tx_submitted",
    PIPELINE_NONCE_STATE_CHECK: "pipeline_nonce_state_check",
    PIPELINE_NONCE_STATE_RECONCILED: "pipeline_nonce_state_reconciled",
    PIPELINE_NONCE_STATE_MISMATCH: "pipeline_nonce_state_mismatch",
    PIPELINE_NONCE_ANOMALY: "pipeline_nonce_anomaly",
    HIGH_BURN_MODE_ENABLED: "high_burn_mode_enabled",
    HIGH_BURN_CANDIDATE_SUBMITTED: "high_burn_candidate_submitted",
    HIGH_BURN_CANDIDATE_SELECTED: "high_burn_candidate_selected",
    HIGH_BURN_CANDIDATE_MINTED_ELSEWHERE: "high_burn_candidate_minted_elsewhere",
    HIGH_BURN_TIER_STARTED: "high_burn_tier_started",
    HIGH_BURN_TIER_EXHAUSTED: "high_burn_tier_exhausted",
    HIGH_BURN_TIER_DOWNGRADED: "high_burn_tier_downgraded",
    HIGH_BURN_ALL_TIERS_EXHAUSTED: "high_burn_all_tiers_exhausted",
    BLOCK_NOT_ELIGIBLE: "block_not_eligible",
    BLOCK_UNKNOWN: "block_unknown",
    PIPELINE_TX_SPACING_WAIT: "pipeline_tx_spacing_wait",
    PIPELINE_DUPLICATE_PREVENTED: "pipeline_duplicate_prevented",
  },
}));

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

const mockDecideBlock = vi.fn();
vi.mock("../src/blockScanner.js", () => ({
  decideBlock: (...args: unknown[]) => mockDecideBlock(...args),
}));

const mockExecute = vi.fn();
const mockResetRunState = vi.fn();
vi.mock("../src/mintExecutor.js", () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
  resetRunState: () => mockResetRunState(),
}));

const mockPoll = vi.fn(() => Promise.resolve());
vi.mock("../src/txMonitor.js", () => ({
  poll: () => mockPoll(),
}));

const mockGetWalletBalanceEth = vi.fn(() => Promise.resolve(0.01));
const mockGetWallet = vi.fn(() => ({ address: "0xWALLET" }));
const mockGetPendingNonce = vi.fn(() => Promise.resolve(5));
vi.mock("../src/ethClient.js", () => ({
  getWalletBalanceEth: (...args: unknown[]) => mockGetWalletBalanceEth(...args),
  getWallet: () => mockGetWallet(),
  getPendingNonce: (...args: unknown[]) => mockGetPendingNonce(...args),
}));

const mockHasPendingTx = vi.fn(() => false);
const mockGetDailyTxCount = vi.fn(() => 0);
const mockHasReviewRequiredTx = vi.fn(() => false);
const mockHasFailedTx = vi.fn(() => false);
const mockGetPendingTxCount = vi.fn(() => 0);
const mockGetUnfinalizedTxCount = vi.fn(() => 0);
const mockUpdateHighBurnCandidateStatus = vi.fn();
vi.mock("../src/db.js", () => ({
  hasPendingTx: () => mockHasPendingTx(),
  getDailyTxCount: () => mockGetDailyTxCount(),
  hasReviewRequiredTx: () => mockHasReviewRequiredTx(),
  hasFailedTx: () => mockHasFailedTx(),
  getPendingTxCount: () => mockGetPendingTxCount(),
  getUnfinalizedTxCount: () => mockGetUnfinalizedTxCount(),
  updateHighBurnCandidateStatus: (...args: unknown[]) => mockUpdateHighBurnCandidateStatus(...args),
  insertTx: vi.fn(),
  upsertBlockResult: vi.fn(),
  recordError: vi.fn(),
}));

const mockGetCheckpoint = vi.fn(() => 18000000);
const mockAdvanceScannedBlock = vi.fn();
const mockRecordCheckpointError = vi.fn();
vi.mock("../src/checkpoint.js", () => ({
  getCheckpoint: (...args: unknown[]) => mockGetCheckpoint(...args),
  advanceScannedBlock: (...args: unknown[]) => mockAdvanceScannedBlock(...args),
  recordCheckpointError: (...args: unknown[]) => mockRecordCheckpointError(...args),
  setCheckpoint: vi.fn(),
  initCheckpoint: vi.fn(),
  setSubmittedBlock: vi.fn(),
  setSuccessfulMintBlock: vi.fn(),
  setFinalizedTx: vi.fn(),
}));

const mockGetNextHighBurnCandidate = vi.fn();
const mockTierManagerTryDowngrade = vi.fn(() => false);
const mockTierManagerGetActiveTier = vi.fn(() => 4);
const mockTierManagerIsAllExhausted = vi.fn(() => false);

const mockTierManagerInstance = {
  getActiveTier: mockTierManagerGetActiveTier,
  tryDowngrade: mockTierManagerTryDowngrade,
  isAllExhausted: mockTierManagerIsAllExhausted,
  isTierExhausted: vi.fn(() => false),
  resetToTier: vi.fn(),
};

vi.mock("../src/highBurnSelector.js", () => ({
  getNextHighBurnCandidate: (...args: unknown[]) => mockGetNextHighBurnCandidate(...args),
  TierManager: vi.fn().mockImplementation(() => mockTierManagerInstance),
  defaultSelectorOpts: () => ({
    onlyNoFee: true,
    onlyMintable: true,
    unknownRetryMinutes: 30,
  }),
}));

// edmtClient mock — used by resolveHighBurnCandidate
const mockGetBlockStatus = vi.fn();
vi.mock("../src/edmtClient.js", () => ({
  getBlockStatus: (...args: unknown[]) => mockGetBlockStatus(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mintableCandidate = {
  block: 18000000,
  burn_gwei: "4500000000",
  burn_eth: 4.5,
  tier_eth: 4,
  status: "discovered",
  edmt_status: "mintable",
  fee_required: 0,
  attempts: 0,
};

function resetMocks() {
  vi.clearAllMocks();
  mockFsExistsSync.mockReturnValue(false);
  mockFsWriteFileSync.mockImplementation(() => {});
  mockFsUnlinkSync.mockImplementation(() => {});
  mockDecideBlock.mockResolvedValue({ status: "beyond_current_head" });
  mockExecute.mockResolvedValue({ status: "submitted", txHash: "0xtxhash" });
  mockPoll.mockResolvedValue(undefined);
  mockGetWalletBalanceEth.mockResolvedValue(0.01);
  mockGetWallet.mockReturnValue({ address: "0xWALLET" });
  mockGetPendingNonce.mockResolvedValue(5);
  mockHasPendingTx.mockReturnValue(false);
  mockGetDailyTxCount.mockReturnValue(0);
  mockHasReviewRequiredTx.mockReturnValue(false);
  mockHasFailedTx.mockReturnValue(false);
  mockGetPendingTxCount.mockReturnValue(0);
  mockGetUnfinalizedTxCount.mockReturnValue(0);
  mockGetCheckpoint.mockReturnValue(18000000);
  mockGetNextHighBurnCandidate.mockReturnValue(null);
  mockTierManagerTryDowngrade.mockReturnValue(false);
  mockTierManagerGetActiveTier.mockReturnValue(4);
  mockTierManagerIsAllExhausted.mockReturnValue(false);
  // Default: EDMT API returns mintable + confirmed
  mockGetBlockStatus.mockResolvedValue({
    block: 18000000,
    status: "mintable",
    burnGwei: 4500000000n,
    feeRequired: false,
    edmtStatusConfirmed: true,
  });

  mockConfig.dryRun = false;
  mockConfig.enableLiveMint = true;
  mockConfig.privateKey = "0xdeadbeef";
  mockConfig.unattendedAutoMint = true;
  mockConfig.autoMintMaxTxPerSession = 999;
  mockConfig.autoMintMaxTxPerDay = 999;
  mockConfig.autoMintMaxRuntimeMinutes = 0;
  mockConfig.autoMintPollIntervalMs = 0;
  mockConfig.autoMintReconcileIntervalMs = 0;
  mockConfig.autoMintTxSpacingMs = 0;
  mockConfig.autoMintPipelineMode = true;
  mockConfig.autoMintMaxPendingTxs = 3;
  mockConfig.autoMintMaxUnfinalizedTxs = 10;
  mockConfig.highBurnPriorityMode = true;
  mockConfig.highBurnActiveTierEth = 4;
  mockConfig.highBurnOnExhausted = "fallback_sequential";
  mockConfig.highBurnOnlyNoFee = true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HighBurnRunner — integration tests", () => {
  beforeEach(resetMocks);
  afterEach(() => vi.useRealTimers());

  it("HIGH_BURN_ON_EXHAUSTED=fallback_sequential → decideBlock() called when all tiers exhausted", async () => {
    mockConfig.highBurnOnExhausted = "fallback_sequential";
    // No high burn candidate available, tier downgrade fails (all exhausted)
    mockGetNextHighBurnCandidate.mockReturnValue(null);
    mockTierManagerTryDowngrade.mockReturnValue(false); // all exhausted
    // Fallback: decideBlock returns beyond_current_head → loop exits
    mockDecideBlock.mockResolvedValue({ status: "beyond_current_head" });

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    expect(mockDecideBlock).toHaveBeenCalled();
    expect(report.txSentThisSession).toBe(0);
  });

  it("HIGH_BURN_ON_EXHAUSTED=stop → session stops with high_burn_all_tiers_exhausted", async () => {
    mockConfig.highBurnOnExhausted = "stop";
    mockGetNextHighBurnCandidate.mockReturnValue(null);
    mockTierManagerTryDowngrade.mockReturnValue(false); // all exhausted

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    expect(report.stopReason).toBe("high_burn_all_tiers_exhausted");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("pipeline mode + high burn candidate → execute() called with pipelineMode:true", async () => {
    mockConfig.highBurnPriorityMode = true;
    mockConfig.autoMintPipelineMode = true;
    mockConfig.autoMintMaxTxPerSession = 1;

    mockGetNextHighBurnCandidate.mockReturnValue(mintableCandidate);
    mockGetBlockStatus.mockResolvedValue({
      block: 18000000,
      status: "mintable",
      burnGwei: 4500000000n,
      feeRequired: false,
      edmtStatusConfirmed: true,
    });
    mockExecute.mockResolvedValue({ status: "submitted", txHash: "0xtx_hb" });

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ block: 18000000, status: "mintable", edmtStatusConfirmed: true }),
      expect.objectContaining({ pipelineMode: true })
    );
    expect(report.txSentThisSession).toBe(1);
  });

  it("after tx submitted, updateHighBurnCandidateStatus called with 'submitted'", async () => {
    mockConfig.autoMintMaxTxPerSession = 1;
    mockGetNextHighBurnCandidate.mockReturnValue(mintableCandidate);
    mockGetBlockStatus.mockResolvedValue({
      block: 18000000,
      status: "mintable",
      burnGwei: 4500000000n,
      feeRequired: false,
      edmtStatusConfirmed: true,
    });
    mockExecute.mockResolvedValue({ status: "submitted", txHash: "0xtx_status" });

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    await runAutoMint();

    expect(mockUpdateHighBurnCandidateStatus).toHaveBeenCalledWith(18000000, "submitted");
  });

  it("duplicate prevention: execute returns skipped_duplicate_tx → txSentThisSession stays 0", async () => {
    mockGetNextHighBurnCandidate.mockReturnValue(mintableCandidate);
    mockGetBlockStatus.mockResolvedValue({
      block: 18000000,
      status: "mintable",
      burnGwei: 4500000000n,
      feeRequired: false,
      edmtStatusConfirmed: true,
    });
    mockExecute.mockResolvedValue({ status: "skipped_duplicate_tx", block: 18000000 });
    mockGetNextHighBurnCandidate.mockReturnValueOnce(mintableCandidate).mockReturnValue(null);
    mockTierManagerTryDowngrade.mockReturnValue(false);
    mockConfig.highBurnOnExhausted = "stop";

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    expect(report.txSentThisSession).toBe(0);
  });

  it("HIGH_BURN_PRIORITY_MODE=false regression — sequential behavior unchanged", async () => {
    mockConfig.highBurnPriorityMode = false;
    mockConfig.autoMintPipelineMode = false;
    mockConfig.allowMultiplePendingTx = false;

    mockHasPendingTx.mockReturnValueOnce(true).mockReturnValue(false);
    mockDecideBlock
      .mockResolvedValueOnce({
        status: "mintable",
        block: 18000000,
        feeRequired: false,
        edmtStatusConfirmed: true,
        burnGwei: 100n,
      })
      .mockResolvedValue({ status: "beyond_current_head" });
    mockExecute.mockResolvedValue({ status: "submitted", txHash: "0xtx_seq" });

    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();

    // High burn candidate selector should NOT have been called
    expect(mockGetNextHighBurnCandidate).not.toHaveBeenCalled();
    // Sequential mode: tx sent after pending cleared
    expect(report.txSentThisSession).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveHighBurnCandidate — EDMT status validation tests
// ---------------------------------------------------------------------------

describe("resolveHighBurnCandidate — EDMT status validation", () => {
  beforeEach(resetMocks);

  const baseCandidate = {
    block: 13000072,
    burn_gwei: "49742769523",
    burn_eth: 49.742769523,
    tier_eth: 20,
    fee_required: null as number | null,
    edmt_status: null as string | null,
    attempts: 0,
  };

  it("edmtStatusConfirmed=false → action=unknown, status updated to unknown, no mint", async () => {
    mockGetBlockStatus.mockResolvedValue({
      block: 13000072,
      status: "unknown",
      edmtStatusConfirmed: false,
      reason: "EDMT API unavailable",
    });

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    const result = await resolveHighBurnCandidate(baseCandidate, "test-session");

    expect(result.action).toBe("unknown");
    expect(mockUpdateHighBurnCandidateStatus).toHaveBeenCalledWith(
      13000072,
      "unknown",
      expect.objectContaining({ skip_reason: "edmt_status_unconfirmed" })
    );
  });

  it("edmtStatusConfirmed=false → 'proceed' is NEVER returned", async () => {
    mockGetBlockStatus.mockResolvedValue({
      block: 13000072,
      status: "mintable",
      edmtStatusConfirmed: false, // unconfirmed even if status=mintable
    });

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    const result = await resolveHighBurnCandidate(baseCandidate, "test-session");

    expect(result.action).not.toBe("proceed");
    expect(result.action).toBe("unknown");
  });

  it("status=minted → action=exhaust, candidate marked minted_elsewhere with owner", async () => {
    mockGetBlockStatus.mockResolvedValue({
      block: 13000072,
      status: "minted",
      edmtStatusConfirmed: true,
      owner: "0xSomeOwner",
      mintTx: "0xSomeTx",
    });

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    const result = await resolveHighBurnCandidate(baseCandidate, "test-session");

    expect(result.action).toBe("exhaust");
    expect(mockUpdateHighBurnCandidateStatus).toHaveBeenCalledWith(
      13000072,
      "minted_elsewhere",
      expect.objectContaining({ minted_by: "0xSomeOwner", mint_tx_hash: "0xSomeTx" })
    );
  });

  it("status=not_eligible → action=exhaust, candidate marked not_eligible", async () => {
    mockGetBlockStatus.mockResolvedValue({
      block: 13000072,
      status: "not_eligible",
      edmtStatusConfirmed: true,
      reason: "api_not_mintable",
    });

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    const result = await resolveHighBurnCandidate(baseCandidate, "test-session");

    expect(result.action).toBe("exhaust");
    expect(mockUpdateHighBurnCandidateStatus).toHaveBeenCalledWith(
      13000072,
      "not_eligible",
      expect.objectContaining({ edmt_status: "not_eligible" })
    );
  });

  it("status=mintable + edmtStatusConfirmed=true + feeRequired=false → action=proceed", async () => {
    mockGetBlockStatus.mockResolvedValue({
      block: 13000072,
      status: "mintable",
      burnGwei: 49742769523n,
      feeRequired: false,
      edmtStatusConfirmed: true,
    });

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    const result = await resolveHighBurnCandidate(baseCandidate, "test-session");

    expect(result.action).toBe("proceed");
    if (result.action === "proceed") {
      expect(result.blockResult.edmtStatusConfirmed).toBe(true);
      expect(result.blockResult.status).toBe("mintable");
      expect(result.blockResult.feeRequired).toBe(false);
    }
  });

  it("status=mintable + feeRequired=true + HIGH_BURN_ONLY_NO_FEE=true → action=exhaust, fee_required_skipped", async () => {
    mockConfig.highBurnOnlyNoFee = true;
    mockGetBlockStatus.mockResolvedValue({
      block: 13000072,
      status: "mintable",
      burnGwei: 49742769523n,
      feeRequired: true,
      edmtStatusConfirmed: true,
    });

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    const result = await resolveHighBurnCandidate(baseCandidate, "test-session");

    expect(result.action).toBe("exhaust");
    expect(mockUpdateHighBurnCandidateStatus).toHaveBeenCalledWith(
      13000072,
      "fee_required_skipped",
      expect.objectContaining({ skip_reason: "fee_required" })
    );
  });

  it("status=mintable + feeRequired=true + HIGH_BURN_ONLY_NO_FEE=false → action=proceed", async () => {
    mockConfig.highBurnOnlyNoFee = false;
    mockGetBlockStatus.mockResolvedValue({
      block: 13000072,
      status: "mintable",
      burnGwei: 49742769523n,
      feeRequired: true,
      edmtStatusConfirmed: true,
    });

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    const result = await resolveHighBurnCandidate(baseCandidate, "test-session");

    expect(result.action).toBe("proceed");
    if (result.action === "proceed") {
      expect(result.blockResult.feeRequired).toBe(true);
      expect(result.blockResult.edmtStatusConfirmed).toBe(true);
    }
  });

  it("attempts incremented on every resolution call regardless of outcome", async () => {
    mockGetBlockStatus.mockResolvedValue({
      block: 13000072,
      status: "unknown",
      edmtStatusConfirmed: false,
    });

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    await resolveHighBurnCandidate(baseCandidate, "test-session");

    // First call must always be incrementAttempts=true
    expect(mockUpdateHighBurnCandidateStatus).toHaveBeenCalledWith(
      13000072,
      "discovered",
      expect.objectContaining({ incrementAttempts: true })
    );
  });

  it("EDMT API throws → action=unknown, candidate marked unknown", async () => {
    mockGetBlockStatus.mockRejectedValue(new Error("network timeout"));

    const { resolveHighBurnCandidate } = await import("../src/autoMintRunner.js");
    const result = await resolveHighBurnCandidate(baseCandidate, "test-session");

    expect(result.action).toBe("unknown");
    expect(mockUpdateHighBurnCandidateStatus).toHaveBeenCalledWith(
      13000072,
      "unknown",
      expect.objectContaining({ skip_reason: expect.stringContaining("edmt_api_error") })
    );
  });
});
