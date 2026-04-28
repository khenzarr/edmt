/**
 * SQLite database layer using better-sqlite3 (synchronous API).
 * All tables are created on first run via CREATE TABLE IF NOT EXISTS.
 * DB errors are caught, logged, and written to the errors table where possible.
 */

import Database from "better-sqlite3";
import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import type { ErrorRecord } from "./types.js";

let _db: Database.Database | null = null;

// ---------------------------------------------------------------------------
// Initialise / get singleton DB connection
// ---------------------------------------------------------------------------

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(config.sqlitePath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  createTables(_db);
  logger.info({ event: LogEvent.DB_WRITE, path: config.sqlitePath }, "SQLite database opened");
  return _db;
}

// ---------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS block_results (
      block            INTEGER PRIMARY KEY,
      status           TEXT    NOT NULL,
      burn_gwei        TEXT,
      fee_required     INTEGER,
      required_fee_gwei TEXT,
      owner            TEXT,
      mint_tx          TEXT,
      reason           TEXT,
      updated_at       TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_block_results_status
      ON block_results (status);

    CREATE TABLE IF NOT EXISTS txs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      block        INTEGER NOT NULL,
      tx_hash      TEXT    UNIQUE NOT NULL,
      status       TEXT    NOT NULL,
      nonce        INTEGER NOT NULL,
      gas_info     TEXT    NOT NULL,
      submitted_at TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_txs_block
      ON txs (block);

    CREATE INDEX IF NOT EXISTS idx_txs_status
      ON txs (status);

    CREATE TABLE IF NOT EXISTS errors (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      block      INTEGER,
      stage      TEXT    NOT NULL,
      message    TEXT    NOT NULL,
      stack      TEXT,
      created_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_errors_block
      ON errors (block);

    CREATE TABLE IF NOT EXISTS high_burn_candidates (
      block           INTEGER PRIMARY KEY,
      burn_gwei       TEXT    NOT NULL,
      burn_eth        REAL    NOT NULL,
      tier_eth        REAL    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'discovered',
      edmt_status     TEXT,
      minted_by       TEXT,
      mint_tx_hash    TEXT,
      fee_required    INTEGER,
      seen_at         TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      skip_reason     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_hbc_burn_eth
      ON high_burn_candidates (burn_eth DESC);

    CREATE INDEX IF NOT EXISTS idx_hbc_tier_eth
      ON high_burn_candidates (tier_eth);

    CREATE INDEX IF NOT EXISTS idx_hbc_status
      ON high_burn_candidates (status);

    CREATE INDEX IF NOT EXISTS idx_hbc_updated_at
      ON high_burn_candidates (updated_at);
  `);
}

// ---------------------------------------------------------------------------
// Error recording — safe to call even if DB is partially initialised
// ---------------------------------------------------------------------------

export function recordError(record: Omit<ErrorRecord, "id" | "createdAt">): void {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO errors (block, stage, message, stack, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.block ?? null,
      record.stage,
      record.message,
      record.stack ?? null,
      new Date().toISOString()
    );
  } catch (err) {
    // Last-resort: log only — do not throw, never crash the bot
    logger.error(
      { event: LogEvent.DB_ERROR, stage: record.stage, err },
      "Failed to write error record to DB"
    );
  }
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

export function getCheckpointRaw(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare("SELECT value FROM checkpoints WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setCheckpointRaw(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO checkpoints (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `
  ).run(key, value, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Block results helpers
// ---------------------------------------------------------------------------

export function upsertBlockResult(params: {
  block: number;
  status: string;
  burnGwei?: bigint;
  feeRequired?: boolean;
  requiredFeeGwei?: bigint;
  owner?: string;
  mintTx?: string;
  reason?: string;
}): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO block_results
      (block, status, burn_gwei, fee_required, required_fee_gwei, owner, mint_tx, reason, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(block) DO UPDATE SET
      status            = excluded.status,
      burn_gwei         = excluded.burn_gwei,
      fee_required      = excluded.fee_required,
      required_fee_gwei = excluded.required_fee_gwei,
      owner             = excluded.owner,
      mint_tx           = excluded.mint_tx,
      reason            = excluded.reason,
      updated_at        = excluded.updated_at
  `
  ).run(
    params.block,
    params.status,
    params.burnGwei !== undefined ? params.burnGwei.toString() : null,
    params.feeRequired !== undefined ? (params.feeRequired ? 1 : 0) : null,
    params.requiredFeeGwei !== undefined ? params.requiredFeeGwei.toString() : null,
    params.owner ?? null,
    params.mintTx ?? null,
    params.reason ?? null,
    new Date().toISOString()
  );
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

export function insertTx(params: {
  block: number;
  txHash: string;
  status: string;
  nonce: number;
  gasInfo: object;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO txs (block, tx_hash, status, nonce, gas_info, submitted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    params.block,
    params.txHash,
    params.status,
    params.nonce,
    JSON.stringify(params.gasInfo),
    now,
    now
  );
}

export function updateTxStatus(txHash: string, status: string): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE txs SET status = ?, updated_at = ? WHERE tx_hash = ?
  `
  ).run(status, new Date().toISOString(), txHash);
}

export function getTxByBlock(
  block: number
): { tx_hash: string; status: string; nonce: number } | undefined {
  const db = getDb();
  return db
    .prepare("SELECT tx_hash, status, nonce FROM txs WHERE block = ? ORDER BY id DESC LIMIT 1")
    .get(block) as { tx_hash: string; status: string; nonce: number } | undefined;
}

export function getPendingTxs(): Array<{
  id: number;
  block: number;
  tx_hash: string;
  nonce: number;
  gas_info: string;
  submitted_at: string;
  status: string;
}> {
  const db = getDb();
  return db
    .prepare(
      "SELECT id, block, tx_hash, nonce, gas_info, submitted_at, status FROM txs WHERE status IN ('pending', 'included') ORDER BY id ASC"
    )
    .all() as Array<{
    id: number;
    block: number;
    tx_hash: string;
    nonce: number;
    gas_info: string;
    submitted_at: string;
    status: string;
  }>;
}

export function hasPendingTx(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM txs WHERE status IN ('pending', 'included')")
    .get() as {
    cnt: number;
  };
  return row.cnt > 0;
}

export function hasReviewRequiredTx(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'review_required'")
    .get() as { cnt: number };
  return row.cnt > 0;
}

// ---------------------------------------------------------------------------
// Stats helpers (for CLI status command)
// ---------------------------------------------------------------------------

export function getStats(): {
  totalScanned: number;
  totalMinted: number;
  totalFailed: number;
  totalPending: number;
} {
  const db = getDb();
  const scanned = (db.prepare("SELECT COUNT(*) as cnt FROM block_results").get() as { cnt: number })
    .cnt;
  const minted = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM block_results WHERE status IN ('minted','successful_mint')"
      )
      .get() as { cnt: number }
  ).cnt;
  const failed = (
    db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'failed'").get() as { cnt: number }
  ).cnt;
  const pending = (
    db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'pending'").get() as { cnt: number }
  ).cnt;
  return { totalScanned: scanned, totalMinted: minted, totalFailed: failed, totalPending: pending };
}

