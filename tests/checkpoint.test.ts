/**
 * Checkpoint unit tests.
 * Uses an in-memory SQLite database to avoid touching the filesystem.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock config so tests don't need a real .env
// ---------------------------------------------------------------------------
vi.mock("../src/config.js", () => ({
  config: {
    startBlock: 12965000,
    sqlitePath: ":memory:",
    dryRun: true,
    enableLiveMint: false,
    privateKey: "",
    rpcUrl: "http://localhost:8545",
    scanDirection: "ascending",
    maxBlocksPerRun: 1000,
    maxTxPerRun: 1,
    pollIntervalMs: 3000,
    apiRetryLimit: 5,
    rpcRetryLimit: 5,
    maxGasGwei: 80,
    maxPriorityFeeGwei: 3,
    maxCaptureFeeGwei: BigInt(1_000_000_000),
    minBurnGwei: BigInt(1),
    requireManualConfirmationForFirstTx: true,
    finalityConfirmations: 64,
    beyondHeadBehavior: "wait",
    allowMultiplePendingTx: false,
    edmtBaseUrl: "https://www.edmt.io",
    edmtApiBaseUrl: "https://www.edmt.io/api/v1",
    stopBlock: undefined,
  },
  isLiveMintEnabled: () => false,
  hasPrivateKey: () => false,
}));

// ---------------------------------------------------------------------------
// Mock logger to suppress output during tests
// ---------------------------------------------------------------------------
vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LogEvent: {
    CHECKPOINT_ADVANCED: "checkpoint_advanced",
    CHECKPOINT_HELD: "checkpoint_held",
    DB_ERROR: "db_error",
    DB_WRITE: "db_write",
  },
}));

// ---------------------------------------------------------------------------
// Use in-memory DB for each test
// ---------------------------------------------------------------------------
import Database from "better-sqlite3";

let memDb: Database.Database;

vi.mock("../src/db.js", async () => {
  // We'll set memDb in beforeEach and expose helpers that use it
  const mod = await vi.importActual<typeof import("../src/db.js")>("../src/db.js");
  return {
    ...mod,
    getDb: () => memDb,
    getCheckpointRaw: (key: string) => {
      const row = memDb.prepare("SELECT value FROM checkpoints WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    },
    setCheckpointRaw: (key: string, value: string) => {
      memDb
        .prepare(
          `INSERT INTO checkpoints (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(key, value, new Date().toISOString());
    },
    recordError: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helper: create fresh in-memory DB with schema
// ---------------------------------------------------------------------------
function createMemDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block INTEGER,
      stage TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Checkpoint Manager", () => {
  beforeEach(() => {
    memDb = createMemDb();
    vi.resetModules();
  });

  // Test 7: minted status advances checkpoint by 1
  it("Test 7: minted status advances checkpoint to block + 1", async () => {
    const { advanceScannedBlock } = await import("../src/checkpoint.js");

    // Seed initial checkpoint
    memDb
      .prepare(
        `INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_scanned_block', '18000000', ?)`
      )
      .run(new Date().toISOString());

    advanceScannedBlock(18000000, "minted");

    const row = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_scanned_block'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("18000001");
  });

  // Test 7b: not_eligible also advances checkpoint
  it("not_eligible status advances checkpoint to block + 1", async () => {
    const { advanceScannedBlock } = await import("../src/checkpoint.js");

    memDb
      .prepare(
        `INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_scanned_block', '13000000', ?)`
      )
      .run(new Date().toISOString());

    advanceScannedBlock(13000000, "not_eligible");

    const row = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_scanned_block'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("13000001");
  });

  // Test 7c: successful_mint advances checkpoint
  it("successful_mint advances checkpoint to block + 1", async () => {
    const { advanceScannedBlock } = await import("../src/checkpoint.js");

    memDb
      .prepare(
        `INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_scanned_block', '18500000', ?)`
      )
      .run(new Date().toISOString());

    advanceScannedBlock(18500000, "successful_mint");

    const row = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_scanned_block'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("18500001");
  });

  // Test 8: unknown status does NOT advance checkpoint
  it("Test 8: unknown API error does NOT advance checkpoint", async () => {
    const { advanceScannedBlock } = await import("../src/checkpoint.js");

    memDb
      .prepare(
        `INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_scanned_block', '18000000', ?)`
      )
      .run(new Date().toISOString());

    advanceScannedBlock(18000000, "unknown");

    const row = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_scanned_block'")
      .get() as { value: string } | undefined;

    // Should remain at 18000000 — NOT advanced
    expect(row?.value).toBe("18000000");
  });

  // beyond_current_head does NOT advance checkpoint
  it("beyond_current_head does NOT advance checkpoint", async () => {
    const { advanceScannedBlock } = await import("../src/checkpoint.js");

    memDb
      .prepare(
        `INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_scanned_block', '99999999', ?)`
      )
      .run(new Date().toISOString());

    advanceScannedBlock(99999999, "beyond_current_head");

    const row = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_scanned_block'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("99999999");
  });

  // initCheckpoint seeds START_BLOCK when no checkpoint exists
  it("initCheckpoint seeds START_BLOCK when no checkpoint exists", async () => {
    const { initCheckpoint } = await import("../src/checkpoint.js");

    const result = initCheckpoint();
    expect(result).toBe(12965000);

    const row = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_scanned_block'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("12965000");
  });

  // initCheckpoint preserves existing checkpoint
  it("initCheckpoint preserves existing checkpoint value", async () => {
    const { initCheckpoint } = await import("../src/checkpoint.js");

    memDb
      .prepare(
        `INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_scanned_block', '15000000', ?)`
      )
      .run(new Date().toISOString());

    const result = initCheckpoint();
    expect(result).toBe(15000000);
  });

  // setSubmittedBlock writes last_submitted_block
  it("setSubmittedBlock writes last_submitted_block", async () => {
    const { setSubmittedBlock } = await import("../src/checkpoint.js");

    setSubmittedBlock(18765432);

    const row = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_submitted_block'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("18765432");
  });

  // setSuccessfulMintBlock writes last_successful_mint_block and advances scanner
  it("setSuccessfulMintBlock writes last_successful_mint_block and advances scanner", async () => {
    const { setSuccessfulMintBlock } = await import("../src/checkpoint.js");

    memDb
      .prepare(
        `INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_scanned_block', '18765432', ?)`
      )
      .run(new Date().toISOString());

    setSuccessfulMintBlock(18765432);

    const mintRow = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_successful_mint_block'")
      .get() as { value: string } | undefined;

    const scanRow = memDb
      .prepare("SELECT value FROM checkpoints WHERE key = 'last_scanned_block'")
      .get() as { value: string } | undefined;

    expect(mintRow?.value).toBe("18765432");
    expect(scanRow?.value).toBe("18765433");
  });
});
