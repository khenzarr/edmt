/**
 * edmtClient unit tests — parseEdmtBlockResponse (new API shape).
 *
 * Tests the new wrapped API response shape:
 *   { data: { blk, burn, is_mintable, minted_by, mint_tx_hash, ... }, as_of_block }
 *
 * Also covers legacy flat shape and malformed input.
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
    edmtBaseUrl: "https://api.edmt.io",
    edmtApiBaseUrl: "https://api.edmt.io/api/v1",
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
    API_RETRY: "api_retry",
    API_FALLBACK: "api_fallback",
    API_UNAVAILABLE: "api_unavailable",
    RPC_RETRY: "rpc_retry",
    RPC_ERROR: "rpc_error",
  },
}));

// ---------------------------------------------------------------------------
// Mock db
// ---------------------------------------------------------------------------
vi.mock("../src/db.js", () => ({
  recordError: vi.fn(),
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock ethClient — controls RPC responses
// ---------------------------------------------------------------------------
const mockGetCurrentBlockNumber = vi.fn();
const mockBlockExists = vi.fn();
const mockCalculateBurnGwei = vi.fn();

vi.mock("../src/ethClient.js", () => ({
  getCurrentBlockNumber: mockGetCurrentBlockNumber,
  blockExists: mockBlockExists,
  calculateBurnGwei: mockCalculateBurnGwei,
  getFeeData: vi.fn().mockResolvedValue({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
  getWallet: vi.fn(),
  sendRawTransaction: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helper: stub global fetch to return a given JSON body
// ---------------------------------------------------------------------------
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("edmtClient.getBlockStatus — new API shape parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    // Default: RPC says current head is well above test blocks
    mockGetCurrentBlockNumber.mockResolvedValue(25_000_000);
  });

  // -------------------------------------------------------------------------
  // Test 1: Wrapped mintable response (minted_by=null, is_mintable=true)
  // -------------------------------------------------------------------------
  it("Test 1: wrapped mintable response → status=mintable, edmtStatusConfirmed=true", async () => {
    stubFetch(200, {
      data: {
        blk: 12965000,
        burn: 30025257,
        is_mintable: true,
        minted_by: null,
        mint_tx_hash: null,
        finalized: true,
      },
      as_of_block: 24973218,
    });

    const { getBlockStatus } = await import("../src/edmtClient.js");
    const result = await getBlockStatus(12965000);

    expect(result.status).toBe("mintable");
    expect(result.block).toBe(12965000);
    expect(result.burnGwei).toBe(30025257n);
    expect(result.edmtStatusConfirmed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: Wrapped minted response (minted_by populated)
  // -------------------------------------------------------------------------
  it("Test 2: wrapped minted response → status=minted, owner set, edmtStatusConfirmed=true", async () => {
    stubFetch(200, {
      data: {
        blk: 12965000,
        burn: 30025257,
        is_mintable: true,
        minted_by: "0xfa6e6080000000000000000000000000000000000",
        mint_tx_hash: "0x91c6b90000000000000000000000000000000000000000000000000000000000000000",
        finalized: true,
      },
      as_of_block: 24973218,
    });

    const { getBlockStatus } = await import("../src/edmtClient.js");
    const result = await getBlockStatus(12965000);

    expect(result.status).toBe("minted");
    expect(result.owner).toBe("0xfa6e6080000000000000000000000000000000000");
    expect(result.mintTx).toBe(
      "0x91c6b90000000000000000000000000000000000000000000000000000000000000000"
    );
    expect(result.edmtStatusConfirmed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: Wrapped not_eligible response (is_mintable=false)
  // -------------------------------------------------------------------------
  it("Test 3: wrapped not_eligible response → status=not_eligible, reason=api_not_mintable", async () => {
    stubFetch(200, {
      data: {
        blk: 12965001,
        burn: 0,
        is_mintable: false,
        minted_by: null,
        mint_tx_hash: null,
        finalized: true,
      },
      as_of_block: 24973218,
    });

    const { getBlockStatus } = await import("../src/edmtClient.js");
    const result = await getBlockStatus(12965001);

    expect(result.status).toBe("not_eligible");
    expect(result.reason).toBe("api_not_mintable");
    expect(result.edmtStatusConfirmed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: Malformed / unrecognised response → status=unknown, edmtStatusConfirmed=false
  // -------------------------------------------------------------------------
  it("Test 4: malformed response → falls back to RPC → status=unknown, edmtStatusConfirmed=false", async () => {
    // API returns 200 but with unrecognised shape
    stubFetch(200, { unexpected: true });

    // RPC fallback: block exists, burn is sufficient
    mockBlockExists.mockResolvedValue(true);
    mockCalculateBurnGwei.mockResolvedValue(5000n);

    const { getBlockStatus } = await import("../src/edmtClient.js");
    const result = await getBlockStatus(12965000);

    expect(result.status).toBe("unknown");
    expect(result.edmtStatusConfirmed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5: API 404 → RPC fallback → status=unknown
  // -------------------------------------------------------------------------
  it("Test 5: API 404 → RPC fallback → status=unknown, edmtStatusConfirmed=false", async () => {
    stubFetch(404, null);

    mockBlockExists.mockResolvedValue(true);
    mockCalculateBurnGwei.mockResolvedValue(5000n);

    const { getBlockStatus } = await import("../src/edmtClient.js");
    const result = await getBlockStatus(12965000);

    expect(result.status).toBe("unknown");
    expect(result.edmtStatusConfirmed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6: burn field parsed correctly as bigint
  // -------------------------------------------------------------------------
  it("Test 6: burn field as string is parsed to bigint correctly", async () => {
    stubFetch(200, {
      data: {
        blk: 13000000,
        burn: "999999999",
        is_mintable: true,
        minted_by: null,
        mint_tx_hash: null,
        finalized: true,
      },
      as_of_block: 24973218,
    });

    const { getBlockStatus } = await import("../src/edmtClient.js");
    const result = await getBlockStatus(13000000);

    expect(result.status).toBe("mintable");
    expect(result.burnGwei).toBe(999999999n);
    expect(result.edmtStatusConfirmed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: pre-EIP-1559 block never reaches API
  // -------------------------------------------------------------------------
  it("Test 7: block < 12965000 returns not_eligible without API call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { getBlockStatus } = await import("../src/edmtClient.js");
    const result = await getBlockStatus(12964999);

    expect(result.status).toBe("not_eligible");
    expect(result.reason).toBe("pre_eip1559");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
