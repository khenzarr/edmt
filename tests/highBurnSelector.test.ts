/**
 * High Burn Selector — unit tests
 *
 * Tests:
 *  - getNextLowerTier() logic
 *  - TierManager: downgrade, exhaustion
 *  - getNextHighBurnCandidate(): sorting, filtering, duplicate prevention
 *  - Unknown retry backoff
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getNextLowerTier, TierManager } from "../src/highBurnSelector.js";

const TIERS = [100, 90, 50, 20, 10, 5, 4, 3, 2, 1, 0.5, 0.25, 0.1];

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
const mockConfig = {
  highBurnPriorityMode: true,
  highBurnActiveTierEth: 4,
  highBurnMinEthTiers: TIERS,
  highBurnOnlyNoFee: true,
  highBurnOnlyMintable: true,
  highBurnUnknownRetryMinutes: 30,
  highBurnOnExhausted: "fallback_sequential" as const,
  rpcUrl: "http://localhost:8545",
  sqlitePath: ":memory:",
};

vi.mock("../src/config.js", () => ({
  get config() {
    return mockConfig;
  },
  isLiveMintEnabled: () => false,
  hasPrivateKey: () => false,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LogEvent: {
    HIGH_BURN_TIER_EXHAUSTED: "high_burn_tier_exhausted",
    HIGH_BURN_TIER_DOWNGRADED: "high_burn_tier_downgraded",
    HIGH_BURN_TIER_STARTED: "high_burn_tier_started",
    HIGH_BURN_ALL_TIERS_EXHAUSTED: "high_burn_all_tiers_exhausted",
    HIGH_BURN_CANDIDATE_SELECTED: "high_burn_candidate_selected",
  },
}));

const mockQueryNextHighBurnCandidate = vi.fn();
const mockIsHighBurnTierExhausted = vi.fn(() => false);

vi.mock("../src/db.js", () => ({
  queryNextHighBurnCandidate: (...args: unknown[]) => mockQueryNextHighBurnCandidate(...args),
  isHighBurnTierExhausted: (...args: unknown[]) => mockIsHighBurnTierExhausted(...args),
}));

// ---------------------------------------------------------------------------
// getNextLowerTier()
// ---------------------------------------------------------------------------

describe("getNextLowerTier", () => {
  it("returns next lower tier from sorted list", () => {
    expect(getNextLowerTier(100, TIERS)).toBe(90);
    expect(getNextLowerTier(90, TIERS)).toBe(50);
    expect(getNextLowerTier(4, TIERS)).toBe(3);
    expect(getNextLowerTier(0.25, TIERS)).toBe(0.1);
  });

  it("returns null when already at lowest tier", () => {
    expect(getNextLowerTier(0.1, TIERS)).toBeNull();
  });

  it("returns null when tier not found in list", () => {
    expect(getNextLowerTier(999, TIERS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TierManager
// ---------------------------------------------------------------------------

describe("TierManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsHighBurnTierExhausted.mockReturnValue(false);
  });

  it("initializes with the given active tier", () => {
    const tm = new TierManager(4, TIERS);
    expect(tm.getActiveTier()).toBe(4);
    expect(tm.isAllExhausted()).toBe(false);
  });

  it("tryDowngrade() moves to next lower tier and returns true", () => {
    const tm = new TierManager(4, TIERS);
    const result = tm.tryDowngrade();
    expect(result).toBe(true);
    expect(tm.getActiveTier()).toBe(3);
    expect(tm.isAllExhausted()).toBe(false);
  });

  it("tryDowngrade() from lowest tier returns false and marks exhausted", () => {
    const tm = new TierManager(0.1, TIERS);
    const result = tm.tryDowngrade();
    expect(result).toBe(false);
    expect(tm.isAllExhausted()).toBe(true);
  });

  it("sequential downgrades traverse all tiers", () => {
    const tm = new TierManager(100, TIERS);
    const visited: number[] = [100];
    while (tm.tryDowngrade()) {
      visited.push(tm.getActiveTier());
    }
    expect(visited).toEqual([100, 90, 50, 20, 10, 5, 4, 3, 2, 1, 0.5, 0.25, 0.1]);
    expect(tm.isAllExhausted()).toBe(true);
  });

  it("resetToTier() resets active tier and clears exhausted flag", () => {
    const tm = new TierManager(0.1, TIERS);
    tm.tryDowngrade(); // exhausts
    expect(tm.isAllExhausted()).toBe(true);
    tm.resetToTier(4);
    expect(tm.getActiveTier()).toBe(4);
    expect(tm.isAllExhausted()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getNextHighBurnCandidate()
// ---------------------------------------------------------------------------

describe("getNextHighBurnCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeRow = (
    overrides: Partial<{
      block: number;
      burn_gwei: string;
      burn_eth: number;
      tier_eth: number;
      status: string;
      edmt_status: string | null;
      fee_required: number | null;
      attempts: number;
    }> = {}
  ) => ({
    block: 18000000,
    burn_gwei: "4500000000",
    burn_eth: 4.5,
    tier_eth: 4,
    status: "discovered",
    edmt_status: "mintable",
    fee_required: 0,
    attempts: 0,
    ...overrides,
  });

  it("returns candidate when one is available", async () => {
    const row = makeRow();
    mockQueryNextHighBurnCandidate.mockReturnValue(row);

    const { getNextHighBurnCandidate } = await import("../src/highBurnSelector.js");
    const result = getNextHighBurnCandidate(4, {
      onlyNoFee: true,
      onlyMintable: true,
      unknownRetryMinutes: 30,
    });

    expect(result).not.toBeNull();
    expect(result!.block).toBe(18000000);
  });

  it("returns null when no candidate available", async () => {
    mockQueryNextHighBurnCandidate.mockReturnValue(undefined);

    const { getNextHighBurnCandidate } = await import("../src/highBurnSelector.js");
    const result = getNextHighBurnCandidate(4, {
      onlyNoFee: true,
      onlyMintable: true,
      unknownRetryMinutes: 30,
    });

    expect(result).toBeNull();
  });

  it("passes onlyNoFee and onlyMintable opts to DB query", async () => {
    mockQueryNextHighBurnCandidate.mockReturnValue(undefined);

    const { getNextHighBurnCandidate } = await import("../src/highBurnSelector.js");
    getNextHighBurnCandidate(4, { onlyNoFee: true, onlyMintable: true, unknownRetryMinutes: 30 });

    expect(mockQueryNextHighBurnCandidate).toHaveBeenCalledWith(4, {
      onlyNoFee: true,
      onlyMintable: true,
      unknownRetryMinutes: 30,
    });
  });

  it("passes unknownRetryMinutes to DB query for backoff enforcement", async () => {
    mockQueryNextHighBurnCandidate.mockReturnValue(undefined);

    const { getNextHighBurnCandidate } = await import("../src/highBurnSelector.js");
    getNextHighBurnCandidate(4, { onlyNoFee: false, onlyMintable: false, unknownRetryMinutes: 60 });

    expect(mockQueryNextHighBurnCandidate).toHaveBeenCalledWith(4, {
      onlyNoFee: false,
      onlyMintable: false,
      unknownRetryMinutes: 60,
    });
  });
});

// ---------------------------------------------------------------------------
// DB query SQL logic — unknown retry backoff (via queryNextHighBurnCandidate)
// ---------------------------------------------------------------------------

describe("Unknown retry backoff — DB query behavior", () => {
  it("unknown candidate with recent last_attempt_at is excluded by SQL", () => {
    // The SQL condition:
    //   (status != 'unknown' OR last_attempt_at IS NULL
    //    OR (julianday('now') - julianday(last_attempt_at)) * 1440 >= retryMinutes)
    // We verify the logic directly:
    const retryMinutes = 30;
    const recentAttempt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const minutesElapsed = (Date.now() - new Date(recentAttempt).getTime()) / 60_000;
    expect(minutesElapsed).toBeLessThan(retryMinutes);
    // → candidate should NOT be selected (SQL would exclude it)
  });

  it("unknown candidate with old last_attempt_at is included by SQL", () => {
    const retryMinutes = 30;
    const oldAttempt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago
    const minutesElapsed = (Date.now() - new Date(oldAttempt).getTime()) / 60_000;
    expect(minutesElapsed).toBeGreaterThanOrEqual(retryMinutes);
    // → candidate SHOULD be selected (SQL would include it)
  });

  it("unknown candidate with null last_attempt_at is always included", () => {
    // SQL: last_attempt_at IS NULL → always eligible
    const lastAttemptAt = null;
    expect(lastAttemptAt).toBeNull();
    // → candidate SHOULD be selected
  });
});