// ---------------------------------------------------------------------------
// Close DB (for graceful shutdown)
// ---------------------------------------------------------------------------

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Daily tx count (for auto mint session limits)
// ---------------------------------------------------------------------------

/**
 * Count transactions submitted in the last 24 hours.
 * Used by AutoMintRunner to enforce AUTO_MINT_MAX_TX_PER_DAY.
 */
export function getDailyTxCount(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM txs WHERE submitted_at >= datetime('now', '-24 hours')")
    .get() as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Pipeline mode helpers
// ---------------------------------------------------------------------------

/**
 * Count pending transactions (status = 'pending').
 * Used by pipeline mode for capacity control.
 */
export function getPendingTxCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'pending'").get() as {
    cnt: number;
  };
  return row.cnt;
}

/**
 * Count unfinalized transactions (status IN ('pending', 'included')).
 * Used by pipeline mode for capacity control.
 */
export function getUnfinalizedTxCount(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM txs WHERE status IN ('pending', 'included')")
    .get() as { cnt: number };
  return row.cnt;
}

/**
 * Check if a block already has a submitted or beyond status in block_results.
 * Used by pipeline mode for duplicate tx prevention.
 * Returns true if status ∈ {submitted, included, finalized, successful_mint, review_required, failed}.
 */
export function isBlockSubmittedOrBeyond(block: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT status FROM block_results WHERE block = ?").get(block) as
    | { status: string }
    | undefined;
  if (!row) return false;
  const beyondStatuses = new Set([
    "submitted",
    "included",
    "finalized",
    "successful_mint",
    "review_required",
    "failed",
  ]);
  return beyondStatuses.has(row.status);
}

/**
 * Check if any tx has failed status.
 * Used by pipeline mode stop condition checks.
 */
export function hasFailedTx(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'failed'").get() as {
    cnt: number;
  };
  return row.cnt > 0;
}

// ---------------------------------------------------------------------------
// High Burn Priority Mode helpers
// ---------------------------------------------------------------------------

/**
 * Insert or ignore a high burn candidate.
 * Used by BurnIndexer during block indexing.
 */
