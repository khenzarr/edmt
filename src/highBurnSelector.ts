/**
 * High Burn Selector — CandidateSelector and TierManager.
 *
 * CandidateSelector: getNextHighBurnCandidate() — returns the best available
 * candidate for minting from the active tier.
 *
 * TierManager: tracks the active tier, handles exhaustion and downgrade.
 */

import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { queryNextHighBurnCandidate, isHighBurnTierExhausted } from "./db.js";
import type { HighBurnCandidateRow } from "./types.js";

// ---------------------------------------------------------------------------
// Candidate Selector
// ---------------------------------------------------------------------------

export interface CandidateSelectorOpts {
  onlyNoFee: boolean;
  onlyMintable: boolean;
  unknownRetryMinutes: number;
}

/**
 * Get the next high burn candidate for a given tier.
 * Returns null if no eligible candidate exists in the tier.
 */
export function getNextHighBurnCandidate(
  tierEth: number,
  opts: CandidateSelectorOpts
): HighBurnCandidateRow | null {
  const row = queryNextHighBurnCandidate(tierEth, {
    onlyNoFee: opts.onlyNoFee,
    onlyMintable: opts.onlyMintable,
    unknownRetryMinutes: opts.unknownRetryMinutes,
  }) as HighBurnCandidateRow | undefined;

  if (!row) return null;

  logger.debug(
    {
      event: LogEvent.HIGH_BURN_CANDIDATE_SELECTED,
      block: row.block,
      burnGwei: row.burn_gwei,
      burnEth: row.burn_eth,
      tierEth: row.tier_eth,
      attempts: row.attempts,
    },
    `High burn: selected block ${row.block} (burnEth=${row.burn_eth.toFixed(4)}, tier=${tierEth})`
  );

  return row;
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

/**
 * Get the next lower tier from the sorted tiers list.
 * Returns null if currentTier is already the lowest.
 */
export function getNextLowerTier(currentTier: number, allTiers: number[]): number | null {
  const sorted = [...allTiers].sort((a, b) => b - a); // descending
  const idx = sorted.indexOf(currentTier);
  if (idx === -1 || idx === sorted.length - 1) return null;
  return sorted[idx + 1];
}

// ---------------------------------------------------------------------------
// TierManager
// ---------------------------------------------------------------------------

export class TierManager {
  private activeTier: number;
  private readonly allTiers: number[];
  private exhausted = false;

  constructor(initialTier: number, allTiers: number[]) {
    this.activeTier = initialTier;
    this.allTiers = [...allTiers].sort((a, b) => b - a); // descending
  }

  getActiveTier(): number {
    return this.activeTier;
  }

  isAllExhausted(): boolean {
    return this.exhausted;
  }

  /**
   * Try to downgrade to the next lower tier.
   * Returns true if downgrade succeeded, false if all tiers are exhausted.
   */
  tryDowngrade(): boolean {
    logger.info(
      {
        event: LogEvent.HIGH_BURN_TIER_EXHAUSTED,
        tierEth: this.activeTier,
      },
      `High burn: tier ${this.activeTier} ETH exhausted`
    );

    const nextTier = getNextLowerTier(this.activeTier, this.allTiers);

    if (nextTier === null) {
      this.exhausted = true;
      logger.warn(
        { event: LogEvent.HIGH_BURN_ALL_TIERS_EXHAUSTED, onExhausted: config.highBurnOnExhausted },
        "High burn: all tiers exhausted"
      );
      return false;
    }

    logger.info(
      {
        event: LogEvent.HIGH_BURN_TIER_DOWNGRADED,
        fromTier: this.activeTier,
        toTier: nextTier,
      },
      `High burn: downgrading from tier ${this.activeTier} to ${nextTier} ETH`
    );

    this.activeTier = nextTier;

    logger.info(
      { event: LogEvent.HIGH_BURN_TIER_STARTED, tierEth: this.activeTier },
      `High burn: tier ${this.activeTier} ETH started`
    );

    return true;
  }

  /**
   * Check if the active tier is exhausted (no more eligible candidates).
   */
  isTierExhausted(): boolean {
    return isHighBurnTierExhausted(this.activeTier);
  }

  /**
   * Reset to a specific tier (e.g., after cache reset).
   */
  resetToTier(tierEth: number): void {
    this.activeTier = tierEth;
    this.exhausted = false;
  }
}

/**
 * Build default CandidateSelectorOpts from config.
 */
export function defaultSelectorOpts(): CandidateSelectorOpts {
  return {
    onlyNoFee: config.highBurnOnlyNoFee,
    onlyMintable: config.highBurnOnlyMintable,
    unknownRetryMinutes: config.highBurnUnknownRetryMinutes,
  };
}
