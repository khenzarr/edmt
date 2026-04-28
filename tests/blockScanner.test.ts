/**
 * BlockScanner unit tests.
 * Tests 4, 5, 6 from the spec test plan.
 * All external dependencies (edmtClient, ethClient, db, checkpoint) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
vi.mock("../src/config.js", () => ({
  config: {
    startBlock: 12965000,
    stopBlock: undefined,
    scanDirection: "ascending",
    maxBlocksPerRun: 10,
    pollIntervalMs: 100,
    apiRetryLimit: 1,
    rpcRetryLimit: 1,
    minBurnGwei: BigInt(1),
    beyondHeadBehavior: "wait",
    sqlitePath: ":memory:",
    dryRun: true,
    enableLiveMint: false,
    privateKey: "",
    rpcUrl: "http://localhost:8545",
    maxTxPerRun: 1,
    maxGasGwei: 80,
    maxPriorityFeeGwei: 3,
    maxCaptureFeeGwei: BigInt(1_000_000_000),
    requireManualConfirmationForFirstTx: true,
    finalityConfirmations: 64,
    allowMultiplePendingTx: false,
    edmtBaseUrl: "https://www.edmt.io",
    edmtApiBaseUrl: "https://www.edmt.io/api/v1",
  },
  isLiveMintEnabled: () => false,
  hasPrivateKey: () => false,
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
    BLOCK_DECISION: "block_decision",
    BLOCK_BEYOND_HEAD: "block_beyond_head",
    BLOCK_NOT_ELIGIBLE: "block_not_eligible",
    BLOCK_MINTED: "block_minted",
    BLOCK_MINTABLE: "block_mintable",
    BLOCK_UNKNOWN: "block_unknown",
    CHECKPOINT_ADVANCED: "checkpoint_advanced",
    CHECKPOINT_HELD: "checkpoint_held",
    BOT_STOP: "bot_stop",
    DB_ERROR: "db_error",
    DB_WRITE: "db_write",
    API_RETRY: "api_retry",
    API_FALLBACK: "api_fallback",
    API_UNAVAILABLE: "api_unavailable",
    RPC_RETRY: "rpc_retry",
    RPC_ERROR: "rpc_error",
  },
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------
vi.mock("../src/db.js", () => ({
  upsertBlockResult: vi.fn(),
  recordError: vi.fn(),
  getCheckpointRaw: vi.fn(),
  setCheckpointRaw: vi.fn(),
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock checkpoint
// ---------------------------------------------------------------------------
const mockAdvanceScannedBlock = vi.fn();
const mockGetCheckpoint = vi.fn(() => 18000000);
const mockRecordCheckpointError = vi.fn();

vi.mock("../src/checkpoint.js", () => ({
  advanceScannedBlock: mockAdvanceScannedBlock,
  getCheckpoint: mockGetCheckpoint,
  recordCheckpointError: mockRecordCheckpointError,
  initCheckpoint: vi.fn(() => 18000000),
  setCheckpoint: vi.fn(),
  setSubmittedBlock: vi.fn(),
  setSuccessfulMintBlock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock edmtClient — we control what getBlockStatus returns
// ---------------------------------------------------------------------------
const mockGetBlockStatus = vi.fn();

vi.mock("../src/edmtClient.js", () => ({
  getBlockStatus: mockGetBlockStatus,
  getFeeQuote: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BlockScanner.decideBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 4: block > currentHead => beyond_current_head
  it("Test 4: block > currentHead returns beyond_current_head", async () => {
    const { decideBlock } = await import("../src/blockScanner.js");

    mockGetBlockStatus.mockResolvedValueOnce({
      block: 99999999,
      status: "beyond_current_head",
      reason: "block 99999999 > current head 20000000",
      edmtStatusConfirmed: false,
    });

    const result = await decideBlock(99999999);
    expect(result.status).toBe("beyond_current_head");
  });

  // Test 5: block < 12965000 => not_eligible/pre_eip1559
  it("Test 5: block < 12965000 returns not_eligible with reason pre_eip1559", async () => {
    const { decideBlock } = await import("../src/blockScanner.js");

    // decideBlock handles pre-EIP-1559 check before calling edmtClient
    const result = await decideBlock(12964999);
    expect(result.status).toBe("not_eligible");
    expect(result.reason).toBe("pre_eip1559");
    // edmtClient should NOT be called for pre-EIP-1559 blocks
    expect(mockGetBlockStatus).not.toHaveBeenCalled();
  });

  // Test 6: burn < 1 => not_eligible/burn_lt_1
  it("Test 6: burnGwei < 1 overrides mintable to not_eligible/burn_lt_1", async () => {
    const { decideBlock } = await import("../src/blockScanner.js");

    mockGetBlockStatus.mockResolvedValueOnce({
      block: 18000000,
      status: "mintable",
      burnGwei: 0n, // burn = 0 gwei — below minimum
      edmtStatusConfirmed: true,
    });

    const result = await decideBlock(18000000);
    expect(result.status).toBe("not_eligible");
    expect(result.reason).toBe("burn_lt_1");
  });

  it("burnGwei exactly 1 gwei is eligible (not overridden)", async () => {
    const { decideBlock } = await import("../src/blockScanner.js");

    mockGetBlockStatus.mockResolvedValueOnce({
      block: 18000000,
      status: "mintable",
      burnGwei: 1n,
      edmtStatusConfirmed: true,
    });

    const result = await decideBlock(18000000);
    expect(result.status).toBe("mintable");
  });

  it("minted block returns minted status", async () => {
    const { decideBlock } = await import("../src/blockScanner.js");

    mockGetBlockStatus.mockResolvedValueOnce({
      block: 18000000,
      status: "minted",
      owner: "0xabc",
      edmtStatusConfirmed: true,
    });

    const result = await decideBlock(18000000);
    expect(result.status).toBe("minted");
  });

  it("unknown status is returned as-is", async () => {
    const { decideBlock } = await import("../src/blockScanner.js");

    mockGetBlockStatus.mockResolvedValueOnce({
      block: 18000000,
      status: "unknown",
      reason: "EDMT API unavailable",
      edmtStatusConfirmed: false,
    });

    const result = await decideBlock(18000000);
    expect(result.status).toBe("unknown");
  });
});

describe("BlockScanner.getNextCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns checkpoint value when checkpoint exists", async () => {
    mockGetCheckpoint.mockReturnValueOnce(18500000);
    const { getNextCandidate } = await import("../src/blockScanner.js");
    const next = getNextCandidate();
    expect(next).toBe(18500000);
  });

  it("returns startBlock when no checkpoint exists", async () => {
    mockGetCheckpoint.mockReturnValueOnce(undefined);
    const { getNextCandidate } = await import("../src/blockScanner.js");
    const next = getNextCandidate();
    expect(next).toBe(12965000);
  });
});
