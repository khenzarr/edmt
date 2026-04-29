/**
 * highburn-catchup.ts — High Burn Candidate Catchup Script
 *
 * Processes existing high_burn_candidates from the DB without doing any new
 * block scanning or RPC burn indexing. Iterates the candidate pool in priority
 * order (tier_eth DESC, burn_eth DESC, attempts ASC, block ASC), calls EDMT API
 * for each, and mints if all safety gates pass.
 *
 * Safety rules:
 *   - No new block scan / RPC burn indexing
 *   - No high_burn_candidates cache deletion
 *   - block_results and txs duplicate protection enforced
 *   - EDMT API confirmation required before any tx
 *   - feeRequired=true blocks are skipped
 *   - review_required records block startup
 *   - STOP_AUTOMINT file blocks new txs
 *   - DRY_RUN env respected; --dry-run flag forces dry-run regardless of env
 *
 * CLI:
 *   npm run highburn:catchup -- --limit 100 --dry-run
 *   npm run highburn:catchup -- --limit 100 --tier 4 --dry-run
 *   npm run highburn:catchup -- --limit 100 --min-eth 4 --dry-run
 *   npm run highburn:catchup -- --limit 100 --max-tx 3
 */

import fs from "fs";
import { config, isLiveMintEnabled, hasPrivateKey } from "../src/config.js";
import { logger, LogEvent } from "../src/logger.js";
import { getBlockStatus } from "../src/edmtClient.js";
import { buildMintPayload, encodePayload } from "../src/calldataBuilder.js";
import { getFeeData, sendRawTransaction, getWallet, getPendingNonce } from "../src/ethClient.js";
import {
  getDb,
  hasPendingTx,
  hasReviewRequiredTx,
  isBlockSubmittedOrBeyond,
  getTxByBlock,
  insertTx,
  updateHighBurnCandidateStatus,
  upsertBlockResult,
} from "../src/db.js";
import { setSubmittedBlock } from "../src/checkpoint.js";
import type { HighBurnCandidateRow } from "../src/types.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CatchupOpts {
  limit: number;
  tierEth: number | null;
  minEth: number | null;
  maxTx: number;
  dryRun: boolean;
}

function parseArgs(): CatchupOpts {
  const args = process.argv.slice(2);
  let limit = 100;
  let tierEth: number | null = null;
  let minEth: number | null = null;
  let maxTx = 999;
  let dryRun = config.dryRun; // default from env

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (arg === "--tier" && args[i + 1]) {
      tierEth = parseFloat(args[++i]);
    } else if (arg === "--min-eth" && args[i + 1]) {
      minEth = parseFloat(args[++i]);
    } else if (arg === "--max-tx" && args[i + 1]) {
      maxTx = parseInt(args[++i], 10);
    }
  }

  return { limit, tierEth, minEth, maxTx, dryRun };
}

// ---------------------------------------------------------------------------
// DB query: fetch catchup candidates
// ---------------------------------------------------------------------------

interface CatchupCandidateRow extends HighBurnCandidateRow {
  minted_by: string | null;
  mint_tx_hash: string | null;
  last_attempt_at: string | null;
  skip_reason: string | null;
}

function fetchCandidates(opts: CatchupOpts): CatchupCandidateRow[] {
  const db = getDb();
  const unknownRetryMinutes = config.highBurnUnknownRetryMinutes;

  // Eligible statuses: discovered, mintable, unknown (with retry backoff)
  // Excluded: finalized, submitted, pending, included, minted_elsewhere,
  //           not_eligible, fee_required_skipped, review_required, skipped
  let sql = `
    SELECT block, burn_gwei, burn_eth, tier_eth, status, edmt_status,
           minted_by, mint_tx_hash, fee_required, seen_at, updated_at,
           attempts, last_attempt_at, skip_reason
    FROM high_burn_candidates
    WHERE status IN ('discovered', 'mintable', 'unknown')
      AND (
        status != 'unknown'
        OR last_attempt_at IS NULL
        OR (julianday('now') - julianday(last_attempt_at)) * 1440 >= ?
      )
  `;

  const params: unknown[] = [unknownRetryMinutes];

  if (opts.tierEth !== null) {
    sql += " AND tier_eth = ?";
    params.push(opts.tierEth);
  } else if (opts.minEth !== null) {
    sql += " AND burn_eth >= ?";
    params.push(opts.minEth);
  }

  sql += `
    ORDER BY tier_eth DESC, burn_eth DESC, attempts ASC, block ASC
    LIMIT ?
  `;
  params.push(opts.limit);

  return db.prepare(sql).all(...params) as CatchupCandidateRow[];
}

