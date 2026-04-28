/**
 * High Burn Indexer — unit tests
 *
 * Tests:
 *  - assignTier() tier bucket semantics (6 cases)
 *  - burnGwei / burnEth calculation
 *  - candidate insert when burnEth >= tier
 *  - candidate NOT inserted when burnEth < lowest tier
 *  - cache hit → no RPC call
 *  - skip-seen → no processing
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { assignTier } from "../src/highBurnIndexer.js";

// ---------------------------------------------------------------------------
// Standard tier list used across all tests
// ---------------------------------------------------------------------------
const TIERS = [100, 90, 50, 20, 10, 5, 4, 3, 2, 1, 0.5, 0.25, 0.1];

// ---------------------------------------------------------------------------
// assignTier() — tier bucket semantics
// ---------------------------------------------------------------------------

describe("assignTier — tier bucket semantics", () => {
  it("burnEth=99.9 → 90 tier (90 <= 99.9 < 100)", () => {
    expect(assignTier(99.9, TIERS)).toBe(90);
  });

  it("burnEth=90.0 → 90 tier (exactly at lower bound)", () => {
    expect(assignTier(90.0, TIERS)).toBe(90);
  });

  it("burnEth=89.999 → 50 tier (50 <= 89.999 < 90)", () => {
    expect(assignTier(89.999, TIERS)).toBe(50);
  });

  it("burnEth=4.7 → 4 tier (4 <= 4.7 < 5)", () => {
    expect(assignTier(4.7, TIERS)).toBe(4);
  });

  it("burnEth=3.99 → 3 tier (3 <= 3.99 < 4)", () => {
    expect(assignTier(3.99, TIERS)).toBe(3);
  });

  it("burnEth=0.09 → null (below minimum 0.1)", () => {
    expect(assignTier(0.09, TIERS)).toBeNull();
  });

  it("burnEth=100.0 → 100 tier (exactly at top)", () => {
    expect(assignTier(100.0, TIERS)).toBe(100);
  });

  it("burnEth=150.0 → 100 tier (above top tier)", () => {
    expect(assignTier(150.0, TIERS)).toBe(100);
  });

  it("burnEth=0.1 → 0.1 tier (exactly at minimum)", () => {
    expect(assignTier(0.1, TIERS)).toBe(0.1);
  });

  it("burnEth=0.0 → null (zero burn)", () => {
    expect(assignTier(0.0, TIERS)).toBeNull();
  });

  it("works with unsorted tiers input (auto-sorts descending)", () => {
    const unsortedTiers = [4, 100, 1, 50, 10];
    expect(assignTier(99.9, unsortedTiers)).toBe(50);
    expect(assignTier(4.5, unsortedTiers)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// burnGwei / burnEth calculation
// ---------------------------------------------------------------------------

describe("burnGwei / burnEth calculation", () => {
  it("burnGwei = floor(baseFeePerGas * gasUsed / 1e9)", () => {
    // baseFeePerGas = 10 gwei = 10e9 wei, gasUsed = 15e6
    // burnGwei = floor(10e9 * 15e6 / 1e9) = floor(150e6) = 150_000_000
    const baseFee = BigInt(10_000_000_000); // 10 gwei in wei
    const gasUsed = BigInt(15_000_000);
    const burnGwei = (baseFee * gasUsed) / BigInt(1_000_000_000);
    expect(burnGwei).toBe(BigInt(150_000_000));
  });

  it("burnEth = Number(burnGwei) / 1e9", () => {
    const burnGwei = BigInt(150_000_000); // 150M gwei
    const burnEth = Number(burnGwei) / 1_000_000_000;
    expect(burnEth).toBeCloseTo(0.15, 6);
  });

  it("burnGwei round-trip: burnEth → burnGwei preserves value", () => {
    const originalBurnGwei = BigInt(4_500_000_000); // 4.5 ETH worth
    const burnEth = Number(originalBurnGwei) / 1_000_000_000;
    const reconstructed = BigInt(Math.floor(burnEth * 1_000_000_000));
    expect(reconstructed).toBe(originalBurnGwei);
  });

  it("zero burnGwei → burnEth = 0 → no tier", () => {
    const burnGwei = BigInt(0);
    const burnEth = Number(burnGwei) / 1_000_000_000;
    expect(burnEth).toBe(0);
    expect(assignTier(burnEth, TIERS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BurnIndexer integration — DB write behavior
// ---------------------------------------------------------------------------

// Mock config
vi.mock("../src/config.js", () => ({
  config: {
    highBurnUseCache: true,
    highBurnCacheTtlHours: 168,
    highBurnSkipAlreadySeen: true,
    highBurnBatchSize: 100,
    highBurnMaxCandidatesPerTier: 10000,
    highBurnMinEthTiers: [100, 90, 50, 20, 10, 5, 4, 3, 2, 1, 0.5, 0.25, 0.1],
    highBurnActiveTierEth: 4,
    rpcUrl: "http://localhost:8545",
    sqlitePath: ":memory:",
    rpcRetryLimit: 1,
  },
  isLiveMintEnabled: () => false,
  hasPrivateKey: () => false,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LogEvent: {
    HIGH_BURN_CANDIDATE_DISCOVERED: "high_burn_candidate_discovered",
    HIGH_BURN_CACHE_HIT: "high_burn_cache_hit",
    HIGH_BURN_SKIP_SEEN: "high_burn_skip_seen",
    RPC_ERROR: "rpc_error",
  },
}));

const mockGetBlock = vi.fn();
vi.mock("../src/ethClient.js", () => ({
  getBlock: (...args: unknown[]) => mockGetBlock(...args),
  getCurrentBlockNumber: vi.fn(() => Promise.resolve(20000000)),
}));

const mockUpsertHighBurnCandidate = vi.fn();
const mockCountHighBurnCandidatesByTier = vi.fn(() => 0);
const mockGetDb = vi.fn(() => ({
  prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })),
}));

vi.mock("../src/db.js", () => ({
  upsertHighBurnCandidate: (...args: unknown[]) => mockUpsertHighBurnCandidate(...args),
  countHighBurnCandidatesByTier: (...args: unknown[]) => mockCountHighBurnCandidatesByTier(...args),
  getDb: () => mockGetDb(),
}));

describe("BurnIndexer — indexBlockRange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCountHighBurnCandidatesByTier.mockReturnValue(0);
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })),
    });
  });

  it("burnEth >= tier → candidate inserted into DB", async () => {
    // baseFeePerGas = 50 gwei, gasUsed = 100M → burnGwei = 5_000_000_000 → burnEth = 5.0
    mockGetBlock.mockResolvedValue({
      baseFeePerGas: BigInt(50_000_000_000),
      gasUsed: BigInt(100_000_000),
    });

    const { indexBlockRange } = await import("../src/highBurnIndexer.js");
    const summary = await indexBlockRange(18000000, 18000000, 4, {
      useCache: false,
      cacheTtlHours: 168,
      skipAlreadySeen: false,
      batchSize: 100,
      maxPerTier: 10000,
      tiers: TIERS,
    });

    expect(mockUpsertHighBurnCandidate).toHaveBeenCalledOnce();
    expect(summary.discovered).toBe(1);
  });

  it("burnEth < lowest tier → candidate NOT inserted", async () => {
    // baseFeePerGas = 1 gwei, gasUsed = 1M → burnGwei = 1_000 → burnEth = 0.000001
    mockGetBlock.mockResolvedValue({
      baseFeePerGas: BigInt(1_000_000_000),
      gasUsed: BigInt(1_000_000),
    });

    const { indexBlockRange } = await import("../src/highBurnIndexer.js");
    const summary = await indexBlockRange(18000000, 18000000, 4, {
      useCache: false,
      cacheTtlHours: 168,
      skipAlreadySeen: false,
      batchSize: 100,
      maxPerTier: 10000,
      tiers: TIERS,
    });

    expect(mockUpsertHighBurnCandidate).not.toHaveBeenCalled();
    expect(summary.belowTier).toBe(1);
  });

  it("pre-EIP-1559 block (baseFeePerGas=null) → skipped", async () => {
    mockGetBlock.mockResolvedValue({
      baseFeePerGas: null,
      gasUsed: BigInt(15_000_000),
    });

    const { indexBlockRange } = await import("../src/highBurnIndexer.js");
    // Use a valid post-EIP-1559 block number — baseFeePerGas=null simulates missing data
    const summary = await indexBlockRange(18000001, 18000001, 4, {
      useCache: false,
      cacheTtlHours: 168,
      skipAlreadySeen: false,
      batchSize: 100,
      maxPerTier: 10000,
      tiers: TIERS,
    });

    expect(mockUpsertHighBurnCandidate).not.toHaveBeenCalled();
    expect(summary.belowTier).toBe(1);
  });

  it("cache hit (within TTL) → no RPC call", async () => {
    // DB returns a cached entry within TTL
    const recentTime = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ status: "discovered", seen_at: recentTime })),
      })),
    });

    const { indexBlockRange } = await import("../src/highBurnIndexer.js");
    const summary = await indexBlockRange(18000000, 18000000, 4, {
      useCache: true,
      cacheTtlHours: 168,
      skipAlreadySeen: false,
      batchSize: 100,
      maxPerTier: 10000,
      tiers: TIERS,
    });

    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(summary.cached).toBe(1);
  });

  it("skip-seen (status=finalized) → no processing", async () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          status: "finalized",
          seen_at: new Date(Date.now() - 200 * 3600 * 1000).toISOString(), // stale
        })),
      })),
    });

    const { indexBlockRange } = await import("../src/highBurnIndexer.js");
    const summary = await indexBlockRange(18000000, 18000000, 4, {
      useCache: true,
      cacheTtlHours: 168,
      skipAlreadySeen: true,
      batchSize: 100,
      maxPerTier: 10000,
      tiers: TIERS,
    });

    expect(mockGetBlock).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });
});
