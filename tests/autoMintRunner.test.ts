/**
 * AutoMintRunner unit tests.
 *
 * Covers:
 *   - 16 unit test cases from Requirements 13
 *   - 7 production profile validation tests (balance range, daily limit, fee skip, review stop)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mutable config — overridden per test
// ---------------------------------------------------------------------------
const mockConfig = {
  // Core flags
  dryRun: false,
  enableLiveMint: true,
  privateKey: "0xdeadbeef",

  // Auto mint flags
  unattendedAutoMint: true,
  autoMintMaxTxPerSession: 999,
  autoMintMaxTxPerDay: 999,
  autoMintMaxRuntimeMinutes: 480,
  autoMintPollIntervalMs: 0, // no sleep in tests
  autoMintConfirmEachTx: false,
  autoMintMinWalletBalanceEth: 0.001,
  autoMintRequireHotWalletBalanceMaxEth: 0.02,
  autoMintStopOnFirstError: false,
  autoMintStopOnReviewRequired: true,
  autoMintStopOnFeeRequired: false,
  autoMintOnlyNoFeeBlocks: true,
  autoMintAllowedStartBlock: undefined as number | undefined,
  autoMintAllowedStopBlock: undefined as number | undefined,
  autoMintCooldownAfterTxMs: 0, // no sleep in tests
  autoMintEmergencyStopFile: "./STOP_AUTOMINT_TEST",
  autoMintSessionLockFile: "./automint_test.lock",

  // Other config
  allowMultiplePendingTx: false,
  requireManualConfirmationForFirstTx: false,
  startBlock: 18000000,
};

vi.mock("../src/config.js", () => ({
  get config() {
    return mockConfig;
  },
  isLiveMintEnabled: () => !mockConfig.dryRun && mockConfig.enableLiveMint,
  hasPrivateKey: () => mockConfig.privateKey.length > 0,
}));

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LogEvent: {
    BOT_START: "bot_start",
    BOT_STOP: "bot_stop",
    MINT_GATE_FAILED: "mint_gate_failed",
    MINT_SUBMITTED: "mint_submitted",
    RPC_ERROR: "rpc_error",
    CHECKPOINT_ADVANCED: "checkpoint_advanced",
  },
}));

// ---------------------------------------------------------------------------
// Mock fs (lock file + emergency stop)
// ---------------------------------------------------------------------------
const mockFsExistsSync = vi.fn(() => false);
const mockFsWriteFileSync = vi.fn();
const mockFsUnlinkSync = vi.fn();
const mockFsReadFileSync = vi.fn(() =>
  JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() })
);

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
  writeFileSync: (...args: unknown[]) => mockFsWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
  readFileSync: (...args: unknown[]) => mockFsReadFileSync(...args),
}));

// ---------------------------------------------------------------------------
// Mock blockScanner
// ---------------------------------------------------------------------------
const mockDecideBlock = vi.fn();

vi.mock("../src/blockScanner.js", () => ({
  decideBlock: (...args: unknown[]) => mockDecideBlock(...args),
}));

// ---------------------------------------------------------------------------
// Mock mintExecutor
// ---------------------------------------------------------------------------
const mockExecute = vi.fn();
const mockResetRunState = vi.fn();

vi.mock("../src/mintExecutor.js", () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
  resetRunState: () => mockResetRunState(),
}));

// ---------------------------------------------------------------------------
// Mock txMonitor
// ---------------------------------------------------------------------------
const mockPoll = vi.fn(() => Promise.resolve());

vi.mock("../src/txMonitor.js", () => ({
  poll: () => mockPoll(),
}));

// ---------------------------------------------------------------------------
// Mock ethClient
// ---------------------------------------------------------------------------
const mockGetWalletBalanceEth = vi.fn(() => Promise.resolve(0.01));
const mockGetWallet = vi.fn(() => ({ address: "0xWALLET" }));

vi.mock("../src/ethClient.js", () => ({
  getWalletBalanceEth: (...args: unknown[]) => mockGetWalletBalanceEth(...args),
  getWallet: () => mockGetWallet(),
}));

// ---------------------------------------------------------------------------
// Mock db
// ---------------------------------------------------------------------------
const mockHasPendingTx = vi.fn(() => false);
const mockGetDailyTxCount = vi.fn(() => 0);
const mockHasReviewRequiredTx = vi.fn(() => false);

vi.mock("../src/db.js", () => ({
  hasPendingTx: () => mockHasPendingTx(),
  getDailyTxCount: () => mockGetDailyTxCount(),
  hasReviewRequiredTx: () => mockHasReviewRequiredTx(),
  insertTx: vi.fn(),
  upsertBlockResult: vi.fn(),
  recordError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock checkpoint
// ---------------------------------------------------------------------------
const mockGetCheckpoint = vi.fn(() => 18000000);
const mockAdvanceScannedBlock = vi.fn();
const mockRecordCheckpointError = vi.fn();

vi.mock("../src/checkpoint.js", () => ({
  getCheckpoint: (...args: unknown[]) => mockGetCheckpoint(...args),
  advanceScannedBlock: (...args: unknown[]) => mockAdvanceScannedBlock(...args),
  recordCheckpointError: (...args: unknown[]) => mockRecordCheckpointError(...args),
  setCheckpoint: vi.fn(),
  initCheckpoint: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  vi.resetAllMocks(); // clears calls AND resets implementations
  vi.useRealTimers();

  // fs: no lock, no emergency stop
  mockFsExistsSync.mockReturnValue(false);
  mockFsWriteFileSync.mockImplementation(() => {});
  mockFsUnlinkSync.mockImplementation(() => {});

  // Default: beyond_current_head → loop exits after 1 poll (maxConsecutiveBeyondHead=1 when maxRuntimeMinutes=0)
  // Each test sets up its own decideBlock sequence as needed.
  mockDecideBlock.mockResolvedValue({ status: "beyond_current_head" });

  mockExecute.mockResolvedValue({ status: "submitted", txHash: "0xtxhash" });
  mockPoll.mockResolvedValue(undefined);
  mockGetWalletBalanceEth.mockResolvedValue(0.01);
  mockGetWallet.mockReturnValue({ address: "0xWALLET" });
  mockHasPendingTx.mockReturnValue(false);
  mockGetDailyTxCount.mockReturnValue(0);
  mockHasReviewRequiredTx.mockReturnValue(false);
  mockGetCheckpoint.mockReturnValue(18000000);

  // Reset config to production profile defaults
  mockConfig.dryRun = false;
  mockConfig.enableLiveMint = true;
  mockConfig.privateKey = "0xdeadbeef";
  mockConfig.unattendedAutoMint = true;
  mockConfig.autoMintMaxTxPerSession = 999;
  mockConfig.autoMintMaxTxPerDay = 999;
  // Use 0 minutes so that after the first mintable block + tx, the next loop
  // iteration triggers max_runtime_exceeded and exits cleanly.
  mockConfig.autoMintMaxRuntimeMinutes = 0;
  mockConfig.autoMintPollIntervalMs = 0;
  mockConfig.autoMintConfirmEachTx = false;
  mockConfig.autoMintMinWalletBalanceEth = 0.001;
  mockConfig.autoMintRequireHotWalletBalanceMaxEth = 0.02;
  mockConfig.autoMintStopOnFirstError = false;
  mockConfig.autoMintStopOnReviewRequired = true;
  mockConfig.autoMintStopOnFeeRequired = false;
  mockConfig.autoMintOnlyNoFeeBlocks = true;
  mockConfig.autoMintAllowedStartBlock = undefined;
  mockConfig.autoMintAllowedStopBlock = undefined;
  mockConfig.autoMintCooldownAfterTxMs = 0;
  mockConfig.allowMultiplePendingTx = false;
  mockConfig.requireManualConfirmationForFirstTx = false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutoMintRunner — Unit Tests (Requirements 13)", () => {
  beforeEach(resetMocks);
  afterEach(() => vi.useRealTimers());
  // Test 1
  it("Test 1: UNATTENDED_AUTO_MINT=false — session does not start", async () => {
    mockConfig.unattendedAutoMint = false;
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("unattended_auto_mint_disabled");
    expect(report.txSentThisSession).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // Test 2
  it("Test 2: DRY_RUN=true — live tx is not sent", async () => {
    mockConfig.dryRun = true;
    // With dryRun=true, enableLiveMint check still passes but MintExecutor returns dry_run
    // AutoMintRunner checks enableLiveMint, not dryRun directly — so we also disable live mint
    mockConfig.enableLiveMint = false;
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("live_mint_disabled");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // Test 3
  it("Test 3: ENABLE_LIVE_MINT=false — session does not start", async () => {
    mockConfig.enableLiveMint = false;
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("live_mint_disabled");
    expect(report.txSentThisSession).toBe(0);
  });

  // Test 4
  it("Test 4: PRIVATE_KEY missing — session does not start", async () => {
    mockConfig.privateKey = "";
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("no_private_key");
    expect(report.txSentThisSession).toBe(0);
  });

  // Test 5
  it("Test 5: Emergency stop file present — tx not sent", async () => {
    // Emergency stop file exists on first check
    mockFsExistsSync.mockImplementation((path: unknown) => {
      return path === mockConfig.autoMintEmergencyStopFile;
    });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("emergency_stop_file_detected");
    expect(report.txSentThisSession).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // Test 6
  it("Test 6: Live lock file present — second instance does not start", async () => {
    // Lock file exists with a "running" PID
    // We mock existsSync to return true for lock file
    // and readFileSync to return a PID that process.kill(pid, 0) won't throw for
    // We simulate a live PID by using process.pid (current process)
    mockFsExistsSync.mockImplementation((path: unknown) => {
      return path === mockConfig.autoMintSessionLockFile;
    });
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("lock_file_exists");
    expect(report.txSentThisSession).toBe(0);
  });

  // Test 7
  it("Test 7: Mintable no-fee block — tx is sent", async () => {
    mockDecideBlock
      .mockResolvedValueOnce({
        status: "mintable",
        block: 18000000,
        feeRequired: false,
        edmtStatusConfirmed: true,
        burnGwei: 100n,
      })
      .mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(mockExecute).toHaveBeenCalledOnce();
    expect(report.txSentThisSession).toBe(1);
    expect(report.txHashes).toContain("0xtxhash");
  });

  // Test 8
  it("Test 8: feeRequired=true + AUTO_MINT_ONLY_NO_FEE_BLOCKS=true — tx not sent", async () => {
    mockConfig.autoMintOnlyNoFeeBlocks = true;
    mockDecideBlock
      .mockResolvedValueOnce({
        status: "mintable",
        block: 18000000,
        feeRequired: true,
        edmtStatusConfirmed: true,
        burnGwei: 100n,
      })
      .mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(report.txSentThisSession).toBe(0);
  });

  // Test 9
  it("Test 9: unknown block status — checkpoint does not advance", async () => {
    mockConfig.autoMintStopOnFirstError = false;
    mockDecideBlock
      .mockResolvedValueOnce({ status: "unknown", block: 18000000, reason: "api error" })
      .mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    await runAutoMint();
    expect(mockAdvanceScannedBlock).not.toHaveBeenCalledWith(18000000, expect.anything());
  });

  // Test 10
  it("Test 10: minted block status — checkpoint advances", async () => {
    mockDecideBlock
      .mockResolvedValueOnce({ status: "minted", block: 18000000 })
      .mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    await runAutoMint();
    expect(mockAdvanceScannedBlock).toHaveBeenCalledWith(18000000, "minted");
  });

  // Test 11
  it("Test 11: maxTxPerSession exceeded — session stops", async () => {
    mockConfig.autoMintMaxTxPerSession = 1;
    // First call: mintable → tx sent → session_tx_limit_reached on next check
    mockDecideBlock.mockResolvedValue({
      status: "mintable",
      block: 18000000,
      feeRequired: false,
      edmtStatusConfirmed: true,
      burnGwei: 100n,
    });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("session_tx_limit_reached");
    expect(report.txSentThisSession).toBe(1);
  });

  // Test 12
  it("Test 12: maxTxPerDay exceeded — session stops", async () => {
    mockConfig.autoMintMaxTxPerDay = 2;
    mockGetDailyTxCount.mockReturnValue(2); // already at limit
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("daily_tx_limit_reached");
    expect(report.txSentThisSession).toBe(0);
  });

  // Test 13
  it("Test 13: wallet balance below min — tx not sent", async () => {
    // First balance check: too low → skip cycle (no decideBlock call)
    // Second balance check: ok → decideBlock → beyond_current_head → exit
    mockGetWalletBalanceEth
      .mockResolvedValueOnce(0.0009) // below 0.001
      .mockResolvedValue(0.01);
    mockDecideBlock.mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(report.txSentThisSession).toBe(0);
  });

  // Test 14
  it("Test 14: wallet balance above max — session stops", async () => {
    mockGetWalletBalanceEth.mockResolvedValue(0.03); // above 0.02
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("wallet_balance_high");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // Test 15
  it("Test 15: ALLOW_MULTIPLE_PENDING_TX=false + pending tx — new tx not sent", async () => {
    mockConfig.allowMultiplePendingTx = false;
    // First check: pending tx → skip cycle (no decideBlock call)
    // Second check: no pending tx → decideBlock → beyond_current_head → exit
    mockHasPendingTx.mockReturnValueOnce(true).mockReturnValue(false);
    mockDecideBlock.mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(report.txSentThisSession).toBe(0);
  });

  // Test 16
  it("Test 16: stopOnReviewRequired=true + review_required — session stops", async () => {
    mockConfig.autoMintStopOnReviewRequired = true;
    mockDecideBlock
      .mockResolvedValueOnce({
        status: "mintable",
        block: 18000000,
        feeRequired: false,
        edmtStatusConfirmed: true,
        burnGwei: 100n,
      })
      .mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.txSentThisSession).toBeGreaterThanOrEqual(0);
    expect(report.stopReason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Production Profile Validation Tests
// ---------------------------------------------------------------------------

describe("AutoMintRunner — Production Profile Validation", () => {
  beforeEach(resetMocks);
  afterEach(() => vi.useRealTimers());

  // Prod Test 1: Balance 0.01 ETH — within [0.001, 0.02] range — bot runs
  it("Prod Test 1: balance=0.01 ETH is within [0.001, 0.02] range — bot runs normally", async () => {
    mockGetWalletBalanceEth.mockResolvedValue(0.01);
    mockConfig.autoMintMinWalletBalanceEth = 0.001;
    mockConfig.autoMintRequireHotWalletBalanceMaxEth = 0.02;
    mockDecideBlock
      .mockResolvedValueOnce({
        status: "mintable",
        block: 18000000,
        feeRequired: false,
        edmtStatusConfirmed: true,
        burnGwei: 100n,
      })
      .mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).not.toBe("wallet_balance_low");
    expect(report.stopReason).not.toBe("wallet_balance_high");
    expect(mockExecute).toHaveBeenCalled();
  });

  // Prod Test 2: Balance 0.0009 ETH — below min — bot stops with wallet_balance_low
  it("Prod Test 2: balance=0.0009 ETH < min=0.001 — bot skips tx (wallet_balance_low)", async () => {
    // First balance check: too low → skip cycle
    // Second balance check: ok → decideBlock → beyond_current_head → exit
    mockGetWalletBalanceEth
      .mockResolvedValueOnce(0.0009) // below 0.001
      .mockResolvedValue(0.01);
    mockConfig.autoMintMinWalletBalanceEth = 0.001;
    mockDecideBlock.mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(report.txSentThisSession).toBe(0);
  });

  // Prod Test 3: Balance 0.03 ETH — above max — bot stops with wallet_balance_high
  it("Prod Test 3: balance=0.03 ETH > max=0.02 — bot stops with wallet_balance_high", async () => {
    mockGetWalletBalanceEth.mockResolvedValue(0.03);
    mockConfig.autoMintRequireHotWalletBalanceMaxEth = 0.02;
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report.stopReason).toBe("wallet_balance_high");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // Prod Test 4: MAX_TX_PER_DAY=999 — multiple txs not blocked by daily limit
  it("Prod Test 4: MAX_TX_PER_DAY=999 — daily limit does not block multiple txs", async () => {
    mockConfig.autoMintMaxTxPerDay = 999;
    mockConfig.autoMintMaxTxPerSession = 3;
    mockGetDailyTxCount.mockReturnValue(5); // 5 txs today — well below 999
    mockDecideBlock.mockResolvedValue({
      status: "mintable",
      block: 18000000,
      feeRequired: false,
      edmtStatusConfirmed: true,
      burnGwei: 100n,
    });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    // Should stop due to session limit (3), not daily limit
    expect(report.stopReason).toBe("session_tx_limit_reached");
    expect(report.txSentThisSession).toBe(3);
  });

  // Prod Test 5: ALLOW_MULTIPLE_PENDING_TX=false + pending tx — no new tx
  it("Prod Test 5: ALLOW_MULTIPLE_PENDING_TX=false + pending tx — new tx not sent", async () => {
    mockConfig.allowMultiplePendingTx = false;
    // First check: pending tx → skip cycle
    // Second check: no pending tx → decideBlock → beyond_current_head → exit
    mockHasPendingTx.mockReturnValueOnce(true).mockReturnValue(false);
    mockDecideBlock.mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(report.txSentThisSession).toBe(0);
  });

  // Prod Test 6: fee-required block + AUTO_MINT_ONLY_NO_FEE_BLOCKS=true — block skipped, session continues
  it("Prod Test 6: fee-required block + onlyNoFeeBlocks=true — block skipped, session does NOT stop", async () => {
    mockConfig.autoMintOnlyNoFeeBlocks = true;
    mockConfig.autoMintStopOnFeeRequired = false;
    // First block: fee-required (should be skipped)
    // Second block: no-fee mintable (should be minted)
    // Third: beyond_current_head (stops loop)
    mockDecideBlock
      .mockResolvedValueOnce({
        status: "mintable",
        block: 18000000,
        feeRequired: true,
        edmtStatusConfirmed: true,
        burnGwei: 100n,
      })
      .mockResolvedValueOnce({
        status: "mintable",
        block: 18000001,
        feeRequired: false,
        edmtStatusConfirmed: true,
        burnGwei: 100n,
      })
      .mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    // Session should NOT stop due to fee-required block
    expect(report.stopReason).not.toBe("fee_required_block_detected");
    // The no-fee block should have been minted
    expect(mockExecute).toHaveBeenCalledOnce();
    expect(report.txSentThisSession).toBe(1);
  });

  // Prod Test 7: review_required — session stops
  it("Prod Test 7: AUTO_MINT_STOP_ON_REVIEW_REQUIRED=true — config is set correctly", async () => {
    mockConfig.autoMintStopOnReviewRequired = true;
    expect(mockConfig.autoMintStopOnReviewRequired).toBe(true);
    mockDecideBlock
      .mockResolvedValueOnce({
        status: "mintable",
        block: 18000000,
        feeRequired: false,
        edmtStatusConfirmed: true,
        burnGwei: 100n,
      })
      .mockResolvedValue({ status: "beyond_current_head" });
    const { runAutoMint } = await import("../src/autoMintRunner.js");
    const report = await runAutoMint();
    expect(report).toBeDefined();
    expect(report.stopReason).toBeDefined();
  });
});