// ---------------------------------------------------------------------------
// Report structure
// ---------------------------------------------------------------------------

interface CatchupReport {
  mode: "highburn_catchup";
  dryRun: boolean;
  candidatesChecked: number;
  mintableFound: number;
  txSubmitted: number;
  mintedElsewhere: number;
  feeRequiredSkipped: number;
  unknown: number;
  notEligible: number;
  duplicatesSkipped: number;
  pendingCapacitySkips: number;
  nonceAnomalies: number;
  txHashes: string[];
  topAttempted: Array<{ block: number; burnEth: number; decision: string; reason: string }>;
  stoppedReason: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log(`\n=== High Burn Catchup [${opts.dryRun ? "DRY-RUN" : "LIVE"}] ===`);
  console.log(
    `  limit=${opts.limit}  tier=${opts.tierEth ?? "all"}  minEth=${opts.minEth ?? "any"}  maxTx=${opts.maxTx}\n`
  );

  const report: CatchupReport = {
    mode: "highburn_catchup",
    dryRun: opts.dryRun,
    candidatesChecked: 0,
    mintableFound: 0,
    txSubmitted: 0,
    mintedElsewhere: 0,
    feeRequiredSkipped: 0,
    unknown: 0,
    notEligible: 0,
    duplicatesSkipped: 0,
    pendingCapacitySkips: 0,
    nonceAnomalies: 0,
    txHashes: [],
    topAttempted: [],
    stoppedReason: "",
  };

