/**
 * FeeQuoter unit tests.
 * Tests 12 (fee over max) and 13 (gas over max) from the spec test plan.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
vi.mock("../src/config.js", () => ({
  config: {
    maxCaptureFeeGwei: BigInt(1_000_000_000), // 1 billion gwei max
    maxGasGwei: 80,
    maxPriorityFeeGwei: 3,
    apiRetryLimit: 1,
    rpcRetryLimit: 1,
    sqlitePath: ":memory:",
    dryRun: true,
    enableLiveMint: false,
    privateKey: "",
    rpcUrl: "http://localhost:8545",
    startBlock: 12965000,
    stopBlock: undefined,
    scanDirection: "ascending",
    maxBlocksPerRun: 1000,
    maxTxPerRun: 1,
    pollIntervalMs: 3000,
    minBurnGwei: BigInt(1),
    requireManualConfirmationForFirstTx: true,
    finalityConfirmations: 64,
    beyondHeadBehavior: "wait",
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
    API_UNAVAILABLE: "api_unavailable",
    MINT_GATE_FAILED: "mint_gate_failed",
  },
}));

// ---------------------------------------------------------------------------
// Mock edmtClient.getFeeQuote
// ---------------------------------------------------------------------------
const mockGetFeeQuote = vi.fn();

vi.mock("../src/edmtClient.js", () => ({
  getBlockStatus: vi.fn(),
  getFeeQuote: mockGetFeeQuote,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeeQuoter.getRequiredFee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns feeRequired=false when no fee needed", async () => {
    mockGetFeeQuote.mockResolvedValueOnce({ feeRequired: false });
    const { getRequiredFee } = await import("../src/feeQuoter.js");
    const result = await getRequiredFee(18000000);
    expect(result.feeRequired).toBe(false);
    expect(result.quoteAvailable).toBe(true);
  });

  it("returns feeRequired=true with fee value when fee is required", async () => {
    mockGetFeeQuote.mockResolvedValueOnce({
      feeRequired: true,
      requiredFeeGwei: 500_000_000n,
    });
    const { getRequiredFee } = await import("../src/feeQuoter.js");
    const result = await getRequiredFee(18000000);
    expect(result.feeRequired).toBe(true);
    expect(result.requiredFeeGwei).toBe(500_000_000n);
    expect(result.quoteAvailable).toBe(true);
  });

  it("returns quoteAvailable=false when API is unavailable", async () => {
    mockGetFeeQuote.mockResolvedValueOnce(undefined);
    const { getRequiredFee } = await import("../src/feeQuoter.js");
    const result = await getRequiredFee(18000000);
    expect(result.quoteAvailable).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("returns quoteAvailable=false when fee required but no value returned", async () => {
    mockGetFeeQuote.mockResolvedValueOnce({
      feeRequired: true,
      requiredFeeGwei: undefined,
    });
    const { getRequiredFee } = await import("../src/feeQuoter.js");
    const result = await getRequiredFee(18000000);
    expect(result.quoteAvailable).toBe(false);
    expect(result.feeRequired).toBe(true);
  });

  it("returns quoteAvailable=false on exception", async () => {
    mockGetFeeQuote.mockRejectedValueOnce(new Error("network error"));
    const { getRequiredFee } = await import("../src/feeQuoter.js");
    const result = await getRequiredFee(18000000);
    expect(result.quoteAvailable).toBe(false);
  });
});

describe("FeeQuoter.isFeeAcceptable", () => {
  // Test 12: fee over max => mint should be blocked
  it("Test 12: fee exceeding MAX_CAPTURE_FEE_GWEI is not acceptable", async () => {
    const { isFeeAcceptable } = await import("../src/feeQuoter.js");
    // MAX_CAPTURE_FEE_GWEI = 1_000_000_000
    const overMaxFee = 1_000_000_001n;
    expect(isFeeAcceptable(overMaxFee)).toBe(false);
  });

  it("fee equal to MAX_CAPTURE_FEE_GWEI is acceptable", async () => {
    const { isFeeAcceptable } = await import("../src/feeQuoter.js");
    expect(isFeeAcceptable(1_000_000_000n)).toBe(true);
  });

  it("fee below MAX_CAPTURE_FEE_GWEI is acceptable", async () => {
    const { isFeeAcceptable } = await import("../src/feeQuoter.js");
    expect(isFeeAcceptable(500_000_000n)).toBe(true);
  });

  it("zero fee is acceptable", async () => {
    const { isFeeAcceptable } = await import("../src/feeQuoter.js");
    expect(isFeeAcceptable(0n)).toBe(true);
  });
});
