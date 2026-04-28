#!/usr/bin/env node
/**
 * CLI entry point for the EDMT/eNAT Mint Bot.
 * Uses commander for argument parsing.
 *
 * Commands:
 *   scan    --limit <N>           Scan up to N blocks
 *   mint    --block <N>           Attempt to mint a specific block
 *   resume                        Resume from last checkpoint
 *   status                        Show checkpoint and stats
 *   pending                       List pending transactions
 *   dry-run --from <N> --limit <N> Dry-run scan
 *   monitor                       Poll pending txs for finality
 */

import { Command } from "commander";
import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { getDb, closeDb, getStats, getPendingTxs, getCheckpointRaw } from "./db.js";
import { initCheckpoint } from "./checkpoint.js";
import { scanBatch, decideBlock } from "./blockScanner.js";
import { execute, resetRunState } from "./mintExecutor.js";
import { poll } from "./txMonitor.js";
import { runAutoMint } from "./autoMintRunner.js";

const program = new Command();

program.name("edmt-bot").description("EDMT/eNAT Mint a Block automation bot").version("1.0.0");

// ---------------------------------------------------------------------------
// scan command
// ---------------------------------------------------------------------------
program
  .command("scan")
  .description("Scan blocks for mintable candidates")
  .option("--limit <n>", "Maximum number of blocks to scan", String(config.maxBlocksPerRun))
  .action(async (opts: { limit: string }) => {
    const limit = parseInt(opts.limit, 10);
    if (isNaN(limit) || limit <= 0) {
      console.error("Error: --limit must be a positive integer");
      process.exit(1);
    }

    initDb();
    initCheckpoint();
    resetRunState();

    logger.info(
      { event: LogEvent.BOT_START, command: "scan", limit },
      `Scanning up to ${limit} blocks`
    );

    // Temporarily override maxBlocksPerRun for this run
    (config as Record<string, unknown>)["maxBlocksPerRun"] = limit;

    const { result, mintableBlock } = await scanBatch();

    if (mintableBlock) {
      logger.info(
        { event: LogEvent.BLOCK_MINTABLE, block: mintableBlock.block },
        `Found mintable block: ${mintableBlock.block}`
      );
      console.log(`\n✅ Mintable block found: ${mintableBlock.block}`);
    }

    console.log(`\nScan complete:`);
    console.log(`  Processed:    ${result.processed}`);
    console.log(`  Mintable:     ${result.mintable}`);
    console.log(`  Minted:       ${result.minted}`);
    console.log(`  Not eligible: ${result.notEligible}`);
    console.log(`  Beyond head:  ${result.beyondHead}`);
    console.log(`  Unknown:      ${result.unknown}`);

    closeDb();
  });

// ---------------------------------------------------------------------------
// mint command
// ---------------------------------------------------------------------------
program
  .command("mint")
  .description("Attempt to mint a specific block")
  .requiredOption("--block <n>", "Block number to mint")
  .action(async (opts: { block: string }) => {
    const blockNumber = parseInt(opts.block, 10);
    if (isNaN(blockNumber) || blockNumber <= 0) {
      console.error("Error: --block must be a positive integer");
      process.exit(1);
    }

    initDb();
    resetRunState();

    logger.info(
      { event: LogEvent.BOT_START, command: "mint", block: blockNumber },
      `Attempting to mint block ${blockNumber}`
    );

    const blockResult = await decideBlock(blockNumber);
    console.log(`\nBlock ${blockNumber} status: ${blockResult.status}`);

    if (blockResult.status === "mintable") {
      const mintResult = await execute(blockResult);
      console.log(`Mint result: ${mintResult.status}`);
      if (mintResult.txHash) {
        console.log(`Tx hash: ${mintResult.txHash}`);
      }
      if (mintResult.reason) {
        console.log(`Reason: ${mintResult.reason}`);
      }
    } else {
      console.log(`Block not mintable: ${blockResult.reason ?? blockResult.status}`);
    }

    closeDb();
  });

// ---------------------------------------------------------------------------
// resume command
// ---------------------------------------------------------------------------
program
  .command("resume")
  .description("Resume scanning and minting from last checkpoint")
  .action(async () => {
    initDb();
    const startBlock = initCheckpoint();
    resetRunState();

    logger.info(
      { event: LogEvent.BOT_START, command: "resume", startBlock },
      `Resuming from block ${startBlock}`
    );
    console.log(`\nResuming from block ${startBlock}...`);

    const { result, mintableBlock } = await scanBatch();

    if (mintableBlock) {
      console.log(`\n✅ Mintable block found: ${mintableBlock.block}`);
      const mintResult = await execute(mintableBlock);
      console.log(`Mint result: ${mintResult.status}`);
      if (mintResult.txHash) console.log(`Tx hash: ${mintResult.txHash}`);
    }

    console.log(`\nResume complete — processed ${result.processed} blocks`);
    closeDb();
  });

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------
program
  .command("status")
  .description("Show current checkpoint and statistics")
  .action(() => {
    initDb();

    const lastScanned = getCheckpointRaw("last_scanned_block") ?? "not set";
    const lastSubmitted = getCheckpointRaw("last_submitted_block") ?? "not set";
    const lastMint = getCheckpointRaw("last_successful_mint_block") ?? "not set";
    const stats = getStats();

    console.log("\n=== EDMT Bot Status ===");
    console.log(`  Last scanned block:       ${lastScanned}`);
    console.log(`  Last submitted block:     ${lastSubmitted}`);
    console.log(`  Last successful mint:     ${lastMint}`);
    console.log(`  Total blocks scanned:     ${stats.totalScanned}`);
    console.log(`  Total minted:             ${stats.totalMinted}`);
    console.log(`  Total failed txs:         ${stats.totalFailed}`);
    console.log(`  Pending txs:              ${stats.totalPending}`);
    console.log(
      `  Mode:                     ${config.dryRun ? "DRY-RUN" : config.enableLiveMint ? "LIVE MINT" : "LIVE MINT DISABLED"}`
    );

    closeDb();
  });