export function upsertHighBurnCandidate(params: {
  block: number;
  burnGwei: bigint;
  burnEth: number;
  tierEth: number;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO high_burn_candidates
      (block, burn_gwei, burn_eth, tier_eth, status, seen_at, updated_at, attempts)
    VALUES (?, ?, ?, ?, 'discovered', ?, ?, 0)
    ON CONFLICT(block) DO UPDATE SET
      burn_gwei  = excluded.burn_gwei,
      burn_eth   = excluded.burn_eth,
      tier_eth   = excluded.tier_eth,
      updated_at = excluded.updated_at
  `
  ).run(params.block, params.burnGwei.toString(), params.burnEth, params.tierEth, now, now);
}

/**
 * Update high burn candidate status and optional extra fields.
 */
export function updateHighBurnCandidateStatus(
  block: number,
  status: string,
  extra?: {
    edmt_status?: string;
    minted_by?: string;
    mint_tx_hash?: string;
    fee_required?: boolean;
    skip_reason?: string;
    incrementAttempts?: boolean;
  }
): void {
  const db = getDb();
  const now = new Date().toISOString();

  let sql = "UPDATE high_burn_candidates SET status = ?, updated_at = ?";
  const params: unknown[] = [status, now];

  if (extra?.edmt_status !== undefined) {
    sql += ", edmt_status = ?";
    params.push(extra.edmt_status);
  }
  if (extra?.minted_by !== undefined) {
    sql += ", minted_by = ?";
    params.push(extra.minted_by);
  }
  if (extra?.mint_tx_hash !== undefined) {
    sql += ", mint_tx_hash = ?";
    params.push(extra.mint_tx_hash);
  }
  if (extra?.fee_required !== undefined) {
    sql += ", fee_required = ?";
    params.push(extra.fee_required ? 1 : 0);
  }
  if (extra?.skip_reason !== undefined) {
    sql += ", skip_reason = ?";
    params.push(extra.skip_reason);
  }
  if (extra?.incrementAttempts) {
    sql += ", attempts = attempts + 1, last_attempt_at = ?";
    params.push(now);
  }

  sql += " WHERE block = ?";
  params.push(block);

  db.prepare(sql).run(...params);
}

/**
 * Query next high burn candidate for a tier.
 * Returns the highest-burn candidate that meets all criteria, or undefined.
 */
export function queryNextHighBurnCandidate(
  tierEth: number,
  opts: { onlyNoFee: boolean; onlyMintable: boolean; unknownRetryMinutes: number }
):
  | {
      block: number;
      burn_gwei: string;
      burn_eth: number;
      tier_eth: number;
      status: string;
      edmt_status: string | null;
      fee_required: number | null;
      attempts: number;
    }
  | undefined {
  const db = getDb();

  let sql = `
    SELECT hbc.block, hbc.burn_gwei, hbc.burn_eth, hbc.tier_eth, hbc.status,
           hbc.edmt_status, hbc.fee_required, hbc.attempts
    FROM high_burn_candidates hbc
    WHERE hbc.tier_eth = ?
      AND hbc.status NOT IN ('submitted','finalized','minted_elsewhere','skipped','not_eligible','fee_required_skipped')
      AND (hbc.status != 'unknown'
           OR hbc.last_attempt_at IS NULL
           OR (julianday('now') - julianday(hbc.last_attempt_at)) * 1440 >= ?)
      AND NOT EXISTS (
        SELECT 1 FROM txs t
        WHERE t.block = hbc.block
          AND t.status IN ('pending','included','finalized')
      )
      AND NOT EXISTS (
        SELECT 1 FROM block_results br
        WHERE br.block = hbc.block
          AND br.status IN ('submitted','included','finalized','successful_mint')
      )
  `;

  const params: unknown[] = [tierEth, opts.unknownRetryMinutes];

  if (opts.onlyNoFee) {
    sql += " AND (hbc.fee_required IS NULL OR hbc.fee_required = 0)";
  }
  if (opts.onlyMintable) {
    sql += " AND (hbc.edmt_status IS NULL OR hbc.edmt_status = 'mintable')";
  }

  sql += " ORDER BY hbc.attempts ASC, hbc.burn_eth DESC LIMIT 1";

  return db.prepare(sql).get(...params) as
    | {
        block: number;
        burn_gwei: string;
        burn_eth: number;
        tier_eth: number;
        status: string;
        edmt_status: string | null;
        fee_required: number | null;
        attempts: number;
      }
    | undefined;
}

/**
 * Check if a tier is exhausted (all candidates have terminal status).
 */
export function isHighBurnTierExhausted(tierEth: number): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `
    SELECT COUNT(*) as cnt
    FROM high_burn_candidates
    WHERE tier_eth = ?
      AND status NOT IN ('submitted','finalized','minted_elsewhere','skipped','not_eligible','fee_required_skipped')
  `
    )
    .get(tierEth) as { cnt: number };
  return row.cnt === 0;
}

/**
 * Get status summary grouped by tier and status.
 */
export function getHighBurnStatusSummary(): Array<{
  tier_eth: number;
  status: string;
  count: number;
}> {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT tier_eth, status, COUNT(*) as count
    FROM high_burn_candidates
    GROUP BY tier_eth, status
    ORDER BY tier_eth DESC, status ASC
  `
    )
    .all() as Array<{ tier_eth: number; status: string; count: number }>;
}

/**
 * Reset all candidates for a tier to status='discovered'.
 * Returns the number of candidates reset.
 */
export function resetHighBurnTier(tierEth: number): number {
  const db = getDb();
  const result = db
    .prepare(
      `
    UPDATE high_burn_candidates
    SET status = 'discovered', updated_at = ?, attempts = 0, last_attempt_at = NULL
    WHERE tier_eth = ?
  `
    )
    .run(new Date().toISOString(), tierEth);
  return result.changes;
}

/**
 * Count candidates for a tier.
 */
export function countHighBurnCandidatesByTier(tierEth: number): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM high_burn_candidates WHERE tier_eth = ?")
    .get(tierEth) as { cnt: number };
  return row.cnt;
}
