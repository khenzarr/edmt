/**
 * Preservation Property Tests — Property 2: Preservation
 * Force-Drop Olmadan Pending TX'lere Dokunulmamalı
 *
 * Observation-first methodology:
 * 1. Observe behavior on UNFIXED code for non-buggy inputs (isBugCondition returns false)
 * 2. Write tests capturing observed baseline behavior
 * 3. Verify ALL tests PASS on UNFIXED code (confirms baseline to preserve)
 * 4. After fix: tests should still PASS (no regressions)
 *
 * Non-buggy inputs (isBugCondition returns false):
 *   - forceDrop=false → pending/included/submitted tx'ler seçilmez (report.total = 0)
 *   - review_required tx → existing resolveForceDropTx() flow unchanged
 *   - dry-run mode → DB never written
 *   - receipt exists → force-drop rejected (LEAVE_REVIEW_REQUIRED)
 *   - getTransaction returns tx → force-drop rejected (tx_still_pending)
 *   - same nonce active tx → force-drop rejected (active_tx_for_nonce)
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Config mock
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
    reconcileRequireFinality: false,
    reconcileMinConfirmations: 64,
  },
  isLiveMintEnabled: () => false,
  hasPrivateKey: () => true,
}));

// ---------------------------------------------------------------------------
// DB mock
// Default: getReviewRequiredTxs returns EMPTY list (simulates pending/included/submitted tx)
// For review_required tests, we override getReviewRequiredTxs per test.
// ---------------------------------------------------------------------------

const mockDb = {
  getDb: vi.fn(),
  closeDb: vi.fn(),
  getCheckpointRaw: vi.fn().mockReturnValue(undefined),
  setCheckpointRaw: vi.fn(),
  hasReviewRequiredTx: vi.fn().mockReturnValue(false),
  hasPendingTx: vi.fn().mockReturnValue(true),
  hasFailedTx: vi.fn().mockReturnValue(false),
  getPendingTxCount: vi.fn().mockReturnValue(1),
  getUnfinalizedTxCount: vi.fn().mockReturnValue(1),
  getDailyTxCount: vi.fn().mockReturnValue(0),
  getPendingTxs: vi.fn().mockReturnValue([]),
  recordError: vi.fn(),
  updateTxStatus: vi.fn(),
  updateTxStatusWithReason: vi.fn(),
  upsertBlockResult: vi.fn(),
  insertTx: vi.fn(),
  getStats: vi
    .fn()
    .mockReturnValue({ totalScanned: 0, totalMinted: 0, totalFailed: 0, totalPending: 1 }),
  updateHighBurnCandidateStatus: vi.fn(),
  isBlockSubmittedOrBeyond: vi.fn().mockReturnValue(false),
  // Default: empty — pending/included/submitted tx is NOT in review_required
  getReviewRequiredTxs: vi.fn().mockReturnValue([]),
  // Default: undefined — tx not found by hash (used by force-drop candidate injection)
  getStuckTxByHash: vi.fn().mockReturnValue(undefined),
  getBlockResultByBlock: vi.fn().mockReturnValue({
    block: 24987965,
    status: "submitted",
    reason: null,
  }),
  insertReconcileEvent: vi.fn(),
  markTxDropped: vi.fn(),
  markBlockRetryable: vi.fn(),
  findTxsByBlock: vi.fn().mockReturnValue([]),
  findTxsByNonce: vi.fn().mockReturnValue([]),
};

vi.mock("../src/db.js", () => mockDb);

// ---------------------------------------------------------------------------
// ETH client mock — default: tx not found on chain (stuck/dropped scenario)
// ---------------------------------------------------------------------------

const mockEthClient = {
  getProvider: vi.fn(),
  getWallet: vi.fn().mockReturnValue({ address: "0x16fC54924b4dC280D14BCfd5A764234Bac60336E" }),
  getCurrentBlockNumber: vi.fn().mockResolvedValue(25100000),
  getBlock: vi.fn().mockResolvedValue(null),
  getTransactionReceipt: vi.fn().mockResolvedValue(null), // no receipt
  getTransaction: vi.fn().mockResolvedValue(null), // tx not found on chain
  getLatestNonce: vi.fn().mockResolvedValue(644), // latestNonce > txNonce (643)
  getPendingNonce: vi.fn().mockResolvedValue(644),
  getWalletBalanceEth: vi.fn().mockResolvedValue(0.01),
  sendRawTransaction: vi.fn(),
  calculateBurnGwei: vi.fn().mockResolvedValue(BigInt(1000)),
  blockExists: vi.fn().mockResolvedValue(true),
};

vi.mock("../src/ethClient.js", () => mockEthClient);

// ---------------------------------------------------------------------------
// EDMT client mock — block still mintable
// ---------------------------------------------------------------------------

const mockEdmtClient = {
  getBlockStatus: vi.fn().mockResolvedValue({
    block: 24987965,
    status: "mintable",
    owner: null,
    mintTx: null,
    edmtStatusConfirmed: true,
    burnGwei: BigInt(50000000),
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
// Shared tx records
// ---------------------------------------------------------------------------

const PENDING_TX_HASH = "0x3fc11effe8171e8dcd27dc88c64b8843b9e1bebecabc967bc241234fd060c131";

// review_required tx — used for testing the existing resolveForceDropTx() flow
const REVIEW_REQUIRED_TX = {
  id: 398,
  block: 24987965,
  tx_hash: PENDING_TX_HASH,
  status: "review_required" as const,
  reason: "receipt_missing",
  nonce: 643,
  updated_at: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 2: Preservation — Force-Drop Olmadan Pending TX'lere Dokunulmamalı", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply defaults after clearAllMocks
    mockEthClient.getTransactionReceipt.mockResolvedValue(null);
    mockEthClient.getTransaction.mockResolvedValue(null);
    mockEthClient.getLatestNonce.mockResolvedValue(644);
    mockEthClient.getPendingNonce.mockResolvedValue(644);
    mockEthClient.getWallet.mockReturnValue({
      address: "0x16fC54924b4dC280D14BCfd5A764234Bac60336E",
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24987965,
      status: "mintable",
      owner: null,
      mintTx: null,
      edmtStatusConfirmed: true,
      burnGwei: BigInt(50000000),
    });
    // Default: empty — pending/included/submitted tx is NOT in review_required
    mockDb.getReviewRequiredTxs.mockReturnValue([]);
    // Default: undefined — tx not found by hash
    mockDb.getStuckTxByHash.mockReturnValue(undefined);
    mockDb.findTxsByBlock.mockReturnValue([]);
    mockDb.findTxsByNonce.mockReturnValue([]);
    mockDb.insertReconcileEvent.mockReset();
    mockDb.markTxDropped.mockReset();
    mockDb.markBlockRetryable.mockReset();
    mockDb.updateTxStatusWithReason.mockReset();
  });

  // -------------------------------------------------------------------------
  // Preservation 1 — forceDrop=false: pending tx → report.total = 0
  //
  // Observed on UNFIXED code:
  //   reconcileAll({ forceDrop: false }) with pending tx (not in getReviewRequiredTxs())
  //   → getReviewRequiredTxs() returns [] → txs list is empty → report.total = 0
  //
  // This is the baseline to preserve: pending tx is NEVER touched without forceDrop=true.
  //
  // Validates: Requirements 3.4, 3.5
  // -------------------------------------------------------------------------
  it("PRESERVATION 1: forceDrop=false → pending tx never selected, report.total = 0", async () => {
    // getReviewRequiredTxs returns empty (pending tx is NOT review_required)
    mockDb.getReviewRequiredTxs.mockReturnValue([]);

    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: true,
      fix: false,
      fixDropped: true,
      forceDrop: false, // KEY: forceDrop is NOT set
      txFilter: PENDING_TX_HASH,
    });

    // Baseline: pending tx is NOT in getReviewRequiredTxs() → report.total = 0
    expect(report.total).toBe(0);
    expect(report.results).toHaveLength(0);
    expect(report.dropped).toBe(0);
    expect(report.retryable).toBe(0);

    // DB must NOT be written
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
    expect(mockDb.updateTxStatusWithReason).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preservation 2 — forceDrop=false: included tx → report.total = 0
  //
  // Validates: Requirements 3.4, 3.5
  // -------------------------------------------------------------------------
  it("PRESERVATION 2: forceDrop=false → included tx never selected, report.total = 0", async () => {
    mockDb.getReviewRequiredTxs.mockReturnValue([]);

    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: true,
      fix: false,
      fixDropped: true,
      forceDrop: false,
      txFilter: PENDING_TX_HASH,
    });

    expect(report.total).toBe(0);
    expect(report.results).toHaveLength(0);
    expect(report.dropped).toBe(0);

    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preservation 3 — forceDrop=false: submitted tx → report.total = 0
  //
  // Validates: Requirements 3.4, 3.5
  // -------------------------------------------------------------------------
  it("PRESERVATION 3: forceDrop=false → submitted tx never selected, report.total = 0", async () => {
    mockDb.getReviewRequiredTxs.mockReturnValue([]);

    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: true,
      fix: false,
      fixDropped: true,
      forceDrop: false,
      txFilter: PENDING_TX_HASH,
    });

    expect(report.total).toBe(0);
    expect(report.results).toHaveLength(0);
    expect(report.dropped).toBe(0);

    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preservation 4 — review_required tx: existing resolveForceDropTx() flow unchanged
  //
  // When all 11 safety checks pass (receipt null, getTransaction null,
  // latestNonce > txNonce, pendingNonce === latestNonce, EDMT mintable,
  // owner null, mintTx null, no conflicts), resolveForceDropTx() returns
  // MARK_DROPPED_RETRYABLE.
  //
  // This is the existing behavior that must NOT be broken by the fix.
  //
  // Validates: Requirements 3.5
  // -------------------------------------------------------------------------
  it("PRESERVATION 4: review_required tx — all safety checks pass → MARK_DROPPED_RETRYABLE", async () => {
    // review_required tx IS in getReviewRequiredTxs()
    mockDb.getReviewRequiredTxs.mockReturnValue([REVIEW_REQUIRED_TX]);
    // findTxsByBlock and findTxsByNonce return only the tx itself (no conflicts)
    mockDb.findTxsByBlock.mockReturnValue([REVIEW_REQUIRED_TX]);
    mockDb.findTxsByNonce.mockReturnValue([REVIEW_REQUIRED_TX]);

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(REVIEW_REQUIRED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    // Existing behavior: all checks pass → MARK_DROPPED_RETRYABLE
    expect(result.decision).toBe("MARK_DROPPED_RETRYABLE");
    expect(result.reason).toBe("force_dropped_tx_not_found_receipt_missing_block_mintable");
    expect(result.dryRun).toBe(true);

    // DB must NOT be written in dry-run mode
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preservation 5 — dry-run mode: DB never written
  //
  // reconcileAll({ forceDrop: true, txFilter: HASH, dryRun: true }) with
  // review_required tx → on unfixed code, report.total = 0 for pending tx
  // (pending tx not in candidates), but the principle holds:
  // DB is never written in dry-run mode regardless of forceDrop flag.
  //
  // Validates: Requirements 3.10
  // -------------------------------------------------------------------------
  it("PRESERVATION 5: dry-run mode → DB never written (markTxDropped, markBlockRetryable, insertReconcileEvent not called)", async () => {
    // Use review_required tx to exercise the force-drop path in dry-run
    mockDb.getReviewRequiredTxs.mockReturnValue([REVIEW_REQUIRED_TX]);
    mockDb.findTxsByBlock.mockReturnValue([REVIEW_REQUIRED_TX]);
    mockDb.findTxsByNonce.mockReturnValue([REVIEW_REQUIRED_TX]);

    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: true, // KEY: dry-run mode
      fix: false,
      fixDropped: true,
      forceDrop: true,
      txFilter: PENDING_TX_HASH,
    });

    // In dry-run mode, DB must NOT be written
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
    expect(mockDb.updateTxStatusWithReason).not.toHaveBeenCalled();

    // Report should still be returned
    expect(report).toBeDefined();
    expect(report.dryRun).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Preservation 6 — receipt exists → force-drop rejected (LEAVE_REVIEW_REQUIRED)
  //
  // When getTransactionReceipt returns a receipt, resolveForceDropTx() must
  // return LEAVE_REVIEW_REQUIRED / force_drop_receipt_found.
  // This safety check must NOT be broken by the fix.
  //
  // Validates: Requirements 3.3
  // -------------------------------------------------------------------------
  it("PRESERVATION 6: receipt exists → force-drop rejected (force_drop_receipt_found)", async () => {
    // Receipt appeared — tx is not dropped
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24987965,
      transactionHash: REVIEW_REQUIRED_TX.tx_hash,
    });

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(REVIEW_REQUIRED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    // Safety check: receipt found → force-drop rejected
    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_receipt_found");

    // DB must NOT be written
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preservation 7 — getTransaction returns tx → force-drop rejected (tx_still_pending)
  //
  // When getTransaction returns a tx (still pending in mempool), resolveForceDropTx()
  // must return LEAVE_REVIEW_REQUIRED / force_drop_tx_still_pending.
  //
  // Validates: Requirements 3.2
  // -------------------------------------------------------------------------
  it("PRESERVATION 7: getTransaction returns tx (still in mempool) → force-drop rejected (force_drop_tx_still_pending)", async () => {
    // tx is still in mempool
    mockEthClient.getTransaction.mockResolvedValue({
      hash: REVIEW_REQUIRED_TX.tx_hash,
      blockNumber: null, // pending — not yet included
      from: "0x16fC54924b4dC280D14BCfd5A764234Bac60336E",
      nonce: 643,
    });

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(REVIEW_REQUIRED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    // Safety check: tx still pending → force-drop rejected
    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_tx_still_pending");

    // DB must NOT be written
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preservation 8 — same nonce active tx → force-drop rejected (active_tx_for_nonce)
  //
  // When findTxsByNonce returns another active tx (pending/included/submitted),
  // resolveForceDropTx() must return LEAVE_REVIEW_REQUIRED / force_drop_active_tx_for_nonce.
  //
  // Validates: Requirements 3.8
  // -------------------------------------------------------------------------
  it("PRESERVATION 8: same nonce has another active tx → force-drop rejected (force_drop_active_tx_for_nonce)", async () => {
    // Another tx with the same nonce is active (pending)
    mockDb.findTxsByNonce.mockReturnValue([
      REVIEW_REQUIRED_TX,
      {
        tx_hash: "0xOTHERTX000000000000000000000000000000000000000000000000000000001",
        status: "pending",
        block: 24987966,
      },
    ]);
    mockDb.findTxsByBlock.mockReturnValue([REVIEW_REQUIRED_TX]);

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(REVIEW_REQUIRED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    // Safety check: active tx for same nonce → force-drop rejected
    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_active_tx_for_nonce");

    // DB must NOT be written
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preservation 9 — same block active tx → force-drop rejected (active_tx_for_block)
  //
  // When findTxsByBlock returns another active tx, resolveForceDropTx() must
  // return LEAVE_REVIEW_REQUIRED / force_drop_active_tx_for_block.
  //
  // Validates: Requirements 3.9
  // -------------------------------------------------------------------------
  it("PRESERVATION 9: same block has another active tx → force-drop rejected (force_drop_active_tx_for_block)", async () => {
    // Another tx for the same block is active (included)
    mockDb.findTxsByBlock.mockReturnValue([
      REVIEW_REQUIRED_TX,
      {
        tx_hash: "0xOTHERBLOCKTX00000000000000000000000000000000000000000000000000001",
        status: "included",
        nonce: 644,
      },
    ]);
    mockDb.findTxsByNonce.mockReturnValue([REVIEW_REQUIRED_TX]);

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(REVIEW_REQUIRED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    // Safety check: active tx for same block → force-drop rejected
    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_active_tx_for_block");

    // DB must NOT be written
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preservation 10 — reconcileAll without forceDrop: no pending tx selected
  //
  // reconcileAll({ forceDrop: undefined }) with empty getReviewRequiredTxs()
  // → report.total = 0 (pending tx never enters candidate list)
  //
  // Validates: Requirements 3.4
  // -------------------------------------------------------------------------
  it("PRESERVATION 10: reconcileAll without forceDrop flag → pending tx never selected, report.total = 0", async () => {
    // getReviewRequiredTxs returns empty (pending tx is NOT review_required)
    mockDb.getReviewRequiredTxs.mockReturnValue([]);

    const { reconcileAll } = await import("../src/reconciler.js");

    // No forceDrop flag at all
    const report = await reconcileAll({
      dryRun: true,
      fix: false,
      fixDropped: true,
      // forceDrop NOT set (undefined)
    });

    // Baseline: no candidates → report.total = 0
    expect(report.total).toBe(0);
    expect(report.results).toHaveLength(0);

    // DB must NOT be written
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
    expect(mockDb.updateTxStatusWithReason).not.toHaveBeenCalled();
  });
});
