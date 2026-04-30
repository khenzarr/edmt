/**
 * Preservation Property Tests — Property 2: Preservation
 * Kanıtsız Dropped İşareti Yapılmamalı
 *
 * Observation-first methodology:
 * 1. Observe behavior on UNFIXED code for non-buggy inputs (isBugCondition returns false)
 * 2. Write tests capturing observed baseline behavior
 * 3. Verify ALL tests PASS on UNFIXED code (confirms baseline to preserve)
 * 4. After fix: tests should still PASS (no regressions)
 *
 * Non-buggy inputs (isBugCondition returns false):
 *   - getTransaction NOT null (tx still pending)
 *   - latestNonce <= txNonce (nonce not advanced)
 *   - fixDropped=false (dropped resolution not triggered)
 *   - receipt.status=1 + owner match + tx hash match (MARK_FINALIZED path)
 *   - dry-run mode (DB never written)
 *   - receipt.status=0 (failed tx)
 *   - owner mismatch
 *   - tx hash mismatch
 *
 * Validates: Requirements 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock external dependencies — same vi.mock() structure as exploration test
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
// DB mock — same structure as exploration test
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
// ETH client mock — same structure as exploration test
// ---------------------------------------------------------------------------
const mockEthClient = {
  getProvider: vi.fn(),
  getWallet: vi.fn().mockReturnValue({ address: "0x16fc000000000000000000000000000000000001" }),
  getCurrentBlockNumber: vi.fn().mockResolvedValue(25000000),
  getBlock: vi.fn().mockResolvedValue(null),
  getTransactionReceipt: vi.fn().mockResolvedValue(null), // default: no receipt
  getTransaction: vi.fn().mockResolvedValue(null), // default: tx not found (dropped)
  getLatestNonce: vi.fn().mockResolvedValue(15), // default: latestNonce=15 > txNonce=12
  getPendingNonce: vi.fn().mockResolvedValue(15),
  getWalletBalanceEth: vi.fn().mockResolvedValue(0.01),
  sendRawTransaction: vi.fn(),
  calculateBurnGwei: vi.fn().mockResolvedValue(BigInt(1000)),
  blockExists: vi.fn().mockResolvedValue(true),
};

vi.mock("../src/ethClient.js", () => mockEthClient);

// ---------------------------------------------------------------------------
// EDMT client mock — same structure as exploration test
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
// The base dropped tx record (bug condition inputs)
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
// Preservation Tests
// ---------------------------------------------------------------------------

describe("Property 2: Preservation — Kanıtsız Dropped İşareti Yapılmamalı", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply defaults after clearAllMocks
    mockEthClient.getTransactionReceipt.mockResolvedValue(null);
    mockEthClient.getTransaction.mockResolvedValue(null);
    mockEthClient.getLatestNonce.mockResolvedValue(15);
    mockEthClient.getPendingNonce.mockResolvedValue(15);
    mockEthClient.getCurrentBlockNumber.mockResolvedValue(25000000);
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
    mockDb.updateTxStatusWithReason.mockReset();
    mockDb.upsertBlockResult.mockReset();
    mockDb.updateTxStatus.mockReset();
    mockDb.insertReconcileEvent.mockReset();
  });

  // -------------------------------------------------------------------------
  // Preservation 1 — tx still pending (getTransaction NOT null)
  // isBugCondition returns false: getTransaction is NOT null
  // Expected: LEAVE_REVIEW_REQUIRED / receipt_missing (unfixed code stops at receipt check)
  // -------------------------------------------------------------------------
  it("PRESERVATION 1: tx still pending (getTransaction NOT null) → LEAVE_REVIEW_REQUIRED / receipt_missing", async () => {
    // Observed on unfixed code:
    // resolveReviewRequired() checks receipt first → receipt=null → returns receipt_missing
    // It does NOT call getTransaction at all on unfixed code.
    // So even with getTransaction returning a non-null value, unfixed code returns receipt_missing.
    // This is the baseline behavior to preserve: tx stays review_required.

    // getTransactionReceipt = null (no receipt)
    mockEthClient.getTransactionReceipt.mockResolvedValue(null);
    // getTransaction = returns a TransactionResponse (tx is in mempool)
    mockEthClient.getTransaction.mockResolvedValue({
      hash: DROPPED_TX.tx_hash,
      blockNumber: null, // pending — not yet included
      from: "0x16fc000000000000000000000000000000000001",
      nonce: 12,
    });

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");

    const result = await resolveReviewRequired(DROPPED_TX, { dryRun: true, fix: false });

    // Baseline: unfixed code returns LEAVE_REVIEW_REQUIRED / receipt_missing
    // (it stops at receipt check, never reaches getTransaction check)
    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("receipt_missing");

    // DB must NOT be updated
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
    expect(mockDb.upsertBlockResult.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Preservation 2 — latestNonce NOT advanced (latestNonce <= txNonce)
  // isBugCondition returns false: latestNonce=12 <= txNonce=12
  // Expected: LEAVE_REVIEW_REQUIRED / receipt_missing (unfixed code stops at receipt check)
  // -------------------------------------------------------------------------
  it("PRESERVATION 2: latestNonce NOT advanced (latestNonce=12 <= txNonce=12) → LEAVE_REVIEW_REQUIRED / receipt_missing", async () => {
    // Observed on unfixed code:
    // resolveReviewRequired() checks receipt first → receipt=null → returns receipt_missing
    // It does NOT check latestNonce at all on unfixed code.
    // Baseline: tx stays review_required when nonce has not advanced.

    mockEthClient.getTransactionReceipt.mockResolvedValue(null);
    mockEthClient.getTransaction.mockResolvedValue(null);
    mockEthClient.getLatestNonce.mockResolvedValue(12); // latestNonce=12 <= txNonce=12

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");

    const result = await resolveReviewRequired(DROPPED_TX, { dryRun: true, fix: false });

    // Baseline: LEAVE_REVIEW_REQUIRED / receipt_missing
    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("receipt_missing");

    // DB must NOT be updated
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
    expect(mockDb.upsertBlockResult.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Preservation 3 — fixDropped=false, dropped resolution does NOT run
  // Bug condition inputs (getTransaction=null, getReceipt=null, latestNonce=15 > txNonce=12)
  // but reconcileAll called WITHOUT fixDropped=true
  // Expected: LEAVE_REVIEW_REQUIRED / receipt_missing, DB NOT updated
  // -------------------------------------------------------------------------
  it("PRESERVATION 3: fixDropped=false → dropped resolution does NOT run, receipt_missing decision unchanged", async () => {
    // Bug condition inputs — but fixDropped is NOT set
    mockEthClient.getTransactionReceipt.mockResolvedValue(null);
    mockEthClient.getTransaction.mockResolvedValue(null);
    mockEthClient.getLatestNonce.mockResolvedValue(15); // latestNonce=15 > txNonce=12

    const { reconcileAll } = await import("../src/reconciler.js");

    // Call WITHOUT fixDropped=true (the default behavior)
    const report = await reconcileAll({ dryRun: true, fix: false });

    // Dropped resolution must NOT have run
    expect(report.total).toBe(1);
    expect(report.results).toHaveLength(1);

    const result = report.results[0];

    // Decision must remain LEAVE_REVIEW_REQUIRED / receipt_missing
    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("receipt_missing");

    // DB must NOT be updated
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
    expect(mockDb.upsertBlockResult.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Preservation 4 — existing MARK_FINALIZED path still works
  // receipt.status=1, EDMT owner matches wallet, mintTx matches txHash
  // Expected: MARK_FINALIZED (this path must NOT be broken by the fix)
  // -------------------------------------------------------------------------
  it("PRESERVATION 4: existing MARK_FINALIZED path still works (receipt=1, owner match, tx hash match)", async () => {
    // Set up the MARK_FINALIZED scenario
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24987708,
      transactionHash: DROPPED_TX.tx_hash,
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24987708,
      status: "minted",
      owner: "0x16fc000000000000000000000000000000000001", // our wallet — owner match
      mintTx: DROPPED_TX.tx_hash, // tx hash match
      edmtStatusConfirmed: true,
      burnGwei: BigInt(1000),
    });

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");

    const result = await resolveReviewRequired(DROPPED_TX, { dryRun: true, fix: false });

    // Must still return MARK_FINALIZED — this path must not be broken
    expect(result.decision).toBe(ReconcileDecision.MARK_FINALIZED);
    expect(result.reason).toBe("all_checks_passed");
  });

  // -------------------------------------------------------------------------
  // Preservation 5 — dry-run mode, DB never written
  // Bug condition inputs (dropped tx) but dryRun=true, fix=false
  // Expected: updateTxStatusWithReason and upsertBlockResult are NEVER called
  // -------------------------------------------------------------------------
  it("PRESERVATION 5: dry-run mode → DB never written (updateTxStatusWithReason and upsertBlockResult not called)", async () => {
    // Bug condition inputs
    mockEthClient.getTransactionReceipt.mockResolvedValue(null);
    mockEthClient.getTransaction.mockResolvedValue(null);
    mockEthClient.getLatestNonce.mockResolvedValue(15);

    const { reconcileAll } = await import("../src/reconciler.js");

    // dry-run mode: dryRun=true, fix=false
    const report = await reconcileAll({ dryRun: true, fix: false });

    // DB must NOT be written in dry-run mode
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
    expect(mockDb.upsertBlockResult.mock.calls.length).toBe(0);

    // Report should still be returned
    expect(report).toBeDefined();
    expect(report.dryRun).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Preservation 6 — receipt.status=0 (failed tx) stays on existing path
  // Expected: LEAVE_REVIEW_REQUIRED / receipt_failed (NOT marked as dropped)
  // -------------------------------------------------------------------------
  it("PRESERVATION 6: receipt.status=0 (failed tx) → LEAVE_REVIEW_REQUIRED / receipt_failed, NOT dropped", async () => {
    // receipt exists but status=0 (tx failed on chain)
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 0,
      blockNumber: 24987708,
      transactionHash: DROPPED_TX.tx_hash,
    });

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");

    const result = await resolveReviewRequired(DROPPED_TX, { dryRun: true, fix: false });

    // Must return LEAVE_REVIEW_REQUIRED / receipt_failed — NOT dropped
    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("receipt_failed");

    // DB must NOT be updated
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
    expect(mockDb.upsertBlockResult.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Preservation 7 — owner mismatch does NOT produce successful_mint
  // receipt.status=1, EDMT block minted, but owner = "0xSOMEONEELSE"
  // Expected: LEAVE_REVIEW_REQUIRED / owner_mismatch (NOT MARK_FINALIZED)
  // -------------------------------------------------------------------------
  it("PRESERVATION 7: owner mismatch → LEAVE_REVIEW_REQUIRED / owner_mismatch, NOT MARK_FINALIZED", async () => {
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24987708,
      transactionHash: DROPPED_TX.tx_hash,
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24987708,
      status: "minted",
      owner: "0xSOMEONEELSE000000000000000000000000000001", // different owner — mismatch
      mintTx: DROPPED_TX.tx_hash,
      edmtStatusConfirmed: true,
      burnGwei: BigInt(1000),
    });

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");

    const result = await resolveReviewRequired(DROPPED_TX, { dryRun: true, fix: false });

    // Must return LEAVE_REVIEW_REQUIRED / owner_mismatch — NOT MARK_FINALIZED
    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("owner_mismatch");

    // DB must NOT be updated
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
    expect(mockDb.upsertBlockResult.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Preservation 8 — tx hash mismatch does NOT produce successful_mint
  // receipt.status=1, EDMT block minted, owner matches, but mintTx = "0xDIFFERENTHASH"
  // Expected: LEAVE_REVIEW_REQUIRED / tx_hash_mismatch (NOT MARK_FINALIZED)
  // -------------------------------------------------------------------------
  it("PRESERVATION 8: tx hash mismatch → LEAVE_REVIEW_REQUIRED / tx_hash_mismatch, NOT MARK_FINALIZED", async () => {
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24987708,
      transactionHash: DROPPED_TX.tx_hash,
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24987708,
      status: "minted",
      owner: "0x16fc000000000000000000000000000000000001", // our wallet — owner match
      mintTx: "0xDIFFERENTHASH000000000000000000000000000000000000000000000000000001", // different tx hash
      edmtStatusConfirmed: true,
      burnGwei: BigInt(1000),
    });

    const { resolveReviewRequired, ReconcileDecision } = await import("../src/reconciler.js");

    const result = await resolveReviewRequired(DROPPED_TX, { dryRun: true, fix: false });

    // Must return LEAVE_REVIEW_REQUIRED / tx_hash_mismatch — NOT MARK_FINALIZED
    expect(result.decision).toBe(ReconcileDecision.LEAVE_REVIEW_REQUIRED);
    expect(result.reason).toBe("tx_hash_mismatch");

    // DB must NOT be updated
    expect(mockDb.updateTxStatusWithReason.mock.calls.length).toBe(0);
    expect(mockDb.upsertBlockResult.mock.calls.length).toBe(0);
  });
});
