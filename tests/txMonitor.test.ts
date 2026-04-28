/**
 * TxMonitor unit tests.
 * Tests 15 (successful mint checkpoint) and 16 (finality confirmation) from spec.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
vi.mock("../src/config.js", () => ({
  config: {
    finalityConfirmations: 64,
    dryRun: true,
    enableLiveMint: false,
    privateKey: "",
    rpcUrl: "http://localhost:8545",
    sqlitePath: ":memory:",
    apiRetryLimit: 1,
    rpcRetryLimit: 1,
    startBlock: 12965000,
    stopBlock: undefined,
    scanDirection: "ascending",
    maxBlocksPerRun: 1000,
    maxTxPerRun: 1,
    pollIntervalMs: 3000,
    minBurnGwei: BigInt(1),
    beyondHeadBehavior: "wait",
    allowMultiplePendingTx: false,
    maxGasGwei: 80,
    maxPriorityFeeGwei: 3,
    maxCaptureFeeGwei: BigInt(1_000_000_000),
    requireManualConfirmationForFirstTx: false,
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
    TX_INCLUDED: "tx_included",
    TX_FAILED: "tx_failed",
    TX_FINALIZED: "tx_finalized",
    TX_REVIEW_REQUIRED: "tx_review_required",
    TX_REORG_SUSPECTED: "tx_reorg_suspected",
    RPC_ERROR: "rpc_error",
  },
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------
const mockGetPendingTxs = vi.fn();
const mockUpdateTxStatus = vi.fn();
const mockUpsertBlockResult = vi.fn();
const mockRecordError = vi.fn();

vi.mock("../src/db.js", () => ({
  getPendingTxs: mockGetPendingTxs,
  updateTxStatus: mockUpdateTxStatus,
  upsertBlockResult: mockUpsertBlockResult,
  recordError: mockRecordError,
  getCheckpointRaw: vi.fn(),
  setCheckpointRaw: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock ethClient
// ---------------------------------------------------------------------------
const mockGetTransactionReceipt = vi.fn();
const mockGetCurrentBlockNumber = vi.fn();
const mockGetWallet = vi.fn(() => ({ address: "0xWALLET" }));

vi.mock("../src/ethClient.js", () => ({
  getTransactionReceipt: mockGetTransactionReceipt,
  getCurrentBlockNumber: mockGetCurrentBlockNumber,
  getWallet: mockGetWallet,
}));

// ---------------------------------------------------------------------------
// Mock edmtClient
// ---------------------------------------------------------------------------
const mockGetBlockStatus = vi.fn();

vi.mock("../src/edmtClient.js", () => ({
  getBlockStatus: mockGetBlockStatus,
  getFeeQuote: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock checkpoint
// ---------------------------------------------------------------------------
const mockSetSuccessfulMintBlock = vi.fn();
const mockSetFinalizedTx = vi.fn();

vi.mock("../src/checkpoint.js", () => ({
  setSuccessfulMintBlock: mockSetSuccessfulMintBlock,
  setFinalizedTx: mockSetFinalizedTx,
  advanceScannedBlock: vi.fn(),
  getCheckpoint: vi.fn(),
  initCheckpoint: vi.fn(),
  setCheckpoint: vi.fn(),
  setSubmittedBlock: vi.fn(),
  recordCheckpointError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TxMonitor.poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no pending txs", async () => {
    mockGetPendingTxs.mockReturnValue([]);
    const { poll } = await import("../src/txMonitor.js");
    await poll();
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });

  it("marks tx as failed when receipt.status !== 1", async () => {
    mockGetPendingTxs.mockReturnValue([
      {
        id: 1,
        block: 18000000,
        tx_hash: "0xfailed",
        nonce: 1,
        submitted_at: new Date().toISOString(),
      },
    ]);
    mockGetCurrentBlockNumber.mockResolvedValue(18000100);
    mockGetTransactionReceipt.mockResolvedValue({ status: 0, blockNumber: 18000050 });

    const { poll } = await import("../src/txMonitor.js");
    await poll();

    expect(mockUpdateTxStatus).toHaveBeenCalledWith("0xfailed", "failed");
    expect(mockUpsertBlockResult).toHaveBeenCalledWith(
      expect.objectContaining({ block: 18000000, status: "failed" })
    );
  });

  it("marks tx as included when receipt.status === 1 but not yet finalized", async () => {
    mockGetPendingTxs.mockReturnValue([
      {
        id: 1,
        block: 18000000,
        tx_hash: "0xincluded",
        nonce: 1,
        submitted_at: new Date().toISOString(),
      },
    ]);
    // Current block = included block + 10 (not yet 64 confirmations)
    mockGetCurrentBlockNumber.mockResolvedValue(18000060);
    mockGetTransactionReceipt.mockResolvedValue({ status: 1, blockNumber: 18000050 });

    const { poll } = await import("../src/txMonitor.js");
    await poll();

    expect(mockUpdateTxStatus).toHaveBeenCalledWith("0xincluded", "included");
    // Not yet finalized — setSuccessfulMintBlock should NOT be called
    expect(mockSetSuccessfulMintBlock).not.toHaveBeenCalled();
  });

  // Test 15: successful mint → checkpoint block + 1
  it("Test 15: successful mint with owner match advances checkpoint", async () => {
    mockGetPendingTxs.mockReturnValue([
      {
        id: 1,
        block: 18765432,
        tx_hash: "0xsuccesshash",
        nonce: 5,
        submitted_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    // Current block = included block + 64 (finality reached)
    mockGetCurrentBlockNumber.mockResolvedValue(18765432 + 64 + 10);
    mockGetTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 18765432 + 10,
    });
    mockGetBlockStatus.mockResolvedValue({
      block: 18765432,
      status: "minted",
      owner: "0xWALLET", // matches wallet
      edmtStatusConfirmed: true,
    });
    mockGetWallet.mockReturnValue({ address: "0xWALLET" });

    const { poll } = await import("../src/txMonitor.js");
    await poll();

    // Test 15: checkpoint should advance
    expect(mockSetSuccessfulMintBlock).toHaveBeenCalledWith(18765432);
    expect(mockUpdateTxStatus).toHaveBeenCalledWith("0xsuccesshash", "finalized");
  });

  // Test 16: finality confirmation count triggers successful_mint
  it("Test 16: FINALITY_CONFIRMATIONS (64) triggers successful_mint status", async () => {
    const includedBlock = 18000000;
    const currentBlock = includedBlock + 64; // exactly 64 confirmations

    mockGetPendingTxs.mockReturnValue([
      {
        id: 1,
        block: 18765432,
        tx_hash: "0xfinalhash",
        nonce: 3,
        submitted_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    mockGetCurrentBlockNumber.mockResolvedValue(currentBlock);
    mockGetTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: includedBlock,
    });
    mockGetBlockStatus.mockResolvedValue({
      block: 18765432,
      status: "minted",
      owner: "0xwallet",
      edmtStatusConfirmed: true,
    });
    mockGetWallet.mockReturnValue({ address: "0xwallet" });

    const { poll } = await import("../src/txMonitor.js");
    await poll();

    expect(mockSetSuccessfulMintBlock).toHaveBeenCalledWith(18765432);
    expect(mockUpsertBlockResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "successful_mint" })
    );
  });

  it("marks review_required when owner does not match wallet", async () => {
    mockGetPendingTxs.mockReturnValue([
      {
        id: 1,
        block: 18000000,
        tx_hash: "0xmismatch",
        nonce: 1,
        submitted_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    mockGetCurrentBlockNumber.mockResolvedValue(18000000 + 100);
    mockGetTransactionReceipt.mockResolvedValue({ status: 1, blockNumber: 18000000 + 10 });
    mockGetBlockStatus.mockResolvedValue({
      block: 18000000,
      status: "minted",
      owner: "0xSOMEONEELSE",
      edmtStatusConfirmed: true,
    });
    mockGetWallet.mockReturnValue({ address: "0xMYWALLET" });

    const { poll } = await import("../src/txMonitor.js");
    await poll();

    expect(mockUpdateTxStatus).toHaveBeenCalledWith("0xmismatch", "review_required");
    expect(mockSetSuccessfulMintBlock).not.toHaveBeenCalled();
  });
});
