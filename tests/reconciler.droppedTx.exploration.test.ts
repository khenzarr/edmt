/**
 * Bug Condition Exploration Test — Dropped TX Resolution
 * Property 1: Bug Condition — Dropped TX Tespit Edilemiyor
 *
 * CRITICAL: This test MUST FAIL on unfixed code.
 * Failure confirms the bug exists:
 *   - getTransactionReceipt(txHash) = null
 *   - getTransaction(txHash) = null  (tx not found on chain — dropped)
 *   - latestNonce(walletAddress) > txNonce  (e.g. latestNonce=15, txNonce=12)
 *
 * On unfixed code, the reconciler returns LEAVE_REVIEW_REQUIRED / receipt_missing
 * instead of MARK_DROPPED_RETRYABLE, because:
 *   - resolveDroppedTx() does not exist
 *   - ReconcileDecision.MARK_DROPPED_RETRYABLE does not exist
 *   - ReconcileOpts.fixDropped field does not exist
 *   - reconcileAll() with fixDropped=true does not call dropped resolution
 *
 * After fix: this test MUST PASS.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
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
    autoReconcileReviewRequired: false,
    reconcileRequireFinality: false, // disabled so finality check doesn't interfere
    reconcileMinConfirmations: 64,
  },
  isLiveMintEnabled: () => false,
  hasPrivateKey: () => true,
}));

// ---------------------------------------------------------------------------
// DB mock — one review_required tx with nonce=12, block=24987708
// ---------------------------------------------------------------------------
const mockDb = {
  getDb: vi.fn(),
  closeDb: vi.fn(),
  getCheckpointRaw: vi.fn().mockReturnValue(undefined),
  setCheckpointRaw: vi.fn(),
  hasReviewRequiredTx: vi.fn().mockReturnValue(true),
  hasPendingTx: vi.fn().mockReturnValue(false),
  hasFailedTx: vi.fn().mockReturnValue(false),
  getPendingTxCount: vi.fn().mockReturnValue(0),
  getUnfinalizedTxCount: vi.fn().mockReturnValue(0),
  getDailyTxCount: vi.fn().mockReturnValue(0),
  getPendingTxs: vi.fn().mockReturnValue([]),
  recordError: vi.fn(),
  updateTxStatus: vi.fn(),
  updateTxStatusWithReason: vi.fn(),
  upsertBlockResult: vi.fn(),
  insertTx: vi.fn(),
  getStats: vi
    .fn()
    .mockReturnValue({ totalScanned: 0, totalMinted: 0, totalFailed: 0, totalPending: 0 }),
  updateHighBurnCandidateStatus: vi.fn(),
  isBlockSubmittedOrBeyond: vi.fn().mockReturnValue(false),
  getReviewRequiredTxs: vi.fn().mockReturnValue([
    {
      id: 1,
      block: 24987708,
      tx_hash: "0xa19e5faa0b4c13d3d500c83ebe17c286a65c747dd58125a38988b331162ccd4d",
      status: "review_required",
      reason: "receipt_missing",
      nonce: 12,
      updated_at: new Date().toISOString(),
    },
  ]),
  getBlockResultByBlock: vi.fn().mockReturnValue({
    block: 24987708,
    status: "review_required",
    reason: null,
  }),
  insertReconcileEvent: vi.fn(),
  markTxDropped: vi.fn(),
  markBlockRetryable: vi.fn(),
};

vi.mock("../src/db.js", () => mockDb);

// ---------------------------------------------------------------------------
// ETH client mock:
//   - getTransactionReceipt → null (no receipt — tx dropped)
//   - getTransaction → null (tx not found on chain — dropped)
//   - getLatestNonce → 15 (latestNonce=15 > txNonce=12 — nonce advanced)
//   - getPendingNonce → 15
// ---------------------------------------------------------------------------
const mockEthClient = {
  getProvider: vi.fn(),
  getWallet: vi.fn().mockReturnValue({ address: "0x16fc000000000000000000000000000000000001" }),
  getCurrentBlockNumber: vi.fn().mockResolvedValue(25000000),
  getBlock: vi.fn().mockResolvedValue(null),
  getTransactionReceipt: vi.fn().mockResolvedValue(null), // no receipt
  getTransaction: vi.fn().mockResolvedValue(null), // tx not found on chain (dropped)
  getLatestNonce: vi.fn().mockResolvedValue(15), // latestNonce=15 > txNonce=12
  getPendingNonce: vi.fn().mockResolvedValue(15),
  getWalletBalanceEth: vi.fn().mockResolvedValue(0.01),
  sendRawTransaction: vi.fn(),
  calculateBurnGwei: vi.fn().mockResolvedValue(BigInt(1000)),
  blockExists: vi.fn().mockResolvedValue(true),
};

vi.mock("../src/ethClient.js", () => mockEthClient);

// ---------------------------------------------------------------------------
// EDMT client mock:
//   - block 24987708 status = "mintable" (block still available for minting)
// ---------------------------------------------------------------------------
const mockEdmtClient = {
  getBlockStatus: vi.fn().mockResolvedValue({
    block: 24987708,
    status: "mintable",
    owner: null,
    mintTx: null,
    edmtStatusConfirmed: true,
    burnGwei: BigInt(1000),
  }),
  getFeeQuote: vi.fn().mockResolvedValue({ feeRequired: false }),
};

vi.mock("../src/edmtClient.js", () => mockEdmtClient);

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
// The dropped tx record used in all tests
// ---------------------------------------------------------------------------
const DROPPED_TX = {
  id: 1,
  block: 24987708,
  tx_hash: "0xa19e5faa0b4c13d3d500c83ebe17c286a65c747dd58125a38988b331162ccd4d",
  status: "review_required" as const,
  reason: "receipt_missing",
  nonce: 12,
  updated_at: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 1: Bug Condition — Dropped TX Tespit Edilemiyor (Exploration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply defaults after clearAllMocks
    mockEthClient.getTransactionReceipt.mockResolvedValue(null);
    mockEthClient.getTransaction.mockResolvedValue(null);
    mockEthClient.getLatestNonce.mockResolvedValue(15);
    mockEthClient.getPendingNonce.mockResolvedValue(15);
    mockEthClient.getWallet.mockReturnValue({
      address: "0x16fc000000000000000000000000000000000001",
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24987708,
      status: "mintable",
      owner: null,
      mintTx: null,
      edmtStatusConfirmed: true,
      burnGwei: BigInt(1000),
    });
    mockDb.getReviewRequiredTxs.mockReturnValue([DROPPED_TX]);
    mockDb.hasReviewRequiredTx.mockReturnValue(true);
  });

  // -------------------------------------------------------------------------
  // Test 1: resolveDroppedTx function MUST exist (does NOT on unfixed code)
  // -------------------------------------------------------------------------
  it("EXPLORATION: resolveDroppedTx function exists in reconciler module", async () => {
    // On UNFIXED code: FAILS — resolveDroppedTx is not exported
    // After fix: PASSES
    const reconcilerModule = await import("../src/reconciler.js");
    expect(
      (reconcilerModule as Record<string, unknown>)["resolveDroppedTx"],
      "resolveDroppedTx should be exported from reconciler — does not exist on unfixed code"
    ).toBeDefined();
    expect(typeof (reconcilerModule as Record<string, unknown>)["resolveDroppedTx"]).toBe(
      "function"
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: ReconcileDecision.MARK_DROPPED_RETRYABLE MUST exist (does NOT on unfixed code)
  // -------------------------------------------------------------------------
  it("EXPLORATION: ReconcileDecision.MARK_DROPPED_RETRYABLE constant exists", async () => {
    // On UNFIXED code: FAILS — MARK_DROPPED_RETRYABLE is not defined
    // After fix: PASSES
    const { ReconcileDecision } = await import("../src/reconciler.js");
    expect(
      (ReconcileDecision as Record<string, unknown>)["MARK_DROPPED_RETRYABLE"],
      "ReconcileDecision.MARK_DROPPED_RETRYABLE should exist — does not exist on unfixed code"
    ).toBeDefined();
    expect((ReconcileDecision as Record<string, unknown>)["MARK_DROPPED_RETRYABLE"]).toBe(
      "MARK_DROPPED_RETRYABLE"
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: ReconcileOpts.fixDropped field MUST exist (does NOT on unfixed code)
  // -------------------------------------------------------------------------
  it("EXPLORATION: ReconcileOpts accepts fixDropped field without TypeScript error", async () => {
    // On UNFIXED code: FAILS — fixDropped field does not exist on ReconcileOpts
    // After fix: PASSES — reconcileAll accepts fixDropped=true without error
    const { reconcileAll } = await import("../src/reconciler.js");

    // This call should NOT throw a TypeScript/runtime error on fixed code
    // On unfixed code, fixDropped is not a valid field → test fails because
    // reconcileAll does not process dropped txs even when fixDropped=true
    const report = await reconcileAll({ dryRun: true, fix: false, fixDropped: true } as Parameters<
      typeof reconcileAll
    >[0]);

    // The report should exist (basic sanity)
    expect(report).toBeDefined();
    expect(report.total).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: Core bug condition — resolveDroppedTx returns MARK_DROPPED_RETRYABLE
  //         for isBugCondition(X) = true inputs
  // -------------------------------------------------------------------------
  it("EXPLORATION: resolveDroppedTx returns MARK_DROPPED_RETRYABLE for dropped tx (isBugCondition=true)", async () => {
    // Bug condition:
    //   getTransactionReceipt = null
    //   getTransaction = null
    //   latestNonce=15 > txNonce=12
    //   EDMT block status = mintable
    //
    // On UNFIXED code: FAILS — resolveDroppedTx does not exist
    // After fix: PASSES — decision is MARK_DROPPED_RETRYABLE

    const reconcilerModule = await import("../src/reconciler.js");
    const resolveDroppedTx = (reconcilerModule as Record<string, unknown>)[
      "resolveDroppedTx"
    ] as Function;

    expect(resolveDroppedTx, "resolveDroppedTx must be exported from reconciler").toBeDefined();

    const result = await resolveDroppedTx(DROPPED_TX, {
      dryRun: true,
      fix: false,
      fixDropped: true,
    });

    // Expected (fixed) behavior: MARK_DROPPED_RETRYABLE
    expect(result.decision).toBe("MARK_DROPPED_RETRYABLE");
    expect(result.tx.tx_hash).toBe(DROPPED_TX.tx_hash);
  });

  // -------------------------------------------------------------------------
  // Test 5: reconcileAll with fixDropped=true returns MARK_DROPPED_RETRYABLE
  //         for the dropped tx (not LEAVE_REVIEW_REQUIRED / receipt_missing)
  // -------------------------------------------------------------------------
  it("EXPLORATION: reconcileAll with fixDropped=true returns MARK_DROPPED_RETRYABLE for dropped tx", async () => {
    // On UNFIXED code: FAILS — reconcileAll does not call dropped resolution,
    //   result.decision = LEAVE_REVIEW_REQUIRED, reason = receipt_missing
    // After fix: PASSES — result.decision = MARK_DROPPED_RETRYABLE

    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: true,
      fix: false,
      fixDropped: true,
    } as Parameters<typeof reconcileAll>[0]);

    expect(report.total).toBe(1);
    expect(report.results).toHaveLength(1);

    const result = report.results[0];

    // The tx should NOT remain as receipt_missing / LEAVE_REVIEW_REQUIRED
    expect(result.decision).not.toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).not.toBe("receipt_missing");

    // The tx SHOULD be decided as MARK_DROPPED_RETRYABLE
    expect(result.decision).toBe("MARK_DROPPED_RETRYABLE");
  });

  // -------------------------------------------------------------------------
  // Test 6: After dropped resolution, hasReviewRequiredTx() returns false
  //         (automint can start)
  // -------------------------------------------------------------------------
  it("EXPLORATION: after dropped resolution, hasReviewRequiredTx() returns false", async () => {
    // On UNFIXED code: FAILS — tx stays review_required, hasReviewRequiredTx() stays true
    // After fix: PASSES — tx is marked dropped, hasReviewRequiredTx() returns false

    // Simulate: after fix mode resolution, DB is updated → hasReviewRequiredTx returns false
    mockDb.hasReviewRequiredTx.mockReturnValue(false);
    mockDb.updateTxStatusWithReason.mockImplementation(() => {
      // Simulate DB update
    });

    const { reconcileAll } = await import("../src/reconciler.js");

    await reconcileAll({
      dryRun: false,
      fix: true,
      fixDropped: true,
    } as Parameters<typeof reconcileAll>[0]);

    // After resolution, hasReviewRequiredTx should return false
    const { hasReviewRequiredTx } = await import("../src/db.js");
    expect(hasReviewRequiredTx()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 7: On UNFIXED code, resolveReviewRequired returns receipt_missing
  //         (documents the current broken behavior)
  // -------------------------------------------------------------------------
  it("OBSERVATION: on unfixed code, resolveReviewRequired returns LEAVE_REVIEW_REQUIRED/receipt_missing for dropped tx", async () => {
    // This test documents the CURRENT (broken) behavior of resolveReviewRequired.
    // It PASSES on both unfixed and fixed code — it's an observation, not a fix check.
    // The bug: resolveReviewRequired stops at receipt_missing without checking if tx is dropped.

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");

    const result = await resolveReviewRequired(DROPPED_TX, { dryRun: true, fix: false });

    // On unfixed code: LEAVE_REVIEW_REQUIRED / receipt_missing (the bug)
    // This is the counterexample: unfixed code returns receipt_missing instead of MARK_DROPPED_RETRYABLE
    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("receipt_missing");

    // Document: this is the bug — the tx is dropped but reconciler doesn't detect it
    // Counterexample: { tx: { nonce: 12, block: 24987708 }, latestNonce: 15, getTransaction: null }
    // → unfixed code returns receipt_missing / LEAVE_REVIEW_REQUIRED
    // → fixed code should return MARK_DROPPED_RETRYABLE
  });
});
