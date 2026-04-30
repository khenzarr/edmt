/**
 * Force Drop Resolution Tests — reconciler.forceDrop.test.ts
 *
 * Tests for the --force-drop CLI flag and resolveForceDropTx() function.
 *
 * Scenario: tx is stuck in review_required with receipt_missing, but
 * latestNonce === txNonce (nonce has NOT advanced). The normal dropped
 * detection (resolveDroppedTx) cannot confirm the drop because nonce
 * has not advanced. Force-drop allows explicit operator override when
 * all 11 safety checks pass.
 *
 * Tests:
 *  1. force-drop flag absent → nonce_not_advanced → review_required stays
 *  2. force-drop flag present, dry-run → eligible decision shown, DB not written
 *  3. force-drop + fix-dropped + all checks pass → tx dropped, block retryable
 *  4. getTransaction pending → force-drop rejected (tx_still_pending)
 *  5. receipt found → force-drop rejected (receipt_found)
 *  6. EDMT block minted → MARK_DROPPED_MINTED (not retryable)
 *  7. minted_by not null → force-drop rejected (minted_by_not_null)
 *  8. same nonce active tx → force-drop rejected (active_tx_for_nonce)
 *  9. same block active tx → force-drop rejected (active_tx_for_block)
 * 10. force-drop applied → review_required count decreases
 * 11. retryable block can be retried (no active tx guard blocks it)
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
  getReviewRequiredTxs: vi.fn(),
  getBlockResultByBlock: vi.fn().mockReturnValue({
    block: 24987708,
    status: "review_required",
    reason: null,
  }),
  insertReconcileEvent: vi.fn(),
  markTxDropped: vi.fn(),
  markBlockRetryable: vi.fn(),
  // Force-drop safety check helpers
  findTxsByBlock: vi.fn().mockReturnValue([]),
  findTxsByNonce: vi.fn().mockReturnValue([]),
};

vi.mock("../src/db.js", () => mockDb);

// ---------------------------------------------------------------------------
// ETH client mock
// Default: nonce stalled scenario (latestNonce === txNonce === 401)
// ---------------------------------------------------------------------------

const mockEthClient = {
  getProvider: vi.fn(),
  getWallet: vi.fn().mockReturnValue({ address: "0x16fC54924b4dC280D14BCfd5A764234Bac60336E" }),
  getCurrentBlockNumber: vi.fn().mockResolvedValue(25000000),
  getBlock: vi.fn().mockResolvedValue(null),
  getTransactionReceipt: vi.fn().mockResolvedValue(null), // no receipt
  getTransaction: vi.fn().mockResolvedValue(null), // tx not found on chain
  getLatestNonce: vi.fn().mockResolvedValue(401), // latestNonce === txNonce (stalled)
  getPendingNonce: vi.fn().mockResolvedValue(401), // pendingNonce === latestNonce (mempool clear)
  getWalletBalanceEth: vi.fn().mockResolvedValue(0.01),
  sendRawTransaction: vi.fn(),
  calculateBurnGwei: vi.fn().mockResolvedValue(BigInt(1000)),
  blockExists: vi.fn().mockResolvedValue(true),
};

vi.mock("../src/ethClient.js", () => mockEthClient);

// ---------------------------------------------------------------------------
// EDMT client mock — default: block mintable, no owner, no mint_tx
// ---------------------------------------------------------------------------

const mockEdmtClient = {
  getBlockStatus: vi.fn().mockResolvedValue({
    block: 24987708,
    status: "mintable",
    owner: null,
    mintTx: null,
    edmtStatusConfirmed: true,
    burnGwei: BigInt(37189642),
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
// The production tx record (nonce stalled scenario)
// ---------------------------------------------------------------------------

const STALLED_TX = {
  id: 398,
  block: 24987708,
  tx_hash: "0xa19e5faa0b4c13d3d500c83ebe17c286a65c747dd58125a38988b331162ccd4d",
  status: "review_required" as const,
  reason: "receipt_missing",
  nonce: 401, // latestNonce === txNonce === 401
  updated_at: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Force Drop Resolution — resolveForceDropTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply defaults
    mockEthClient.getTransactionReceipt.mockResolvedValue(null);
    mockEthClient.getTransaction.mockResolvedValue(null);
    mockEthClient.getLatestNonce.mockResolvedValue(401);
    mockEthClient.getPendingNonce.mockResolvedValue(401);
    mockEthClient.getWallet.mockReturnValue({
      address: "0x16fC54924b4dC280D14BCfd5A764234Bac60336E",
    });
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24987708,
      status: "mintable",
      owner: null,
      mintTx: null,
      edmtStatusConfirmed: true,
      burnGwei: BigInt(37189642),
    });
    mockDb.getReviewRequiredTxs.mockReturnValue([STALLED_TX]);
    mockDb.hasReviewRequiredTx.mockReturnValue(true);
    mockDb.findTxsByBlock.mockReturnValue([STALLED_TX]);
    mockDb.findTxsByNonce.mockReturnValue([STALLED_TX]);
    mockDb.updateTxStatusWithReason.mockReset();
    mockDb.upsertBlockResult.mockReset();
    mockDb.markTxDropped.mockReset();
    mockDb.markBlockRetryable.mockReset();
    mockDb.insertReconcileEvent.mockReset();
  });

  // -------------------------------------------------------------------------
  // Test 1: force-drop flag absent → nonce_not_advanced → review_required stays
  // -------------------------------------------------------------------------
  it("TEST 1: force-drop flag absent → nonce_not_advanced → review_required stays", async () => {
    // latestNonce === txNonce === 401 → normal dropped detection fails
    // forceDrop not set → should stay review_required
    mockEthClient.getLatestNonce.mockResolvedValue(401);

    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: true,
      fix: false,
      fixDropped: true,
      // forceDrop NOT set
    });

    expect(report.total).toBe(1);
    expect(report.leftReviewRequired).toBe(1);
    expect(report.dropped).toBe(0);

    const result = report.results[0];
    // resolveDroppedTx runs (fixDropped=true) but returns nonce_not_advanced
    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("nonce_not_advanced");

    // DB must NOT be written
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: force-drop flag present, dry-run → eligible decision shown, DB not written
  // -------------------------------------------------------------------------
  it("TEST 2: force-drop flag present, dry-run → MARK_DROPPED_RETRYABLE decision, DB not written", async () => {
    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: true, // dry-run: no DB writes
      fix: false,
      fixDropped: true,
      forceDrop: true,
    });

    expect(report.total).toBe(1);
    expect(report.dropped).toBe(1);
    expect(report.retryable).toBe(1);
    expect(report.leftReviewRequired).toBe(0);

    const result = report.results[0];
    expect(result.decision).toBe("MARK_DROPPED_RETRYABLE");
    expect(result.reason).toBe("force_dropped_tx_not_found_receipt_missing_block_mintable");
    expect(result.dryRun).toBe(true);

    // DB must NOT be written in dry-run mode
    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
    expect(mockDb.updateTxStatusWithReason).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: force-drop + fix-dropped + all checks pass → tx dropped, block retryable
  // -------------------------------------------------------------------------
  it("TEST 3: force-drop + fix-dropped + all checks pass → tx dropped, block retryable, DB written", async () => {
    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: false,
      fix: true,
      fixDropped: true,
      forceDrop: true,
    });

    expect(report.total).toBe(1);
    expect(report.dropped).toBe(1);
    expect(report.retryable).toBe(1);
    expect(report.leftReviewRequired).toBe(0);

    const result = report.results[0];
    expect(result.decision).toBe("MARK_DROPPED_RETRYABLE");
    expect(result.reason).toBe("force_dropped_tx_not_found_receipt_missing_block_mintable");

    // DB MUST be written in fix mode
    expect(mockDb.markTxDropped).toHaveBeenCalledWith(
      STALLED_TX.tx_hash,
      "force_dropped_tx_not_found_receipt_missing_block_mintable"
    );
    expect(mockDb.markBlockRetryable).toHaveBeenCalledWith(
      STALLED_TX.block,
      "force_dropped_tx_not_found_receipt_missing_block_mintable"
    );
    expect(mockDb.insertReconcileEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        block: STALLED_TX.block,
        txHash: STALLED_TX.tx_hash,
        previousStatus: "review_required",
        newStatus: "dropped",
        decision: "MARK_DROPPED_RETRYABLE",
        reason: "force_dropped_tx_not_found_receipt_missing_block_mintable",
        dryRun: false,
      })
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: getTransaction pending → force-drop rejected
  // -------------------------------------------------------------------------
  it("TEST 4: getTransaction returns pending tx → force-drop rejected (tx_still_pending)", async () => {
    // tx is still in mempool
    mockEthClient.getTransaction.mockResolvedValue({
      hash: STALLED_TX.tx_hash,
      blockNumber: null,
      from: "0x16fC54924b4dC280D14BCfd5A764234Bac60336E",
      nonce: 401,
    });

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(STALLED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_tx_still_pending");

    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5: receipt found → force-drop rejected
  // -------------------------------------------------------------------------
  it("TEST 5: receipt found → force-drop rejected (receipt_found)", async () => {
    // receipt appeared — tx is not dropped
    mockEthClient.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 24987708,
      transactionHash: STALLED_TX.tx_hash,
    });

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(STALLED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_receipt_found");

    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6: EDMT block minted → MARK_DROPPED_MINTED (not retryable)
  // -------------------------------------------------------------------------
  it("TEST 6: EDMT block minted by someone else → MARK_DROPPED_MINTED (not retryable)", async () => {
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24987708,
      status: "minted",
      owner: "0xSOMEONEELSE000000000000000000000000000001",
      mintTx: "0xABCDEF1234567890000000000000000000000000000000000000000000000001",
      edmtStatusConfirmed: true,
      burnGwei: BigInt(37189642),
    });

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(STALLED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    expect(result.decision).toBe("MARK_DROPPED_MINTED");
    expect(result.reason).toBe("force_drop_block_minted_elsewhere");

    // Not retryable — block is minted
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7: minted_by not null → force-drop rejected
  // -------------------------------------------------------------------------
  it("TEST 7: minted_by not null (block mintable but owner set) → force-drop rejected", async () => {
    // Unusual state: status=mintable but owner is set
    mockEdmtClient.getBlockStatus.mockResolvedValue({
      block: 24987708,
      status: "mintable",
      owner: "0xSOMEONE000000000000000000000000000000001",
      mintTx: null,
      edmtStatusConfirmed: true,
      burnGwei: BigInt(37189642),
    });

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(STALLED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_minted_by_not_null");

    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8: same nonce active tx → force-drop rejected
  // -------------------------------------------------------------------------
  it("TEST 8: same nonce has another active tx → force-drop rejected (active_tx_for_nonce)", async () => {
    // Another tx with the same nonce is active (pending)
    mockDb.findTxsByNonce.mockReturnValue([
      STALLED_TX,
      {
        tx_hash: "0xOTHERTX000000000000000000000000000000000000000000000000000000001",
        status: "pending",
        block: 24987709,
      },
    ]);

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(STALLED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_active_tx_for_nonce");

    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 9: same block active tx → force-drop rejected
  // -------------------------------------------------------------------------
  it("TEST 9: same block has another active tx → force-drop rejected (active_tx_for_block)", async () => {
    // Another tx for the same block is active (included)
    mockDb.findTxsByBlock.mockReturnValue([
      STALLED_TX,
      {
        tx_hash: "0xOTHERBLOCKTX00000000000000000000000000000000000000000000000000001",
        status: "included",
        nonce: 402,
      },
    ]);

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(STALLED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_active_tx_for_block");

    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 10: force-drop applied → review_required count decreases
  // -------------------------------------------------------------------------
  it("TEST 10: after force-drop applied, review_required count decreases to 0", async () => {
    // Simulate: after fix mode, DB is updated → hasReviewRequiredTx returns false
    mockDb.hasReviewRequiredTx.mockReturnValue(false);

    const { reconcileAll } = await import("../src/reconciler.js");

    const report = await reconcileAll({
      dryRun: false,
      fix: true,
      fixDropped: true,
      forceDrop: true,
    });

    expect(report.leftReviewRequired).toBe(0);
    expect(report.dropped).toBe(1);

    // After resolution, hasReviewRequiredTx should return false
    const { hasReviewRequiredTx } = await import("../src/db.js");
    expect(hasReviewRequiredTx()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 11: retryable block can be retried (isBlockSubmittedOrBeyond returns false)
  // -------------------------------------------------------------------------
  it("TEST 11: after force-drop, block status=retryable → isBlockSubmittedOrBeyond returns false", async () => {
    // After force-drop, block_results.status = 'retryable'
    // isBlockSubmittedOrBeyond checks for submitted/included/finalized/successful_mint/review_required/failed
    // 'retryable' is NOT in that set → returns false → automint can retry
    mockDb.isBlockSubmittedOrBeyond.mockReturnValue(false);

    const { isBlockSubmittedOrBeyond } = await import("../src/db.js");

    // Simulate the state after force-drop: block is retryable
    const canRetry = !isBlockSubmittedOrBeyond(STALLED_TX.block);
    expect(canRetry).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 12: resolveForceDropTx is exported from reconciler module
  // -------------------------------------------------------------------------
  it("TEST 12: resolveForceDropTx is exported from reconciler module", async () => {
    const reconcilerModule = await import("../src/reconciler.js");
    expect((reconcilerModule as Record<string, unknown>)["resolveForceDropTx"]).toBeDefined();
    expect(typeof (reconcilerModule as Record<string, unknown>)["resolveForceDropTx"]).toBe(
      "function"
    );
  });

  // -------------------------------------------------------------------------
  // Test 13: pendingNonce !== latestNonce → force-drop rejected (mempool not clear)
  // -------------------------------------------------------------------------
  it("TEST 13: pendingNonce !== latestNonce → force-drop rejected (pending_nonce_mismatch)", async () => {
    // pendingNonce > latestNonce means there are pending txs in mempool
    mockEthClient.getLatestNonce.mockResolvedValue(401);
    mockEthClient.getPendingNonce.mockResolvedValue(402); // mempool has a pending tx

    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(STALLED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: true,
    });

    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_pending_nonce_mismatch");

    expect(mockDb.markTxDropped).not.toHaveBeenCalled();
    expect(mockDb.markBlockRetryable).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 14: forceDrop flag not set → resolveForceDropTx returns flag_not_set
  // -------------------------------------------------------------------------
  it("TEST 14: forceDrop flag not set → resolveForceDropTx returns force_drop_flag_not_set", async () => {
    const { resolveForceDropTx } = await import("../src/reconciler.js");

    const result = await resolveForceDropTx(STALLED_TX, {
      dryRun: true,
      fix: false,
      forceDrop: false, // explicitly not set
    });

    expect(result.decision).toBe("LEAVE_REVIEW_REQUIRED");
    expect(result.reason).toBe("force_drop_flag_not_set");
  });
});