// ---------------------------------------------------------------------------
// pending command
// ---------------------------------------------------------------------------
program
  .command("pending")
  .description("List all pending transactions")
  .action(() => {
    initDb();

    const txs = getPendingTxs();

    if (txs.length === 0) {
      console.log("\nNo pending transactions.");
    } else {
      console.log(`\n=== Pending Transactions (${txs.length}) ===`);
      for (const tx of txs) {
        console.log(
          `  Block: ${tx.block} | Hash: ${tx.tx_hash} | Nonce: ${tx.nonce} | Submitted: ${tx.submitted_at}`
        );
      }
    }

    closeDb();
  });

// ---------------------------------------------------------------------------
// dry-run command
// ---------------------------------------------------------------------------
program
  .command("dry-run")
  .description("Dry-run scan without sending any transactions")
  .option("--from <n>", "Start block number")
  .option("--limit <n>", "Number of blocks to scan", "50")
  .action(async (opts: { from?: string; limit: string }) => {
    const limit = parseInt(opts.limit, 10);
    if (isNaN(limit) || limit <= 0) {
      console.error("Error: --limit must be a positive integer");
      process.exit(1);
    }

    // Force dry-run mode
    (config as Record<string, unknown>)["dryRun"] = true;
    (config as Record<string, unknown>)["enableLiveMint"] = false;

    initDb();

    if (opts.from) {
      const fromBlock = parseInt(opts.from, 10);
      if (isNaN(fromBlock) || fromBlock <= 0) {
        console.error("Error: --from must be a positive integer");
        process.exit(1);
      }
      // Override checkpoint for this run
      const { setCheckpointRaw } = await import("./db.js");
      setCheckpointRaw("last_scanned_block", String(fromBlock));
    } else {
      initCheckpoint();
    }

    resetRunState();
    (config as Record<string, unknown>)["maxBlocksPerRun"] = limit;

    console.log(`\n[DRY-RUN] Scanning ${limit} blocks — no transactions will be sent`);
    logger.info({ event: LogEvent.BOT_START, command: "dry-run", limit }, "Dry-run scan started");

    const { result, mintableBlock } = await scanBatch();

    if (mintableBlock) {
      console.log(`\n[DRY-RUN] Would mint block: ${mintableBlock.block}`);
      await execute(mintableBlock);
    }

    console.log(`\n[DRY-RUN] Complete:`);
    console.log(`  Processed:    ${result.processed}`);
    console.log(`  Mintable:     ${result.mintable}`);
    console.log(`  Minted:       ${result.minted}`);
    console.log(`  Not eligible: ${result.notEligible}`);

    closeDb();
  });

// ---------------------------------------------------------------------------
// automint command
// ---------------------------------------------------------------------------
program
  .command("automint")
  .description("Run unattended auto mint session (requires UNATTENDED_AUTO_MINT=true)")
  .action(async () => {
    initDb();

    logger.info({ event: LogEvent.BOT_START, command: "automint" }, "AutoMint session starting");

    const report = await runAutoMint();

    console.log("\n=== Auto Mint Session Report ===");
    console.log(JSON.stringify(report, null, 2));

    closeDb();
  });

