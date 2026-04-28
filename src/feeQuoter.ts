/**
 * FeeQuoter — determines the capture fee required for a given block.
 *
 * Safety rules:
 *   - If fee quote is unavailable, returns undefined (caller must block live mint)
 *   - If fee > MAX_CAPTURE_FEE_GWEI, caller must block live mint
 *   - Overpayment is NOT refunded — exact fee value must be used
 *   - Fee is denominated in gwei (bigint)
 */

import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { getFeeQuote } from "./edmtClient.js";

export interface FeeQuoteResult {
  /** Whether a capture fee is required for this block */
  feeRequired: boolean;
  /** Required fee in gwei. Undefined if not required or unavailable. */
  requiredFeeGwei?: bigint;
  /** Whether the fee quote was successfully obtained */
  quoteAvailable: boolean;
  /** Reason if quote is unavailable */
  reason?: string;
}

/**
 * Get the required capture fee for a block.
 *
 * Returns:
 *   - { feeRequired: false, quoteAvailable: true }  — no fee needed
 *   - { feeRequired: true, requiredFeeGwei: N, quoteAvailable: true }  — fee required
 *   - { feeRequired: false, quoteAvailable: false, reason: ... }  — quote unavailable
 *
 * Callers MUST check quoteAvailable before proceeding with live mint.
 * If quoteAvailable=false, live mint must be blocked.
 */
export async function getRequiredFee(blockNumber: number): Promise<FeeQuoteResult> {
  try {
    const quote = await getFeeQuote(blockNumber);

    // Endpoint unavailable or returned unexpected shape
    if (quote === undefined) {
      const reason = `Fee quote unavailable for block ${blockNumber} — EDMT API fee endpoint did not respond`;
      logger.warn({ event: LogEvent.API_UNAVAILABLE, block: blockNumber }, reason);
      return {
        feeRequired: false,
        quoteAvailable: false,
        reason,
      };
    }

    // No fee required
    if (!quote.feeRequired) {
      return {
        feeRequired: false,
        quoteAvailable: true,
      };
    }

    // Fee required but no value returned
    if (quote.requiredFeeGwei === undefined) {
      const reason = `Fee required for block ${blockNumber} but fee value not returned by API`;
      logger.warn({ event: LogEvent.API_UNAVAILABLE, block: blockNumber }, reason);
      return {
        feeRequired: true,
        quoteAvailable: false,
        reason,
      };
    }

    // Fee required and value available
    logger.info(
      {
        event: LogEvent.BLOCK_DECISION,
        block: blockNumber,
        requiredFeeGwei: quote.requiredFeeGwei.toString(),
        maxCaptureFeeGwei: config.maxCaptureFeeGwei.toString(),
      },
      `Capture fee required for block ${blockNumber}: ${quote.requiredFeeGwei} gwei`
    );

    return {
      feeRequired: true,
      requiredFeeGwei: quote.requiredFeeGwei,
      quoteAvailable: true,
    };
  } catch (err) {
    const reason = `Fee quote error for block ${blockNumber}: ${String(err)}`;
    logger.error({ event: LogEvent.API_UNAVAILABLE, block: blockNumber, err: String(err) }, reason);
    return {
      feeRequired: false,
      quoteAvailable: false,
      reason,
    };
  }
}

/**
 * Check whether the required fee is within the configured maximum.
 * Returns true if fee is acceptable, false if it exceeds MAX_CAPTURE_FEE_GWEI.
 */
export function isFeeAcceptable(requiredFeeGwei: bigint): boolean {
  return requiredFeeGwei <= config.maxCaptureFeeGwei;
}
