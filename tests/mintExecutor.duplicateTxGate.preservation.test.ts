/**
 * Preservation Property Tests — Duplicate TX Gate Fix
 *
 * Property 2: Preservation — Aktif Statüsteki TX'ler Hâlâ Bloklanmalıdır
 *
 * These tests verify that the EXISTING correct behavior is preserved:
 * - Active tx statuses (pending, submitted, included, finalized, successful_mint)
 *   still block mint with skipped_duplicate_tx
 * - When getTxByBlock returns undefined, Gate 9 passes (mint continues)
 *
 * These tests MUST PASS on unfixed code (confirms baseline behavior to preserve).
 * They must also PASS after the fix is applied (confirms no regressions).
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mutable config
// ---------------------------------------------------------------------------
const mockConfig = {
  dryRun: false,
  enableLiveMint: true,
  privateKey: "0xdeadbeef",
  maxGasGwei: 80,
  maxPriorityFeeGwei: 3,
  maxCaptureFeeGwei: BigInt(1_000_000_000),
  maxTxPerRun: 10,
  requireManualConfirmationForFirstTx: false,
  allowMultiplePendingTx: false,
  rpcUrl: "http://localhost:8545",
  startBlock: 12965000,
  sqlitePath: ":memory:",
  apiRetryLimit: 1,
  rpcRetryLimit: 1,
  minBurnGwei: BigInt(1),
  beyondHeadBehavior: "wait",
  finalityConfirmations: 64,
  pollIntervalMs: 3000,
  scanDirection: "ascending",
  maxBlocksPerRun: 1000,
  stopBlock: undefined,
  edmtBaseUrl: "https://www.edmt.io",
  edmtApiBaseUrl: "https://www.edmt.io/api/v1",
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
    MINT_DRY_RUN: "mint_dry_run",
    MINT_SUBMITTED: "mint_submitted",
    MINT_SKIPPED: "mint_skipped",
    MINT_GATE_FAILED: "mint_gate_failed",
    BLOCK_DECISION: "block_decision",
    API_UNAVAILABLE: "api_unavailable",
    CHECKPOINT_ADVANCED: "checkpoint_advanced",
    PIPELINE_DUPLICATE_PREVENTED: "pipeline_duplicate_prevented",
    PIPELINE_NONCE_ANOMALY: "pipeline_nonce_anomaly",
  },
}));

// ---------------------------------------------------------------------------
// Mock ethClient
// ---------------------------------------------------------------------------
const mockSendRawTransaction = vi.fn();
const mockGetFeeData = vi.fn(() =>
  Promise.resolve({
    maxFeePerGas: BigInt(50_000_000_000), // 50 gwei — within limit
    maxPriorityFeePerGas: BigInt(2_000_000_000), // 2 gwei
  })
);
const mockGetWallet = vi.fn(() => ({ address: "0xWALLET" }));

vi.mock("../src/ethClient.js", () => ({
  getFeeData: mockGetFeeData,
  sendRawTransaction: mockSendRawTransaction,
  getWallet: mockGetWallet,
}));

// ---------------------------------------------------------------------------
// Mock feeQuoter — fee gate passes
// ---------------------------------------------------------------------------
vi.mock("../src/feeQuoter.js", () => ({
  getRequiredFee: vi.fn(() => Promise.resolve({ feeRequired: false, quoteAvailable: true })),
  isFeeAcceptable: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------
const mockGetTxByBlock = vi.fn(() => undefined);
const mockHasPendingTx = vi.fn(() => false);
const mockInsertTx = vi.fn();
const mockIsBlockSubmittedOrBeyond = vi.fn(() => false);

vi.mock("../src/db.js", () => ({
  getTxByBlock: mockGetTxByBlock,
  hasPendingTx: mockHasPendingTx,
  insertTx: mockInsertTx,
  isBlockSubmittedOrBeyond: mockIsBlockSubmittedOrBeyond,
  upsertBlockResult: vi.fn(),
  recordError: vi.fn(),
  getCheckpointRaw: vi.fn(),
  setCheckpointRaw: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock checkpoint
// ---------------------------------------------------------------------------
vi.mock("../src/checkpoint.js", () => ({
  setSubmittedBlock: vi.fn(),
  advanceScannedBlock: vi.fn(),
  getCheckpoint: vi.fn(),
  initCheckpoint: vi.fn(),
  setCheckpoint: vi.fn(),
  setSuccessfulMintBlock: vi.fn(),
  recordCheckpointError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mintable block fixture — all other gates pass
// ---------------------------------------------------------------------------
const mintableBlock = {
  block: 24987965,
  status: "mintable" as const,
  burnGwei: 100n,
  feeRequired: false,
  edmtStatusConfirmed: true,
};

// ---------------------------------------------------------------------------
// Preservation Tests
// ---------------------------------------------------------------------------

describe("MintExecutor — Gate 9 Preservation (active statuses still block mint)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetRunState } = await import("../src/mintExecutor.js");
    resetRunState();
    mockGetTxByBlock.mockReturnValue(undefined);
    mockHasPendingTx.mockReturnValue(false);
    mockIsBlockSubmittedOrBeyond.mockReturnValue(false);
    mockSendRawTransaction.mockResolvedValue({ hash: "0xtxhash", nonce: 5 });
  });

  /**
   * Preservation 1: existingTx.status = 'pending'
   * An in-flight pending tx must still block a new mint attempt.
   * Validates: Requirement 3.1
   */
  it("pending tx still blocks mint — skipped_duplicate_tx returned", async () => {
    mockGetTxByBlock.mockReturnValue({
      tx_hash: "0xpending_tx_hash",
      status: "pending",
      nonce: 42,
    });

    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);

    expect(result.status).toBe("skipped_duplicate_tx");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  /**
   * Preservation 2: existingTx.status = 'submitted'
   * A submitted tx must still block a new mint attempt.
   * Validates: Requirement 3.2
   */
  it("submitted tx still blocks mint — skipped_duplicate_tx returned", async () => {
    mockGetTxByBlock.mockReturnValue({
      tx_hash: "0xsubmitted_tx_hash",
      status: "submitted",
      nonce: 42,
    });

    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);

    expect(result.status).toBe("skipped_duplicate_tx");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  /**
   * Preservation 3: existingTx.status = 'included'
   * An included tx must still block a new mint attempt.
   * Validates: Requirement 3.3
   */
  it("included tx still blocks mint — skipped_duplicate_tx returned", async () => {
    mockGetTxByBlock.mockReturnValue({
      tx_hash: "0xincluded_tx_hash",
      status: "included",
      nonce: 42,
    });

    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);

    expect(result.status).toBe("skipped_duplicate_tx");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  /**
   * Preservation 4: existingTx.status = 'finalized'
   * A finalized tx must still block a new mint attempt.
   * Validates: Requirement 3.4
   */
  it("finalized tx still blocks mint — skipped_duplicate_tx returned", async () => {
    mockGetTxByBlock.mockReturnValue({
      tx_hash: "0xfinalized_tx_hash",
      status: "finalized",
      nonce: 42,
    });

    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);

    expect(result.status).toBe("skipped_duplicate_tx");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  /**
   * Preservation 5: existingTx.status = 'successful_mint'
   * A successfully minted tx must still block a new mint attempt.
   * Validates: Requirement 3.5
   */
  it("successful_mint tx still blocks mint — skipped_duplicate_tx returned", async () => {
    mockGetTxByBlock.mockReturnValue({
      tx_hash: "0xsuccessful_mint_tx_hash",
      status: "successful_mint",
      nonce: 42,
    });

    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);

    expect(result.status).toBe("skipped_duplicate_tx");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  /**
   * Preservation 6: getTxByBlock returns undefined
   * When no tx record exists for the block, Gate 9 must pass (not block mint).
   * Validates: Requirement 3.6
   */
  it("no tx record — Gate 9 passes, mint is not blocked by duplicate check", async () => {
    mockGetTxByBlock.mockReturnValue(undefined);

    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);

    // Gate 9 passes — result should NOT be skipped_duplicate_tx
    expect(result.status).not.toBe("skipped_duplicate_tx");
  });
});
