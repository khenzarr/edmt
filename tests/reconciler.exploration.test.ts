/**
 * Bug Condition Exploration Test — Property 1: Bug Condition
 *
 * CRITICAL: This test MUST FAIL on unfixed code.
 * Failure confirms the bug exists: review_required tx with receipt.status=1,
 * EDMT owner match, tx hash match → automint still blocked, no reconcile mechanism.
 *
 * After fix: this test MUST PASS.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  config: {
    rpcUrl: "http://localhost:8545",
    privateKey: "0xdeadbeef",
    dryRun: true,
    enableLiveMint: false,
    startBlock: 1000,
    sqlitePath: ":memory:",
    edmtBaseUrl: "https://www.edmt.io",
    edmtApiBaseUrl: "https://www.edmt.io/api/v1",
    apiRetryLimit: 1,
    rpcRetryLimit: 1,
    pollIntervalMs: 100,
    autoMintPollIntervalMs: 100,
    autoMintReconcileIntervalMs: 100,
    autoMintMaxTxPerSession: 999,
    autoMintMaxTxPerDay: 999,
    autoMintMaxRuntimeMinutes: 0,
    autoMintStopOnReviewRequired: true,
    autoMintStopOnFeeRequired: false,
    autoMintOnlyNoFeeBlocks: true,
    autoMintStopOnFirstError: false,
    autoMintConfirmEachTx: false,
    autoMintMinWalletBalanceEth: 0.001,
    autoMintRequireHotWalletBalanceMaxEth: 0.02,
    autoMintEmergencyStopFile: "./STOP_AUTOMINT_TEST",
    autoMintSessionLockFile: "./automint_test.lock",
    allowMultiplePendingTx: false,
    requireManualConfirmationForFirstTx: false,
    finalityConfirmations: 64,
    beyondHeadBehavior: "wait",
    maxBlocksPerRun: 100,
    maxTxPerRun: 1,
    maxGasGwei: 80,
    maxPriorityFeeGwei: 3,
    maxCaptureFeeGwei: BigInt(1_000_000_000),
    minBurnGwei: BigInt(1),
    autoMintPipelineMode: false,
    autoMintMaxPendingTxs: 3,
    autoMintMaxUnfinalizedTxs: 10,
    autoMintTxSpacingMs: 30000,
    autoMintStopOnPendingTxFailure: true,
    autoMintRequireIncludedBeforeNextTx: false,
    highBurnPriorityMode: false,
    highBurnScanStartBlock: 12965000,
    highBurnMinEthTiers: [4, 1],
    highBurnActiveTierEth: 4,
    highBurnBatchSize: 1000,
    highBurnMaxCandidatesPerTier: 10000,
    highBurnRescanMinted: false,
    highBurnUseCache: true,
    highBurnCacheTtlHours: 168,
    highBurnSort: "desc",
    highBurnOnlyMintable: true,
    highBurnOnlyNoFee: true,
    highBurnSkipAlreadySeen: true,
    highBurnOnExhausted: "fallback_sequential",
    highBurnUnknownRetryMinutes: 30,
    scanDirection: "ascending",
    stopBlock: undefined,
    autoMintAllowedStartBlock: undefined,
    autoMintAllowedStopBlock: undefined,
    highBurnScanEndBlock: undefined,
    // Reconcile config — NOT present on unfixed code (will be undefined)
    autoReconcileReviewRequired: false,
    reconcileRequireFinality: true,
    reconcileMinConfirmations: 64,
  },
  isLiveMintEnabled: () => false,
  hasPrivateKey: () => true,
}));

vi.mock("../src/db.js", () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
  getCheckpointRaw: vi.fn().mockReturnValue(undefined),
  setCheckpointRaw: vi.fn(),
  hasReviewRequiredTx: vi.fn().mockReturnValue(true), // review_required exists
  hasPendingTx: vi.fn().mockReturnValue(false),
  hasFailedTx: vi.fn().mockReturnValue(false),
  getPendingTxCount: vi.fn().mockReturnValue(0),
  getUnfinalizedTxCount: vi.fn().mockReturnValue(0),
  getDailyTxCount: vi.fn().mockReturnValue(0),
  getPendingTxs: vi.fn().mockReturnValue([]),
  recordError: vi.fn(),
  updateTxStatus: vi.fn(),
  upsertBlockResult: vi.fn(),
  insertTx: vi.fn(),
  getStats: vi
    .fn()
    .mockReturnValue({ totalScanned: 0, totalMinted: 0, totalFailed: 0, totalPending: 0 }),
  updateHighBurnCandidateStatus: vi.fn(),
  getNextHighBurnCandidate: vi.fn().mockReturnValue(null),
  isBlockSubmittedOrBeyond: vi.fn().mockReturnValue(false),
  // Reconcile helpers — NOT present on unfixed code
  getReviewRequiredTxs: vi.fn().mockReturnValue([
    {
      id: 1,
      block: 24973104,
      tx_hash: "0xb35dabc123",
      status: "review_required",
      reason: "owner_mismatch",
      updated_at: new Date().toISOString(),
    },
  ]),
  updateTxStatusWithReason: vi.fn(),
  getBlockResultByBlock: vi.fn().mockReturnValue({ block: 24973104, status: "review_required" }),
  insertReconcileEvent: vi.fn(),
}));

vi.mock("../src/ethClient.js", () => ({
  getProvider: vi.fn(),
  getWallet: vi.fn().mockReturnValue({ address: "0x16fc000000000000000000000000000000000001" }),
  getCurrentBlockNumber: vi.fn().mockResolvedValue(25000000),
  getBlock: vi.fn().mockResolvedValue(null),
  getTransactionReceipt: vi.fn().mockResolvedValue({
    status: 1,
    blockNumber: 24973104,
    transactionHash: "0xb35dabc123",
  }),
  getWalletBalanceEth: vi.fn().mockResolvedValue(0.01),
  getPendingNonce: vi.fn().mockResolvedValue(5),
  sendRawTransaction: vi.fn(),
  calculateBurnGwei: vi.fn().mockResolvedValue(BigInt(1000)),
  blockExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/edmtClient.js", () => ({
  getBlockStatus: vi.fn().mockResolvedValue({
    block: 24973104,
    status: "minted",
    owner: "0x16fc000000000000000000000000000000000001", // our wallet — owner match
    mintTx: "0xb35dabc123", // tx hash match
    edmtStatusConfirmed: true,
    burnGwei: BigInt(1000),
  }),
  getFeeQuote: vi.fn().mockResolvedValue({ feeRequired: false }),
}));

vi.mock("../src/checkpoint.js", () => ({
  initCheckpoint: vi.fn().mockReturnValue(1000),
  getCheckpoint: vi.fn().mockReturnValue(1000),
  setCheckpoint: vi.fn(),
  advanceScannedBlock: vi.fn(),
  setSuccessfulMintBlock: vi.fn(),
  setFinalizedTx: vi.fn(),
  recordCheckpointError: vi.fn(),
  setCheckpointRaw: vi.fn(),
  setSubmittedBlock: vi.fn(),
}));

vi.mock("../src/blockScanner.js", () => ({
  decideBlock: vi.fn().mockResolvedValue({ block: 1000, status: "beyond_current_head" }),
  scanBatch: vi.fn(),
}));

vi.mock("../src/mintExecutor.js", () => ({
  execute: vi.fn(),
  resetRunState: vi.fn(),
}));

vi.mock("../src/txMonitor.js", () => ({
  poll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/highBurnSelector.js", () => ({
  getNextHighBurnCandidate: vi.fn().mockReturnValue(null),
  TierManager: vi.fn().mockImplementation(() => ({
    getActiveTier: vi.fn().mockReturnValue(4),
    tryDowngrade: vi.fn().mockReturnValue(false),
  })),
  defaultSelectorOpts: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 1: Bug Condition — Review Required Reconciliation (Exploration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("EXPLORATION: resolveReviewRequired function exists in reconciler module", async () => {
    // This test verifies the reconciler module exists and exports resolveReviewRequired.
    // On UNFIXED code: this will FAIL because src/reconciler.ts does not exist.
    // After fix: this will PASS.
    const reconcilerModule = await import("../src/reconciler.js");
    expect(reconcilerModule.resolveReviewRequired).toBeDefined();
    expect(typeof reconcilerModule.resolveReviewRequired).toBe("function");
  });

  it("EXPLORATION: reconcileAll function exists in reconciler module", async () => {
    // On UNFIXED code: FAIL (module does not exist)
    // After fix: PASS
    const reconcilerModule = await import("../src/reconciler.js");
    expect(reconcilerModule.reconcileAll).toBeDefined();
    expect(typeof reconcilerModule.reconcileAll).toBe("function");
  });

  it("EXPLORATION: resolveReviewRequired returns MARK_FINALIZED for bug condition input", async () => {
    // Bug condition: review_required tx, receipt.status=1, EDMT owner match, tx hash match
    // On UNFIXED code: FAIL (module does not exist)
    // After fix: PASS — decision should be MARK_FINALIZED
    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");

    const tx = {
      id: 1,
      block: 24973104,
      tx_hash: "0xb35dabc123",
      status: "review_required" as const,
      reason: "owner_mismatch",
      updated_at: new Date().toISOString(),
    };

    const result = await resolveReviewRequired(tx, { dryRun: true, fix: false });

    // For bug condition input: should decide MARK_FINALIZED
    expect(result.decision).toBe(ReconcileDecision.MARK_FINALIZED);
  });

  it("EXPLORATION: reconcileAll clears review_required when bug condition is met", async () => {
    // On UNFIXED code: FAIL (module does not exist)
    // After fix: PASS — report should show finalized=1
    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({ dryRun: true, fix: false });

    // Should have found and decided to finalize the review_required tx
    expect(report.total).toBeGreaterThan(0);
    expect(report.finalized).toBeGreaterThan(0);
  });
});
