/**
 * MintExecutor unit tests.
 * Tests 9, 10, 11, 12, 13, 14 from the spec test plan.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// We need to control config per test — use a mutable config object
// ---------------------------------------------------------------------------
const mockConfig = {
  dryRun: true,
  enableLiveMint: false,
  privateKey: "",
  maxGasGwei: 80,
  maxPriorityFeeGwei: 3,
  maxCaptureFeeGwei: BigInt(1_000_000_000),
  maxTxPerRun: 1,
  requireManualConfirmationForFirstTx: false, // disable for tests
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
  },
}));

// ---------------------------------------------------------------------------
// Mock ethClient
// ---------------------------------------------------------------------------
const mockSendRawTransaction = vi.fn();
const mockGetFeeData = vi.fn(() =>
  Promise.resolve({
    maxFeePerGas: BigInt(50_000_000_000), // 50 gwei
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
// Mock feeQuoter
// ---------------------------------------------------------------------------
const mockGetRequiredFee = vi.fn(() =>
  Promise.resolve({ feeRequired: false, quoteAvailable: true })
);
const mockIsFeeAcceptable = vi.fn(() => true);

vi.mock("../src/feeQuoter.js", () => ({
  getRequiredFee: mockGetRequiredFee,
  isFeeAcceptable: mockIsFeeAcceptable,
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------
const mockGetTxByBlock = vi.fn(() => undefined);
const mockHasPendingTx = vi.fn(() => false);
const mockInsertTx = vi.fn();

vi.mock("../src/db.js", () => ({
  getTxByBlock: mockGetTxByBlock,
  hasPendingTx: mockHasPendingTx,
  insertTx: mockInsertTx,
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
// Mintable block fixture
// ---------------------------------------------------------------------------
const mintableBlock = {
  block: 18765432,
  status: "mintable" as const,
  burnGwei: 100n,
  feeRequired: false,
  edmtStatusConfirmed: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MintExecutor", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset run state between tests
    const { resetRunState } = await import("../src/mintExecutor.js");
    resetRunState();
    // Reset config to safe defaults
    mockConfig.dryRun = true;
    mockConfig.enableLiveMint = false;
    mockConfig.privateKey = "";
    mockConfig.allowMultiplePendingTx = false;
    mockConfig.maxTxPerRun = 1;
    mockConfig.requireManualConfirmationForFirstTx = false;
    mockGetTxByBlock.mockReturnValue(undefined);
    mockHasPendingTx.mockReturnValue(false);
    mockGetRequiredFee.mockResolvedValue({ feeRequired: false, quoteAvailable: true });
    mockIsFeeAcceptable.mockReturnValue(true);
    mockGetFeeData.mockResolvedValue({
      maxFeePerGas: BigInt(50_000_000_000),
      maxPriorityFeePerGas: BigInt(2_000_000_000),
    });
  });

  // Test 9: DRY_RUN=true => sendTransaction NOT called
  it("Test 9: DRY_RUN=true — sendTransaction is NOT called", async () => {
    mockConfig.dryRun = true;
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);
    expect(result.status).toBe("dry_run");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // Test 10: ENABLE_LIVE_MINT=false => sendTransaction NOT called
  it("Test 10: ENABLE_LIVE_MINT=false — sendTransaction is NOT called", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = false;
    mockConfig.privateKey = "0xdeadbeef";
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);
    expect(result.status).toBe("skipped_live_mint_disabled");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // Test 11: duplicate tx prevented
  it("Test 11: duplicate tx for same block is prevented", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    mockGetTxByBlock.mockReturnValue({
      tx_hash: "0xexistinghash",
      status: "pending",
      nonce: 42,
    });
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);
    expect(result.status).toBe("skipped_duplicate_tx");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // Test 12: fee over max => mint skipped
  it("Test 12: fee exceeding MAX_CAPTURE_FEE_GWEI — mint is skipped", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    const blockWithFee = { ...mintableBlock, feeRequired: true };
    mockGetRequiredFee.mockResolvedValue({
      feeRequired: true,
      requiredFeeGwei: 2_000_000_000n, // over max of 1_000_000_000
      quoteAvailable: true,
    });
    mockIsFeeAcceptable.mockReturnValue(false);
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(blockWithFee);
    expect(result.status).toBe("skipped_fee_exceeds_max");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // Test 13: gas over max => tx not sent
  it("Test 13: maxFeePerGas exceeding MAX_GAS_GWEI — tx is NOT sent", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    // 81 gwei > MAX_GAS_GWEI=80
    mockGetFeeData.mockResolvedValue({
      maxFeePerGas: BigInt(81_000_000_000),
      maxPriorityFeePerGas: BigInt(2_000_000_000),
    });
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);
    expect(result.status).toBe("skipped_gas_exceeds_max");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // Test 14: pending tx exists + ALLOW_MULTIPLE_PENDING_TX=false => no new tx
  it("Test 14: pending tx exists with ALLOW_MULTIPLE_PENDING_TX=false — tx NOT sent", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    mockConfig.allowMultiplePendingTx = false;
    mockHasPendingTx.mockReturnValue(true);
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);
    expect(result.status).toBe("skipped_pending_tx");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // EDMT status not confirmed => live mint blocked
  it("EDMT status not confirmed — live mint blocked", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    const unconfirmedBlock = { ...mintableBlock, edmtStatusConfirmed: false };
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(unconfirmedBlock);
    expect(result.status).toBe("skipped_edmt_status_unconfirmed");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // No private key => live mint blocked
  it("No PRIVATE_KEY — live mint blocked", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "";
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);
    expect(result.status).toBe("skipped_no_private_key");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // Fee quote unavailable => live mint blocked
  it("Fee quote unavailable — live mint blocked", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    const blockWithFee = { ...mintableBlock, feeRequired: true };
    mockGetRequiredFee.mockResolvedValue({
      feeRequired: false,
      quoteAvailable: false,
      reason: "API unavailable",
    });
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(blockWithFee);
    expect(result.status).toBe("skipped_fee_quote_unavailable");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // Successful live mint sends tx and records it
  it("Successful live mint sends tx and records it in DB", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    mockSendRawTransaction.mockResolvedValue({
      hash: "0xtxhash123",
      nonce: 5,
    });
    const { execute } = await import("../src/mintExecutor.js");
    const result = await execute(mintableBlock);
    expect(result.status).toBe("submitted");
    expect(result.txHash).toBe("0xtxhash123");
    expect(mockSendRawTransaction).toHaveBeenCalledOnce();
    expect(mockInsertTx).toHaveBeenCalledOnce();
  });

  // Gate 11 mode-aware tests
  it("Manual mode: MAX_TX_PER_RUN=1 + txSentThisRun=1 — tx blocked", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    mockConfig.maxTxPerRun = 1;
    // Send first tx to increment txSentThisRun
    mockSendRawTransaction.mockResolvedValue({ hash: "0xfirst", nonce: 1 });
    const { execute, resetRunState } = await import("../src/mintExecutor.js");
    resetRunState();
    await execute(mintableBlock); // first tx — succeeds
    // Second tx in manual mode — should be blocked by Gate 11
    const result = await execute({ ...mintableBlock, block: 18765433 });
    expect(result.status).toBe("skipped_tx_run_limit");
    expect(mockSendRawTransaction).toHaveBeenCalledOnce();
  });

  it("Auto mode: MAX_TX_PER_RUN=1 — Gate 11 bypassed, second tx allowed", async () => {
    mockConfig.dryRun = false;
    mockConfig.enableLiveMint = true;
    mockConfig.privateKey = "0xdeadbeef";
    mockConfig.maxTxPerRun = 1;
    mockSendRawTransaction.mockResolvedValue({ hash: "0xauto", nonce: 1 });
    const { execute, resetRunState } = await import("../src/mintExecutor.js");
    resetRunState();
    await execute(mintableBlock, { mode: "automint" }); // first tx
    // Second tx in automint mode — Gate 11 bypassed
    mockGetTxByBlock.mockReturnValue(undefined); // no duplicate
    const result = await execute({ ...mintableBlock, block: 18765433 }, { mode: "automint" });
    expect(result.status).toBe("submitted");
    expect(mockSendRawTransaction).toHaveBeenCalledTimes(2);
  });
});
