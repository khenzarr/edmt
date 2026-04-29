/**
 * Import EDMT pending mints into high_burn_candidates without RPC scanning.
 *
 * EDMT's public API exposes pending/unminted candidates ordered by burn. This is
 * the cheapest path for high-burn hunting because it avoids historical
 * getBlock RPC calls entirely.
 *
 * CLI:
 *   npm run highburn:import-pending -- --min-eth 1 --page-size 100
 *   npm run highburn:import-pending -- --min-eth 0.05 --page-size 100 --reset-cursor
 *   npm run highburn:import-pending -- --dry-run --pages 2
 */

import { config } from "../src/config.js";
import { getDb, getCheckpointRaw, setCheckpointRaw, upsertHighBurnCandidate } from "../src/db.js";
import { assignTier } from "../src/highBurnIndexer.js";

const CURSOR_KEY = "highburn_pending_cursor";
const AS_OF_BLOCK_KEY = "highburn_pending_as_of_block";
const LAST_MIN_ETH_KEY = "highburn_pending_min_eth";

interface ImportOpts {
  minEth: number;
  pageSize: number;
  pages: number;
  cursor?: string;
  resetCursor: boolean;
  dryRun: boolean;
  sleepMs: number;
  retryLimit: number;
  rateLimitCooldownMs: number;
  stopBelowMin: boolean;
  apiBaseUrl: string;
}

interface PendingApiItem {
  blk: number;
  burn: string | number;
  minted_by?: string | null;
  finalized?: boolean;
}

interface PendingApiResponse {
  data?: {
    items?: PendingApiItem[];
    next_cursor?: string | null;
    count?: number;
  };
  as_of_block?: number;
  as_of_finalized?: number;
}

interface ImportReport {
  mode: "highburn_import_pending";
  dryRun: boolean;
  minEth: number;
  pagesFetched: number;
  itemsSeen: number;
  imported: number;
  belowMin: number;
  mintedSkipped: number;
  errors: number;
  nextCursor?: string;
  stoppedReason: string;
}

