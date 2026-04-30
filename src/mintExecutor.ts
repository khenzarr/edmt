/**
 * MintExecutor — prepares and sends EDMT/eNAT mint transactions.
 *
 * Live mint safety gates (ALL must pass before sendTransaction is called):
 *   1.  DRY_RUN=false
 *   2.  ENABLE_LIVE_MINT=true
 *   3.  PRIVATE_KEY present
 *   4.  block status = mintable
 *   5.  block-specific EDMT status confirmed (edmtStatusConfirmed=true)
 *   6.  capture fee quote obtained (if required)
 *   7.  requiredFeeGwei <= MAX_CAPTURE_FEE_GWEI
 *   8.  gas within limits (maxFeePerGas <= MAX_GAS_GWEI)
 *   9.  no duplicate tx for this block in txs table
 *   10. ALLOW_MULTIPLE_PENDING_TX=false → no pending tx exists
 *   11. MAX_TX_PER_RUN not exceeded
 *   12. REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX=true → CLI confirm on first tx
 */

import * as readline from "readline";
import { config, hasPrivateKey } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { buildMintPayload, encodePayload } from "./calldataBuilder.js";
import { getRequiredFee, isFeeAcceptable } from "./feeQuoter.js";
import { getFeeData, sendRawTransaction, getWallet } from "./ethClient.js";
import { insertTx, getTxByBlock, hasPendingTx, isBlockSubmittedOrBeyond } from "./db.js";
import { setSubmittedBlock } from "./checkpoint.js";
import type { BlockResult, MintResult, GasInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Run-level state (reset per bot invocation)
// ---------------------------------------------------------------------------

let txSentThisRun = 0;
let firstTxConfirmed = false;

export function resetRunState(): void {
  txSentThisRun = 0;
  firstTxConfirmed = false;
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function execute(
  blockResult: BlockResult,
  opts: { mode?: "manual" | "automint"; pipelineMode?: boolean; expectedNonce?: number } = {}
): Promise<MintResult> {
  const block = blockResult.block;
  const isAutoMint = opts.mode === "automint";
  const isPipelineMode = opts.pipelineMode === true;

  // -------------------------------------------------------------------------
  // Gate 1 & 2: DRY_RUN and ENABLE_LIVE_MINT flags
  // -------------------------------------------------------------------------
  if (config.dryRun) {
    return await dryRunLog(block, blockResult);
  }

  if (!config.enableLiveMint) {
    logger.warn(
      { event: LogEvent.MINT_GATE_FAILED, block, gate: "enable_live_mint" },
      "Live mint disabled (ENABLE_LIVE_MINT=false) — skipping tx"
    );
    return { block, status: "skipped_live_mint_disabled", reason: "ENABLE_LIVE_MINT=false" };
  }

  // -------------------------------------------------------------------------
  // Gate 3: PRIVATE_KEY
  // -------------------------------------------------------------------------
  if (!hasPrivateKey()) {
    logger.error(
      { event: LogEvent.MINT_GATE_FAILED, block, gate: "private_key" },
      "PRIVATE_KEY not set — cannot send live mint tx"
    );
    return { block, status: "skipped_no_private_key", reason: "PRIVATE_KEY not set" };
  }

  // -------------------------------------------------------------------------
  // Gate 4: block status must be mintable
  // -------------------------------------------------------------------------
  if (blockResult.status !== "mintable") {
    return {
      block,
      status: "skipped_live_mint_disabled",
      reason: `Block status is ${blockResult.status}, not mintable`,
    };
  }

  // -------------------------------------------------------------------------
  // Gate 5: EDMT block-specific status must be confirmed
  // -------------------------------------------------------------------------
  if (!blockResult.edmtStatusConfirmed) {
    logger.warn(
      { event: LogEvent.MINT_GATE_FAILED, block, gate: "edmt_status_confirmed" },
      "EDMT block-specific status not confirmed — live mint blocked (RPC-only fallback is insufficient)"
    );
    return {
      block,
      status: "skipped_edmt_status_unconfirmed",
      reason: "EDMT block-specific status not confirmed by API",
    };
  }

  // -------------------------------------------------------------------------
  // Gate 6 & 7: Capture fee
  // -------------------------------------------------------------------------
  let feeGwei: bigint | undefined;

  if (blockResult.feeRequired) {
    const feeResult = await getRequiredFee(block);

    if (!feeResult.quoteAvailable) {
      logger.warn(
        { event: LogEvent.MINT_GATE_FAILED, block, gate: "fee_quote", reason: feeResult.reason },
        "Fee quote unavailable — live mint blocked"
      );
      return {
        block,
        status: "skipped_fee_quote_unavailable",
        reason: feeResult.reason ?? "Fee quote unavailable",
      };
    }

    if (feeResult.feeRequired && feeResult.requiredFeeGwei !== undefined) {
      if (!isFeeAcceptable(feeResult.requiredFeeGwei)) {
        logger.warn(
          {
            event: LogEvent.MINT_GATE_FAILED,
            block,
            gate: "fee_max",
            requiredFeeGwei: feeResult.requiredFeeGwei.toString(),
            maxCaptureFeeGwei: config.maxCaptureFeeGwei.toString(),
          },
          `Fee ${feeResult.requiredFeeGwei} gwei exceeds MAX_CAPTURE_FEE_GWEI ${config.maxCaptureFeeGwei} — skipping`
        );
        return {
          block,
          status: "skipped_fee_exceeds_max",
          reason: `requiredFeeGwei ${feeResult.requiredFeeGwei} > MAX_CAPTURE_FEE_GWEI ${config.maxCaptureFeeGwei}`,
        };
      }
      feeGwei = feeResult.requiredFeeGwei;
    }
  }

  // -------------------------------------------------------------------------
  // Gate 8: Gas limits
  // -------------------------------------------------------------------------
  const feeData = await getFeeData();
  const maxFeePerGasLimit = BigInt(config.maxGasGwei) * BigInt(1_000_000_000);
  const maxPriorityFeeLimit = BigInt(config.maxPriorityFeeGwei) * BigInt(1_000_000_000);

  const networkMaxFee = feeData.maxFeePerGas ?? 0n;

  if (networkMaxFee > maxFeePerGasLimit) {
    logger.warn(
      {
        event: LogEvent.MINT_GATE_FAILED,
        block,
        gate: "gas_max",
        networkMaxFeeGwei: (networkMaxFee / BigInt(1_000_000_000)).toString(),
        limitGwei: config.maxGasGwei,
      },
      `Gas price ${networkMaxFee / BigInt(1_000_000_000)} gwei exceeds MAX_GAS_GWEI ${config.maxGasGwei} — skipping`
    );
    return {
      block,
      status: "skipped_gas_exceeds_max",
      reason: `maxFeePerGas ${networkMaxFee} > limit ${maxFeePerGasLimit}`,
    };
  }

  // Clamp priority fee
  const networkPriorityFee = feeData.maxPriorityFeePerGas ?? 0n;
  const effectivePriorityFee =
    networkPriorityFee > maxPriorityFeeLimit ? maxPriorityFeeLimit : networkPriorityFee;

  // -------------------------------------------------------------------------
  // Gate 9: Duplicate tx prevention
  // -------------------------------------------------------------------------
  // Pipeline mode: check block_results table for submitted/beyond status
  if (isPipelineMode && isBlockSubmittedOrBeyond(block)) {
    logger.warn(
      {
        event: LogEvent.PIPELINE_DUPLICATE_PREVENTED,
        block,
        gate: "pipeline_duplicate_tx",
      },
      `Pipeline duplicate tx prevented for block ${block} — block already submitted or beyond`
    );
    return {
      block,
      status: "skipped_duplicate_tx",
      reason: `Block ${block} already has submitted/beyond status in block_results`,
    };
  }

  const ACTIVE_TX_STATUSES = ["pending", "submitted", "included", "finalized", "successful_mint"];
  const existingTx = getTxByBlock(block);
  if (existingTx && ACTIVE_TX_STATUSES.includes(existingTx.status)) {
    logger.warn(
      {
        event: LogEvent.MINT_GATE_FAILED,
        block,
        gate: "duplicate_tx",
        existingTxHash: existingTx.tx_hash,
        existingStatus: existingTx.status,
      },
      `Duplicate tx prevented for block ${block} — existing tx: ${existingTx.tx_hash}`
    );
    return {
      block,
      status: "skipped_duplicate_tx",
      reason: `Existing tx ${existingTx.tx_hash} (${existingTx.status}) for block ${block}`,
    };
  }
  // dropped/failed → fall through, allow new mint attempt

  // -------------------------------------------------------------------------
  // Gate 10: Pending tx check (bypassed in pipeline mode — nonce managed by AutoMintRunner)
  // -------------------------------------------------------------------------
  if (!isPipelineMode && !config.allowMultiplePendingTx && hasPendingTx()) {
    logger.warn(
      { event: LogEvent.MINT_GATE_FAILED, block, gate: "pending_tx" },
      "Pending tx exists and ALLOW_MULTIPLE_PENDING_TX=false — skipping new tx"
    );
    return {
      block,
      status: "skipped_pending_tx",
      reason: "Pending tx exists; ALLOW_MULTIPLE_PENDING_TX=false",
    };
  }

  // -------------------------------------------------------------------------
  // Gate 11: MAX_TX_PER_RUN (skipped in automint mode — session limits managed by AutoMintRunner)
  // -------------------------------------------------------------------------
  if (!isAutoMint && txSentThisRun >= config.maxTxPerRun) {
    logger.warn(
      { event: LogEvent.MINT_GATE_FAILED, block, gate: "tx_run_limit", txSentThisRun },
      `MAX_TX_PER_RUN (${config.maxTxPerRun}) reached — stopping`
    );
    return {
      block,
      status: "skipped_tx_run_limit",
      reason: `MAX_TX_PER_RUN=${config.maxTxPerRun} reached`,
    };
  }

  // -------------------------------------------------------------------------
  // Gate 12: Manual confirmation for first tx
  // -------------------------------------------------------------------------
  if (config.requireManualConfirmationForFirstTx && !firstTxConfirmed) {
    const confirmed = await promptConfirmation(block, feeGwei);
    if (!confirmed) {
      logger.warn(
        { event: LogEvent.MINT_GATE_FAILED, block, gate: "manual_confirm" },
        "User declined manual confirmation — tx not sent"
      );
      return { block, status: "skipped_live_mint_disabled", reason: "User declined confirmation" };
    }
    firstTxConfirmed = true;
  }

  // -------------------------------------------------------------------------
  // Build and send transaction
  // -------------------------------------------------------------------------
  const payload = buildMintPayload(block, feeGwei);
  const data = encodePayload(payload);
  const wallet = getWallet();
  const walletAddress = wallet.address;

  const gasInfo: GasInfo = {
    maxFeePerGas: networkMaxFee.toString(),
    maxPriorityFeePerGas: effectivePriorityFee.toString(),
  };

  // Pipeline mode: validate expectedNonce matches current pending nonce
  if (isPipelineMode && opts.expectedNonce !== undefined) {
    const { getPendingNonce } = await import("./ethClient.js");
    const currentNonce = await getPendingNonce(walletAddress);
    if (currentNonce !== opts.expectedNonce) {
      logger.error(
        {
          event: LogEvent.PIPELINE_NONCE_ANOMALY,
          block,
          expectedNonce: opts.expectedNonce,
          currentNonce,
        },
        `Pipeline nonce mismatch for block ${block}: expected ${opts.expectedNonce}, got ${currentNonce}`
      );
      return {
        block,
        status: "error",
        reason: `Nonce mismatch: expected ${opts.expectedNonce}, got ${currentNonce}`,
      };
    }
  }

  const tx = {
    to: walletAddress,
    from: walletAddress,
    value: 0n,
    data,
    maxFeePerGas: networkMaxFee,
    maxPriorityFeePerGas: effectivePriorityFee,
    type: 2,
  };

  logger.info(
    {
      event: LogEvent.MINT_SUBMITTED,
      block,
      payload,
      feeGwei: feeGwei?.toString(),
      gasInfo,
    },
    `Sending mint tx for block ${block}`
  );

  const response = await sendRawTransaction(tx);
  txSentThisRun++;

  // Persist tx record
  const nonce = response.nonce;
  insertTx({
    block,
    txHash: response.hash,
    status: "pending",
    nonce,
    gasInfo,
  });

  // Update checkpoint
  setSubmittedBlock(block);

  logger.info(
    { event: LogEvent.MINT_SUBMITTED, block, txHash: response.hash, nonce },
    `Mint tx submitted for block ${block}: ${response.hash}`
  );

  return {
    block,
    status: "submitted",
    txHash: response.hash,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Dry-run logging
// ---------------------------------------------------------------------------

async function dryRunLog(block: number, blockResult: BlockResult): Promise<MintResult> {
  // Still compute fee and gas for informational purposes
  let feeGwei: bigint | undefined;
  let feeReason: string | undefined;

  if (blockResult.feeRequired) {
    const feeResult = await getRequiredFee(block);
    if (feeResult.quoteAvailable && feeResult.requiredFeeGwei !== undefined) {
      feeGwei = feeResult.requiredFeeGwei;
    } else {
      feeReason = feeResult.reason;
    }
  }

  let gasInfo: Partial<GasInfo>;
  try {
    const feeData = await getFeeData();
    gasInfo = {
      maxFeePerGas: feeData.maxFeePerGas?.toString() ?? "unknown",
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() ?? "unknown",
    };
  } catch {
    gasInfo = { maxFeePerGas: "rpc_unavailable", maxPriorityFeePerGas: "rpc_unavailable" };
  }

  const payload = buildMintPayload(block, feeGwei);
  const encoded = encodePayload(payload);

  logger.info(
    {
      event: LogEvent.MINT_DRY_RUN,
      block,
      payload,
      encodedData: encoded,
      feeGwei: feeGwei?.toString(),
      feeReason,
      gasInfo,
      edmtStatusConfirmed: blockResult.edmtStatusConfirmed,
      dryRun: true,
    },
    `[DRY-RUN] Would mint block ${block} — no tx sent`
  );

  return {
    block,
    status: "dry_run",
    payload,
    reason: "DRY_RUN=true — no transaction sent",
  };
}

// ---------------------------------------------------------------------------
// CLI confirmation prompt
// ---------------------------------------------------------------------------

async function promptConfirmation(block: number, feeGwei?: bigint): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const feeStr = feeGwei !== undefined ? ` (capture fee: ${feeGwei} gwei)` : "";
    rl.question(
      `\n⚠️  LIVE MINT: About to send tx for block ${block}${feeStr}.\nType "yes" to confirm: `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "yes");
      }
    );
  });
}