// ---------------------------------------------------------------------------
// monitor command
// ---------------------------------------------------------------------------
program
  .command("monitor")
  .description("Poll pending transactions for inclusion and finality")
  .action(async () => {
    initDb();

    logger.info({ event: LogEvent.BOT_START, command: "monitor" }, "TxMonitor started");
    console.log("\nMonitoring pending transactions...");

    await poll();

    const stats = getStats();
    console.log(`\nMonitor complete — ${stats.totalPending} pending tx(s) remaining`);

    closeDb();
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initDb(): void {
  try {
    getDb();
  } catch (err) {
    console.error(`Fatal: Failed to open database: ${String(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// highburn:scan command
// ---------------------------------------------------------------------------
program
  .command("highburn:scan")
  .description("Index blocks for high-burn candidates (no transactions sent)")
  .option("--from <n>", "Start block number")
  .option("--to <n>", "End block number")
  .option("--min-eth <n>", "Minimum burn ETH threshold")
  .action(async (opts: { from?: string; to?: string; minEth?: string }) => {
    initDb();

    const { indexBlockRange, defaultIndexOpts, getCurrentBlockNumber } =
      await import("./highBurnIndexer.js");

    const fromBlock = opts.from ? parseInt(opts.from, 10) : config.highBurnScanStartBlock;
    const minEth = opts.minEth ? parseFloat(opts.minEth) : config.highBurnActiveTierEth;

    let toBlock: number;
    if (opts.to) {
      toBlock = parseInt(opts.to, 10);
    } else if (config.highBurnScanEndBlock !== undefined) {
      toBlock = config.highBurnScanEndBlock;
    } else {
      toBlock = await getCurrentBlockNumber();
    }

    if (isNaN(fromBlock) || isNaN(toBlock) || isNaN(minEth)) {
      console.error("Error: invalid block range or min-eth value");
      process.exit(1);
    }

    console.log(`\nHigh Burn Scan: blocks ${fromBlock}–${toBlock}, min ${minEth} ETH`);

    const summary = await indexBlockRange(fromBlock, toBlock, minEth, defaultIndexOpts());

    console.log(`\nScan complete:`);
    console.log(`  Scanned:    ${summary.scanned}`);
    console.log(`  Discovered: ${summary.discovered}`);
    console.log(`  Cached:     ${summary.cached}`);
    console.log(`  Skipped:    ${summary.skipped}`);
    console.log(`  Below tier: ${summary.belowTier}`);
    console.log(`  Errors:     ${summary.errors}`);

    closeDb();
  });

// ---------------------------------------------------------------------------
// highburn:status command
// ---------------------------------------------------------------------------
program
  .command("highburn:status")
  .description("Show high burn candidate statistics grouped by tier and status")
  .action(async () => {
    initDb();

    const { getHighBurnStatusSummary } = await import("./db.js");
    const summary = getHighBurnStatusSummary();

    if (summary.length === 0) {
      console.log("\nNo high burn candidates found. Run highburn:scan first.");
      closeDb();
      return;
    }

    // Group by tier
    const byTier = new Map<number, Map<string, number>>();
    for (const row of summary) {
      if (!byTier.has(row.tier_eth)) byTier.set(row.tier_eth, new Map());
      byTier.get(row.tier_eth)!.set(row.status, row.count);
    }

    console.log("\n=== High Burn Candidates Status ===");
    console.log(
      `${"Tier (ETH)".padEnd(12)} ${"Total".padEnd(8)} ${"mintable".padEnd(10)} ${"submitted".padEnd(11)} ${"finalized".padEnd(11)} ${"minted_else".padEnd(13)} ${"skipped".padEnd(9)} ${"unknown".padEnd(9)}`
    );
    console.log("-".repeat(90));

    const tiers = [...byTier.keys()].sort((a, b) => b - a);
    for (const tier of tiers) {
      const statuses = byTier.get(tier)!;
      const total = [...statuses.values()].reduce((a, b) => a + b, 0);
      const get = (s: string) => String(statuses.get(s) ?? 0);
      console.log(
        `${String(tier).padEnd(12)} ${String(total).padEnd(8)} ${get("mintable").padEnd(10)} ${get("submitted").padEnd(11)} ${get("finalized").padEnd(11)} ${get("minted_elsewhere").padEnd(13)} ${get("skipped").padEnd(9)} ${get("unknown").padEnd(9)}`
      );
    }

    closeDb();
  });

// ---------------------------------------------------------------------------
// highburn:mint command
// ---------------------------------------------------------------------------
program
  .command("highburn:mint")
  .description("Start a High Burn Priority Mode mint session")
  .action(async () => {
    initDb();

    if (!config.highBurnPriorityMode) {
      console.error(
        "Error: HIGH_BURN_PRIORITY_MODE=false. Set HIGH_BURN_PRIORITY_MODE=true to use this command."
      );
      process.exit(1);
    }

    logger.info(
      { event: LogEvent.BOT_START, command: "highburn:mint" },
      "High burn mint session starting"
    );

    const report = await runAutoMint();

    console.log("\n=== High Burn Mint Session Report ===");
    console.log(JSON.stringify(report, null, 2));

    closeDb();
  });

// ---------------------------------------------------------------------------
// highburn:reset-cache command
// ---------------------------------------------------------------------------
program
  .command("highburn:reset-cache")
  .description("Reset all candidates for a tier to status=discovered")
  .requiredOption("--tier <n>", "Tier ETH value to reset (e.g. 4)")
  .action(async (opts: { tier: string }) => {
    const tierEth = parseFloat(opts.tier);
    if (isNaN(tierEth) || tierEth <= 0) {
      console.error("Error: --tier must be a positive number");
      process.exit(1);
    }

    initDb();

    const { resetHighBurnTier } = await import("./db.js");
    const count = resetHighBurnTier(tierEth);

    console.log(`\nReset ${count} candidates for tier ${tierEth} ETH to status=discovered`);

    closeDb();
  });

// ---------------------------------------------------------------------------
// Parse and run
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error({ event: LogEvent.BOT_STOP, err: String(err) }, "CLI error");
  console.error(`Error: ${String(err)}`);
  process.exit(1);
});