function parseArgs(): ImportOpts {
  const args = process.argv.slice(2);
  const opts: ImportOpts = {
    minEth: 1,
    pageSize: 100,
    pages: 0,
    resetCursor: false,
    dryRun: false,
    sleepMs: 500,
    retryLimit: 8,
    rateLimitCooldownMs: 300_000,
    stopBelowMin: true,
    apiBaseUrl: config.highBurnPendingApiBaseUrl,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--min-eth" && next) opts.minEth = parseFloat(args[++i]);
    else if (arg === "--page-size" && next) opts.pageSize = parseInt(args[++i], 10);
    else if (arg === "--pages" && next) opts.pages = parseInt(args[++i], 10);
    else if (arg === "--cursor" && next) opts.cursor = args[++i];
    else if (arg === "--reset-cursor") opts.resetCursor = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--sleep-ms" && next) opts.sleepMs = parseInt(args[++i], 10);
    else if (arg === "--retry-limit" && next) opts.retryLimit = parseInt(args[++i], 10);
    else if (arg === "--rate-limit-cooldown-ms" && next) {
      opts.rateLimitCooldownMs = parseInt(args[++i], 10);
    } else if (arg === "--no-stop-below-min") opts.stopBelowMin = false;
    else if (arg === "--api-base-url" && next) opts.apiBaseUrl = args[++i];
  }

  if (!Number.isFinite(opts.minEth) || opts.minEth < 0) {
    throw new Error("--min-eth must be a non-negative number");
  }
  if (!Number.isInteger(opts.pageSize) || opts.pageSize <= 0 || opts.pageSize > 500) {
    throw new Error("--page-size must be an integer between 1 and 500");
  }
  if (!Number.isInteger(opts.pages) || opts.pages < 0) {
    throw new Error("--pages must be a non-negative integer (0 = unlimited)");
  }
  return opts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(status: number, text: string): boolean {
  return status === 429 || /rate|too many|limit/i.test(text);
}

async function fetchJsonWithRetry(url: string, opts: ImportOpts): Promise<PendingApiResponse> {
  let lastError = "";

  for (let attempt = 1; attempt <= opts.retryLimit; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();

      if (res.ok) return JSON.parse(text) as PendingApiResponse;

      lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      const waitMs = isRateLimit(res.status, text)
        ? opts.rateLimitCooldownMs
        : Math.min(1000 * 2 ** (attempt - 1), 30_000);
      console.warn(`API fetch failed (${lastError}); retrying in ${waitMs}ms`);
      await sleep(waitMs);
    } catch (err) {
      lastError = String(err);
      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      console.warn(`API fetch threw (${lastError}); retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }

  throw new Error(`Failed to fetch ${url}: ${lastError}`);
}

function buildUrl(opts: ImportOpts, cursor?: string): string {
  const base = opts.apiBaseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/mints/pending`);
  url.searchParams.set("limit", String(opts.pageSize));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

function burnGweiToEth(burnGwei: bigint): number {
  return Number(burnGwei) / 1_000_000_000;
}

function tierForBurn(burnEth: number, minEth: number): number {
  return assignTier(burnEth, config.highBurnMinEthTiers) ?? minEth;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  getDb();

  let cursor: string | undefined;
  if (opts.cursor) cursor = opts.cursor;
  else if (!opts.resetCursor) cursor = getCheckpointRaw(CURSOR_KEY);

  const report: ImportReport = {
    mode: "highburn_import_pending",
    dryRun: opts.dryRun,
    minEth: opts.minEth,
    pagesFetched: 0,
    itemsSeen: 0,
    imported: 0,
    belowMin: 0,
    mintedSkipped: 0,
    errors: 0,
    nextCursor: cursor,
    stoppedReason: "",
  };

  console.log(
    `\n=== High Burn Pending Import [${opts.dryRun ? "DRY-RUN" : "WRITE"}] ===`
  );
  console.log(
    `  minEth=${opts.minEth} pageSize=${opts.pageSize} pages=${opts.pages || "unlimited"} cursor=${cursor ?? "start"}`
  );

  while (opts.pages === 0 || report.pagesFetched < opts.pages) {
    const url = buildUrl(opts, cursor);
    const body = await fetchJsonWithRetry(url, opts);
    const items = body.data?.items ?? [];
    const nextCursor = body.data?.next_cursor ?? undefined;

    report.pagesFetched++;
    report.nextCursor = nextCursor;
    if (body.as_of_block !== undefined && !opts.dryRun) {
      setCheckpointRaw(AS_OF_BLOCK_KEY, String(body.as_of_block));
    }

    if (items.length === 0) {
      report.stoppedReason = "no_more_items";
      break;
    }

    for (const item of items) {
      report.itemsSeen++;

      if (item.minted_by && item.minted_by.length > 0) {
        report.mintedSkipped++;
        continue;
      }

      let burnGwei: bigint;
      try {
        burnGwei = BigInt(String(item.burn));
      } catch {
        report.errors++;
        continue;
      }

      const burnEth = burnGweiToEth(burnGwei);
      if (burnEth < opts.minEth) {
        report.belowMin++;
        if (opts.stopBelowMin) {
          report.stoppedReason = "below_min_eth";
          break;
        }
        continue;
      }

      const tierEth = tierForBurn(burnEth, opts.minEth);
      report.imported++;

      if (!opts.dryRun) {
        upsertHighBurnCandidate({
          block: item.blk,
          burnGwei,
          burnEth,
          tierEth,
        });
      }
    }

    if (!opts.dryRun) {
      if (nextCursor) setCheckpointRaw(CURSOR_KEY, nextCursor);
      setCheckpointRaw(LAST_MIN_ETH_KEY, String(opts.minEth));
    }

    cursor = nextCursor;
    if (!cursor) {
      report.stoppedReason = "no_next_cursor";
      break;
    }
    if (report.stoppedReason) break;
    await sleep(opts.sleepMs);
  }

  if (!report.stoppedReason) report.stoppedReason = "page_limit_reached";
  console.log("\n=== Import Report ===");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(`Fatal error: ${String(err)}`);
  process.exit(1);
});