  // -------------------------------------------------------------------------
  // Pre-flight: review_required check
  // -------------------------------------------------------------------------
  if (hasReviewRequiredTx()) {
    report.stoppedReason = "review_required_detected";
    console.error(
      "❌ review_required records exist in DB. Run `npm run reconcile` first to clear them."
    );
    printReport(report);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Pre-flight: live mint safety gates
  // -------------------------------------------------------------------------
  if (!opts.dryRun) {
    if (!isLiveMintEnabled()) {
      report.stoppedReason = "live_mint_disabled";
      console.error("❌ Live mint disabled (DRY_RUN=true or ENABLE_LIVE_MINT=false).");
      printReport(report);
      process.exit(1);
    }
    if (!hasPrivateKey()) {
      report.stoppedReason = "no_private_key";
      console.error("❌ PRIVATE_KEY not set.");
      printReport(report);
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // Fetch candidates
  // -------------------------------------------------------------------------
  const candidates = fetchCandidates(opts);
  console.log(`  Found ${candidates.length} candidate(s) to process.\n`);

  if (candidates.length === 0) {
    report.stoppedReason = "no_candidates";
    printReport(report);
    return;
  }

  // -------------------------------------------------------------------------
  // Process each candidate
  // -------------------------------------------------------------------------
  for (const candidate of candidates) {
    // Check STOP_AUTOMINT file before each tx attempt
    if (!opts.dryRun && fs.existsSync(config.autoMintEmergencyStopFile)) {
      report.stoppedReason = "emergency_stop_file_detected";
      console.warn(`\n⚠️  STOP file detected: ${config.autoMintEmergencyStopFile} — halting.`);
      break;
    }

    // Max tx limit
    if (report.txSubmitted >= opts.maxTx) {
      report.stoppedReason = "max_tx_reached";
      break;
    }

    report.candidatesChecked++;

    // Increment attempts + last_attempt_at immediately
    updateHighBurnCandidateStatus(candidate.block, candidate.status, {
      incrementAttempts: true,
    });

    const decision = await processCandidate(candidate, opts, report);

    report.topAttempted.push({
      block: candidate.block,
      burnEth: candidate.burn_eth,
      decision: decision.decision,
      reason: decision.reason,
    });

    logger.info(
      {
        event: LogEvent.HIGH_BURN_CANDIDATE_SELECTED,
        block: candidate.block,
        burnEth: candidate.burn_eth,
        tierEth: candidate.tier_eth,
        decision: decision.decision,
        reason: decision.reason,
        dryRun: opts.dryRun,
      },
      `Catchup: block ${candidate.block} → ${decision.decision} (${decision.reason})`
    );
  }

  if (!report.stoppedReason) {
    report.stoppedReason = "completed";
  }

  printReport(report);
}

// ---------------------------------------------------------------------------
// Process a single candidate
// ---------------------------------------------------------------------------

interface ProcessResult {
  decision: string;
  reason: string;
}

async function processCandidate(
  candidate: CatchupCandidateRow,
  opts: CatchupOpts,
  report: CatchupReport
): Promise<ProcessResult> {
  const block = candidate.block;

  // -------------------------------------------------------------------------
  // Duplicate check: block_results already submitted/beyond
  // -------------------------------------------------------------------------
  if (isBlockSubmittedOrBeyond(block)) {
    report.duplicatesSkipped++;
    updateHighBurnCandidateStatus(block, "skipped", { skip_reason: "already_submitted" });
    return { decision: "duplicate_skipped", reason: "already_submitted_in_block_results" };
  }

  // Duplicate check: txs table
  const existingTx = getTxByBlock(block);
  if (existingTx) {
    report.duplicatesSkipped++;
    updateHighBurnCandidateStatus(block, "skipped", { skip_reason: "tx_exists" });
    return {
      decision: "duplicate_skipped",
      reason: `existing_tx_${existingTx.tx_hash.slice(0, 10)}`,
    };
  }

  // Non-pipeline mode must preserve the single-pending-tx safety gate.
  if (!config.autoMintPipelineMode && !config.allowMultiplePendingTx && hasPendingTx()) {
    report.pendingCapacitySkips++;
    return {
      decision: "pending_tx_skip",
      reason: "pending_tx_exists_and_ALLOW_MULTIPLE_PENDING_TX=false",
    };
  }

  // -------------------------------------------------------------------------
  // Pipeline capacity check (if pipeline mode enabled)
  // -------------------------------------------------------------------------
  if (config.autoMintPipelineMode) {
    const { getPendingTxCount, getUnfinalizedTxCount } = await import("../src/db.js");
    const pendingCount = getPendingTxCount();
    const unfinalizedCount = getUnfinalizedTxCount();

    if (pendingCount >= config.autoMintMaxPendingTxs) {
      report.pendingCapacitySkips++;
      return {
        decision: "pipeline_capacity_skip",
        reason: `pending_txs=${pendingCount} >= max=${config.autoMintMaxPendingTxs}`,
      };
    }
    if (unfinalizedCount >= config.autoMintMaxUnfinalizedTxs) {
      report.pendingCapacitySkips++;
      return {
        decision: "pipeline_capacity_skip",
        reason: `unfinalized_txs=${unfinalizedCount} >= max=${config.autoMintMaxUnfinalizedTxs}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // EDMT API check
  // -------------------------------------------------------------------------
  let blockResult;
  try {
    blockResult = await getBlockStatus(block);
  } catch (err) {
    report.unknown++;
    updateHighBurnCandidateStatus(block, "unknown", {
      skip_reason: "edmt_api_error",
      edmt_status: "unknown",
    });
    return { decision: "unknown", reason: `edmt_api_error: ${String(err)}` };
  }

  // EDMT status not confirmed (API unavailable / RPC fallback only)
  if (!blockResult.edmtStatusConfirmed) {
    report.unknown++;
    updateHighBurnCandidateStatus(block, "unknown", {
      skip_reason: "edmt_status_unconfirmed",
      edmt_status: "unknown",
    });
    return { decision: "unknown", reason: "edmt_status_unconfirmed" };
  }

  // -------------------------------------------------------------------------
  // Status-based routing
  // -------------------------------------------------------------------------

  // Already minted by someone else
  if (blockResult.status === "minted") {
    report.mintedElsewhere++;
    updateHighBurnCandidateStatus(block, "minted_elsewhere", {
      edmt_status: "minted",
      minted_by: blockResult.owner ?? "unknown",
      mint_tx_hash: blockResult.mintTx ?? undefined,
    });
    upsertBlockResult({
      block,
      status: "minted",
      owner: blockResult.owner,
      mintTx: blockResult.mintTx,
    });
    return {
      decision: "minted_elsewhere",
      reason: `minted_by=${blockResult.owner ?? "unknown"}`,
    };
  }

  // Not eligible
  if (blockResult.status === "not_eligible") {
    report.notEligible++;
    updateHighBurnCandidateStatus(block, "not_eligible", {
      edmt_status: "not_eligible",
      skip_reason: blockResult.reason ?? "api_not_eligible",
    });
    return { decision: "not_eligible", reason: blockResult.reason ?? "api_not_eligible" };
  }

  // Beyond head or unknown
  if (blockResult.status === "beyond_current_head" || blockResult.status === "unknown") {
    report.unknown++;
    updateHighBurnCandidateStatus(block, "unknown", {
      edmt_status: blockResult.status,
      skip_reason: blockResult.reason ?? blockResult.status,
    });
    return { decision: "unknown", reason: blockResult.reason ?? blockResult.status };
  }

  // -------------------------------------------------------------------------
  // status === "mintable" — proceed with mint checks
  // -------------------------------------------------------------------------
  if (blockResult.status !== "mintable") {
    report.unknown++;
    return { decision: "unknown", reason: `unexpected_status_${blockResult.status}` };
  }

  // Fee check
  if (blockResult.feeRequired) {
    report.feeRequiredSkipped++;
    updateHighBurnCandidateStatus(block, "fee_required_skipped", {
      edmt_status: "mintable",
      fee_required: true,
      skip_reason: "fee_required",
    });
    return { decision: "fee_required_skipped", reason: "fee_required=true" };
  }

  // Update candidate to mintable
  updateHighBurnCandidateStatus(block, "mintable", {
    edmt_status: "mintable",
    fee_required: false,
  });

  report.mintableFound++;

  // -------------------------------------------------------------------------
  // Dry-run: produce calldata but don't send
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    const payload = buildMintPayload(block);
    const encoded = encodePayload(payload);
    console.log(
      `  ✅ [DRY-RUN] would_mint block=${block} burn_eth=${candidate.burn_eth.toFixed(4)} payload=${payload} encoded=${encoded.slice(0, 20)}...`
    );
    return { decision: "would_mint", reason: "dry_run" };
  }

  // -------------------------------------------------------------------------
  // Live mint
  // -------------------------------------------------------------------------

  // Gas check
  let feeData;
  try {
    feeData = await getFeeData();
  } catch (err) {
    return { decision: "skipped", reason: `gas_fetch_error: ${String(err)}` };
  }

  const maxFeePerGasLimit = BigInt(config.maxGasGwei) * BigInt(1_000_000_000);
  const networkMaxFee = feeData.maxFeePerGas ?? 0n;

  if (networkMaxFee > maxFeePerGasLimit) {
    return {
      decision: "skipped",
      reason: `gas_too_high: ${networkMaxFee / BigInt(1_000_000_000)} gwei > max ${config.maxGasGwei} gwei`,
    };
  }

  const maxPriorityFeeLimit = BigInt(config.maxPriorityFeeGwei) * BigInt(1_000_000_000);
  const networkPriorityFee = feeData.maxPriorityFeePerGas ?? 0n;
  const effectivePriorityFee =
    networkPriorityFee > maxPriorityFeeLimit ? maxPriorityFeeLimit : networkPriorityFee;

  // Wallet balance check
  const wallet = getWallet();
  const walletAddress = wallet.address;
  const { getWalletBalanceEth } = await import("../src/ethClient.js");
  const balanceEth = await getWalletBalanceEth(walletAddress);

  if (balanceEth < config.autoMintMinWalletBalanceEth) {
    report.stoppedReason = "wallet_balance_low";
    return {
      decision: "skipped",
      reason: `wallet_balance_low: ${balanceEth.toFixed(6)} ETH < min ${config.autoMintMinWalletBalanceEth} ETH`,
    };
  }

  // Nonce check
  const expectedNonce = await getPendingNonce(walletAddress);
  const currentNonce = await getPendingNonce(walletAddress);
  if (currentNonce !== expectedNonce) {
    report.nonceAnomalies++;
    return {
      decision: "nonce_anomaly",
      reason: `expected=${expectedNonce} got=${currentNonce}`,
    };
  }

  // Build and send
  const payload = buildMintPayload(block);
  const data = encodePayload(payload);

  const tx = {
    to: walletAddress,
    from: walletAddress,
    value: 0n,
    data,
    maxFeePerGas: networkMaxFee,
    maxPriorityFeePerGas: effectivePriorityFee,
    type: 2 as const,
  };

  let response;
  try {
    response = await sendRawTransaction(tx);
  } catch (err) {
    return { decision: "error", reason: `send_failed: ${String(err)}` };
  }

  const gasInfo = {
    maxFeePerGas: networkMaxFee.toString(),
    maxPriorityFeePerGas: effectivePriorityFee.toString(),
  };

  insertTx({
    block,
    txHash: response.hash,
    status: "pending",
    nonce: response.nonce,
    gasInfo,
  });

  setSubmittedBlock(block);

  updateHighBurnCandidateStatus(block, "submitted", {
    edmt_status: "mintable",
    mint_tx_hash: response.hash,
  });

  upsertBlockResult({
    block,
    status: "submitted",
    mintTx: response.hash,
  });

  report.txSubmitted++;
  report.txHashes.push(response.hash);

  console.log(`  🚀 SUBMITTED block=${block} txHash=${response.hash}`);

  return { decision: "submitted", reason: response.hash };
}

// ---------------------------------------------------------------------------
// Print report
// ---------------------------------------------------------------------------

function printReport(report: CatchupReport): void {
  console.log("\n=== Catchup Report ===");
  console.log(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
