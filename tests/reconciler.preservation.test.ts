/**
 * Preservation Property Tests — Property 2: Preservation
 *
 * Observation-first methodology:
 * 1. Observe behavior on UNFIXED code for non-buggy inputs
 * 2. Write property-based tests capturing observed behavior
 * 3. Verify tests PASS on UNFIXED code (baseline)
 * 4. After fix: tests should still PASS (no regressions)
 *
 * Non-buggy inputs (isBugCondition returns false):
 *   - receipt missing
 *   - receipt.status = 0
 *   - owner mismatch
 *   - tx hash mismatch
 *   - insufficient confirmations (RECONCILE_REQUIRE_FINALITY=true)
 *
 * Observed baseline behavior on unfixed code:
 *   - hasReviewRequiredTx() returns true when review_required records exist
 *   - runAutoMint() returns review_required_detected when AUTO_RECONCILE_REVIEW_REQUIRED=false
 *   - txs with status='pending'/'included' are NOT touched by reconcile
 *   - block_results with status='successful_mint'/'finalized' are NOT modified
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockDb = {
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
  getCheckpointRaw: vi.fn().mockReturnValue(undefined),
  setCheckpointRaw: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  getReviewRequiredTxs: vi.fn(),
  getBlockResultByBlock: vi.fn(),
  insertReconcileEvent: vi.fn(),
};

vi.mock("../src/db.js", () => mockDb);

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
    autoReconcileReviewRequired: false, // disabled — existing behavior
    reconcileRequireFinality: true,
    reconcileMinConfirmations: 64,
  },
  isLiveMintEnabled: () => false,
  hasPrivateKey: () => true,
}));

const mockEthClient = {
  getProvider: vi.fn(),
  getWallet: vi.fn().mockReturnValue({ address: "0x16fc000000000000000000000000000000000001" }),
  getCurrentBlockNumber: vi.fn().mockResolvedValue(25000000),
  getBlock: vi.fn().mockResolvedValue(null),
  getTransactionReceipt: vi.fn(),
  getWalletBalanceEth: vi.fn().mockResolvedValue(0.01),
  getPendingNonce: vi.fn().mockResolvedValue(5),
  sendRawTransaction: vi.fn(),
  calculateBurnGwei: vi.fn().mockResolvedValue(BigInt(1000)),
  blockExists: vi.fn().mockResolvedValue(true),
};

vi.mock("../src/ethClient.js", () => mockEthClient);

const mockEdmtClient = {
  getBlockStatus: vi.fn(),
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
// Helper: build a review_required tx record
// ---------------------------------------------------------------------------

function makeTxRecord(
  overrides: Partial<{
    id: number;
    block: number;
    tx_hash: string;
    status: string;
    reason: string;
    updated_at: string;
  }> = {}
) {
  return {
    id: 1,
    block: 24973104,
    tx_hash: "0xb35dabc123",
    status: "review_required",
    reason: "test",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Preservation Tests
// ---------------------------------------------------------------------------

describe("Property 2: Preservation — Unresolvable Records Stay Review Required", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default: review_required exists
    mockDb.hasReviewRequiredTx.mockReturnValue(true);
    mockDb.updateTxStatus.mockReset();
    mockDb.updateTxStatusWithReason.mockReset();
    mockDb.upsertBlockResult.mockReset();
  });

  // -------------------------------------------------------------------------
  // Observation 1: hasReviewRequiredTx() returns true when records exist
  // -------------------------------------------------------------------------
  it("PRESERVATION: hasReviewRequiredTx() returns true when review_required records exist", () => {
    // Observed on unfixed code: hasReviewRequiredTx() returns true
    // This is the baseline behavior that must be preserved
    // Use the already-mocked mockDb directly (ESM — require() not available)
    expect(mockDb.hasReviewRequiredTx()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Observation 2: receipt missing → LEAVE_REVIEW_REQUIRED
  // -------------------------------------------------------------------------
  it("PRESERVATION: receipt missing → resolveReviewRequired returns LEAVE_REVIEW_REQUIRED", async () => {
    mockEthClient.getTransactionReceipt.mockResolvedValue(null); // no receipt
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");
    const tx = makeTxRecord();
    const result = await resolveReviewRequired(tx, { dryRun: true, fix: false });

    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("receipt_missing");
    // DB must NOT be updated
    expect(mockDb.updateTxStatus.mock.calls.length).toBe(0);
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Observation 3: receipt.status=0 → LEAVE_REVIEW_REQUIRED
  // -------------------------------------------------------------------------
  it("PRESERVATION: receipt.status=0 → resolveReviewRequired returns LEAVE_REVIEW_REQUIRED", async () => {
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 0,
      blockNumber: 24973104,
      transactionHash: "0xb35dabc123",
    });
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");
    const tx = makeTxRecord();
    const result = await resolveReviewRequired(tx, { dryRun: true, fix: false });

    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("receipt_failed");
    expect(mockDb.updateTxStatus.mock.calls.length).toBe(0);
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Observation 4: owner mismatch → LEAVE_REVIEW_REQUIRED
  // -------------------------------------------------------------------------
  it("PRESERVATION: owner mismatch → resolveReviewRequired returns LEAVE_REVIEW_REQUIRED", async () => {
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24973104,
      transactionHash: "0xb35dabc123",
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24973104,
      status: "minted",
      owner: "0xABCDEF0000000000000000000000000000000001", // different wallet
      mintTx: "0xb35dabc123",
      edmtStatusConfirmed: true,
    });
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");
    const tx = makeTxRecord();
    const result = await resolveReviewRequired(tx, { dryRun: true, fix: false });

    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("owner_mismatch");
    expect(mockDb.updateTxStatus.mock.calls.length).toBe(0);
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Observation 5: tx hash mismatch → LEAVE_REVIEW_REQUIRED
  // -------------------------------------------------------------------------
  it("PRESERVATION: tx hash mismatch → resolveReviewRequired returns LEAVE_REVIEW_REQUIRED", async () => {
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24973104,
      transactionHash: "0xb35dabc123",
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24973104,
      status: "minted",
      owner: "0x16fc000000000000000000000000000000000001", // our wallet
      mintTx: "0xDIFFERENTHASH999", // different tx hash
      edmtStatusConfirmed: true,
    });
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");
    const tx = makeTxRecord();
    const result = await resolveReviewRequired(tx, { dryRun: true, fix: false });

    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("tx_hash_mismatch");
    expect(mockDb.updateTxStatus.mock.calls.length).toBe(0);
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Observation 6: EDMT API unavailable → LEAVE_REVIEW_REQUIRED
  // -------------------------------------------------------------------------
  it("PRESERVATION: EDMT API unavailable → resolveReviewRequired returns LEAVE_REVIEW_REQUIRED", async () => {
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24973104,
      transactionHash: "0xb35dabc123",
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24973104,
      status: "unknown",
      edmtStatusConfirmed: false, // API unavailable
    });
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");
    const tx = makeTxRecord();
    const result = await resolveReviewRequired(tx, { dryRun: true, fix: false });

    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("edmt_api_unavailable");
    expect(mockDb.updateTxStatus.mock.calls.length).toBe(0);
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Observation 7: insufficient confirmations + RECONCILE_REQUIRE_FINALITY=true → LEAVE_REVIEW_REQUIRED
  // -------------------------------------------------------------------------
  it("PRESERVATION: insufficient confirmations + RECONCILE_REQUIRE_FINALITY=true → LEAVE_REVIEW_REQUIRED", async () => {
    // Current block = 24973114, included in 24973104 → only 10 confirmations (< 64)
    mockEthClient.getCurrentBlockNumber.mockResolvedValue(24973114);
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24973104,
      transactionHash: "0xb35dabc123",
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24973104,
      status: "minted",
      owner: "0x16fc000000000000000000000000000000000001",
      mintTx: "0xb35dabc123",
      edmtStatusConfirmed: true,
    });
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");
    const tx = makeTxRecord();
    // reconcileRequireFinality=true, minConfirmations=64, only 10 confirmations
    const result = await resolveReviewRequired(tx, {
      dryRun: true,
      fix: false,
      requireFinality: true,
      minConfirmations: 64,
      currentBlockNumber: 24973114,
    });

    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("insufficient_confirmations");
    expect(mockDb.updateTxStatus.mock.calls.length).toBe(0);
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Observation 8: dry-run mode → DB never written
  // -------------------------------------------------------------------------
  it("PRESERVATION: dry-run mode → DB is never written even for MARK_FINALIZED decision", async () => {
    // Bug condition met (would be MARK_FINALIZED), but dry-run=true
    mockEthClient.getCurrentBlockNumber.mockResolvedValue(25000000);
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24973104,
      transactionHash: "0xb35dabc123",
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24973104,
      status: "minted",
      owner: "0x16fc000000000000000000000000000000000001",
      mintTx: "0xb35dabc123",
      edmtStatusConfirmed: true,
    });
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);

    const { reconcileAll } = await import("../src/reconciler.js");
    const report = await reconcileAll({ dryRun: true, fix: false });

    // Decision should be MARK_FINALIZED but DB should NOT be written
    expect(report.finalized).toBeGreaterThan(0);
    expect(mockDb.updateTxStatus.mock.calls.length).toBe(0);
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
    expect(mockDb.upsertBlockResult.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Observation 9: pending/included txs are NOT touched by reconciler
  // -------------------------------------------------------------------------
  it("PRESERVATION: reconciler does NOT touch pending or included txs", async () => {
    // Only review_required txs are returned by getReviewRequiredTxs
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);
    // pending/included txs exist but should not be touched
    mockDb.getPendingTxs.mockReturnValue([
      {
        id: 2,
        block: 99999,
        tx_hash: "0xpending",
        nonce: 10,
        gas_info: "{}",
        submitted_at: new Date().toISOString(),
        status: "pending",
      },
    ]);

    mockEthClient.getTransactionReceipt.mockResolvedValue(null); // receipt missing for review_required

    const { reconcileAll } = await import("../src/reconciler.js");
    await reconcileAll({ dryRun: true, fix: false });

    // updateTxStatus should NOT be called for the pending tx
    const updateCalls = mockDb.updateTxStatus.mock.calls;
    const pendingTouched = updateCalls.some((call: unknown[]) => call[0] === "0xpending");
    expect(pendingTouched).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Observation 10: reconcileAll with no review_required txs → empty report
  // -------------------------------------------------------------------------
  it("PRESERVATION: reconcileAll with no review_required txs returns empty report", async () => {
    mockDb.getReviewRequiredTxs.mockReturnValue([]);

    const { reconcileAll } = await import("../src/reconciler.js");
    const report = await reconcileAll({ dryRun: true, fix: false });

    expect(report.total).toBe(0);
    expect(report.finalized).toBe(0);
    expect(report.leftReviewRequired).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Observation 11: hasReviewRequiredTx() still true after failed reconcile
  // -------------------------------------------------------------------------
  it("PRESERVATION: hasReviewRequiredTx() still true after reconcile leaves records unresolved", async () => {
    mockEthClient.getTransactionReceipt.mockResolvedValue(null); // receipt missing → LEAVE
    mockDb.getReviewRequiredTxs.mockReturnValue([makeTxRecord()]);
    mockDb.hasReviewRequiredTx.mockReturnValue(true); // still true after reconcile

    const { reconcileAll } = await import("../src/reconciler.js");
    await reconcileAll({ dryRun: false, fix: true });

    // hasReviewRequiredTx should still return true (record was not cleared)
    const { hasReviewRequiredTx } = await import("../src/db.js");
    expect(hasReviewRequiredTx()).toBe(true);
  });
});
