/**
 * Bug Condition Exploration Tests — Duplicate TX Gate Fix
 *
 * Property 1: Bug Condition — Terminal Statüsteki TX Mint'i Engelliyor
 *
 * These tests MUST FAIL on unfixed code — failure confirms the bug exists.
 * When the fix is applied, these tests will PASS.
 *
 * Bug: Gate 9 in mintExecutor.ts blocks mint when getTxByBlock(block) returns
 * ANY tx record, regardless of status. So existingTx.status='dropped' or 'failed'
 * incorrectly returns skipped_duplicate_tx.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
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
// Bug Condition Exploration Tests
// ---------------------------------------------------------------------------

describe("MintExecutor — Gate 9 Bug Condition Exploration", () => {
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
   * Bug Condition 1: existingTx.status = 'dropped'
   *
   * Production example: Block 24987965, tx 0x3fc11effe... was force-dropped to 'dropped'
   * status, block was made retryable, EDMT returns mintable — but Gate 9 incorrectly
   * blocks the new mint attempt.
   *
   * EXPECTED ON UNFIXED CODE: FAILS (result.status === 'skipped_duplicate_tx')
   * EXPECTED AFTER FIX: PASSES (result.status !== 'skipped_duplicate_tx')
   *
   * Validates: Requirements 1.1, 1.3
   */
  it("dropped tx should NOT block mint — Gate 9 should pass for terminal status", async () => {
    mockGetTxByBlock.mockReturnValue({
      tx_hash: "0x3fc11effe8171e8dcd27dc88c64b8843b9e1bebecabc967bc241234fd060c131",
      status: "dropped",
      nonce: 42,
    });

    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);

    // This assertion FAILS on unfixed code (bug confirmed):
    // unfixed code returns 'skipped_duplicate_tx' for dropped tx
    expect(result.status).not.toBe("skipped_duplicate_tx");
  });

  /**
   * Bug Condition 2: existingTx.status = 'failed'
   *
   * A tx that previously failed should not prevent a new mint attempt.
   * Gate 9 should treat 'failed' as a terminal/resolved status and allow mint.
   *
   * EXPECTED ON UNFIXED CODE: FAILS (result.status === 'skipped_duplicate_tx')
   * EXPECTED AFTER FIX: PASSES (result.status !== 'skipped_duplicate_tx')
   *
   * Validates: Requirements 1.2
   */
  it("failed tx should NOT block mint — Gate 9 should pass for terminal status", async () => {
    mockGetTxByBlock.mockReturnValue({
      tx_hash: "0x3fc11effe8171e8dcd27dc88c64b8843b9e1bebecabc967bc241234fd060c131",
      status: "failed",
      nonce: 42,
    });

    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);

    // This assertion FAILS on unfixed code (bug confirmed):
    // unfixed code returns 'skipped_duplicate_tx' for failed tx
    expect(result.status).not.toBe("skipped_duplicate_tx");
  });
});
