/**
 * Print the current high_burn_candidates queue.
 *
 * CLI:
 *   npm run highburn:queue -- --min-eth 1 --limit 50
 *   npm run highburn:queue -- --status discovered,mintable,unknown
 */

import { config } from "../src/config.js";
import { getDb } from "../src/db.js";

interface QueueOpts {
  minEth: number;
  limit: number;
  status?: string[];
  includeTerminal: boolean;
}

interface QueueRow {
  block: number;
  burn_eth: number;
  tier_eth: number;
  status: string;
  edmt_status: string | null;
  minted_by: string | null;
  fee_required: number | null;
  attempts: number;
  updated_at: string;
  skip_reason: string | null;
}

function parseArgs(): QueueOpts {
  const args = process.argv.slice(2);
  const opts: QueueOpts = {
    minEth: 0,
    limit: 50,
    includeTerminal: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--min-eth" && next) opts.minEth = parseFloat(args[++i]);
    else if (arg === "--limit" && next) opts.limit = parseInt(args[++i], 10);
    else if (arg === "--status" && next) {
      opts.status = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--include-terminal") opts.includeTerminal = true;
  }

  if (!Number.isFinite(opts.minEth) || opts.minEth < 0) {
    throw new Error("--min-eth must be a non-negative number");
  }
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return opts;
}

function main(): void {
  const opts = parseArgs();
  const db = getDb();

  const where: string[] = ["burn_eth >= ?"];
  const params: unknown[] = [opts.minEth];

  if (opts.status && opts.status.length > 0) {
    where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
    params.push(...opts.status);
  } else if (!opts.includeTerminal) {
    where.push(
      "status NOT IN ('submitted','finalized','minted_elsewhere','not_eligible','fee_required_skipped','skipped')"
    );
  }

  params.push(opts.limit);

  const rows = db
    .prepare(
      `
      SELECT block, burn_eth, tier_eth, status, edmt_status, minted_by,
             fee_required, attempts, updated_at, skip_reason
      FROM high_burn_candidates
      WHERE ${where.join(" AND ")}
      ORDER BY burn_eth DESC, attempts ASC, block ASC
      LIMIT ?
    `
    )
    .all(...params) as QueueRow[];

  const summary = db
    .prepare(
      `
      SELECT status, COUNT(*) as count
      FROM high_burn_candidates
      WHERE burn_eth >= ?
      GROUP BY status
      ORDER BY status ASC
    `
    )
    .all(opts.minEth) as Array<{ status: string; count: number }>;

  console.log("\n=== High Burn Queue ===");
  console.log(`minEth=${opts.minEth} limit=${opts.limit} db=${config.sqlitePath}`);
  console.log("\nStatus summary:");
  for (const row of summary) {
    console.log(`  ${row.status.padEnd(22)} ${row.count}`);
  }

  if (rows.length === 0) {
    console.log("\nNo matching candidates.");
    return;
  }

  console.log("\nTop candidates:");
  console.log(
    `${"block".padEnd(12)} ${"burn_eth".padEnd(12)} ${"tier".padEnd(8)} ${"status".padEnd(22)} ${"edmt".padEnd(14)} ${"fee".padEnd(5)} ${"attempts".padEnd(8)} reason`
  );
  console.log("-".repeat(110));
  for (const row of rows) {
    console.log(
      `${String(row.block).padEnd(12)} ${row.burn_eth.toFixed(6).padEnd(12)} ${String(row.tier_eth).padEnd(8)} ${row.status.padEnd(22)} ${(row.edmt_status ?? "").padEnd(14)} ${String(row.fee_required ?? "").padEnd(5)} ${String(row.attempts).padEnd(8)} ${row.skip_reason ?? ""}`
    );
  }
}

try {
  main();
} catch (err) {
  console.error(`Fatal error: ${String(err)}`);
  process.exit(1);
}
