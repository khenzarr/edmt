/**
 * Configuration loader.
 * Reads all environment variables, validates them, and exports a typed config.
 * PRIVATE_KEY is NEVER logged, printed, or included in error messages.
 */

import "dotenv/config";
import type { BeyondHeadBehavior } from "./types.js";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val.trim();
}

function optionalEnv(name: string, defaultValue: string): string {
  const val = process.env[name];
  return val && val.trim() !== "" ? val.trim() : defaultValue;
}

function parseIntEnv(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const parsed = parseInt(val.trim(), 10);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid integer for ${name}: "${val}"`);
  }
  return parsed;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const lower = val.trim().toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  throw new Error(`Invalid boolean for ${name}: "${val}". Use true or false.`);
}

function parseFloatEnv(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const parsed = parseFloat(val.trim());
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid float for ${name}: "${val}"`);
  }
  return parsed;
}

function parseBeyondHeadBehavior(raw: string): BeyondHeadBehavior {
  if (raw === "wait" || raw === "skip" || raw === "stop") return raw;
  throw new Error(`Invalid BEYOND_HEAD_BEHAVIOR: "${raw}". Must be wait, skip, or stop.`);
}

function parseFloatArrayEnv(name: string, defaultValue: number[]): number[] {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const parts = val
    .trim()
    .split(",")
    .map((s) => s.trim());
  const parsed = parts.map((s) => {
    const n = parseFloat(s);
    if (isNaN(n) || n < 0) throw new Error(`Invalid float in ${name}: "${s}"`);
    return n;
  });
  return parsed.sort((a, b) => b - a); // always descending
}

function parseHighBurnOnExhausted(raw: string): "wait" | "fallback_sequential" | "stop" {
  if (raw === "wait" || raw === "fallback_sequential" || raw === "stop") return raw;
  throw new Error(
    `Invalid HIGH_BURN_ON_EXHAUSTED: "${raw}". Must be wait, fallback_sequential, or stop.`
  );
}

// ---------------------------------------------------------------------------
// Exported config object
// ---------------------------------------------------------------------------

export const config = {
  // RPC
  rpcUrl: requireEnv("RPC_URL"),

  // Wallet — key is read but NEVER exposed in logs or errors
  privateKey: process.env["PRIVATE_KEY"] ?? "",

  // Safety flags
  dryRun: parseBoolEnv("DRY_RUN", true),
  enableLiveMint: parseBoolEnv("ENABLE_LIVE_MINT", false),

  // Scan range
  startBlock: parseIntEnv("START_BLOCK", 12965000),
  stopBlock: process.env["STOP_BLOCK"] ? parseIntEnv("STOP_BLOCK", 0) : undefined,
  scanDirection: optionalEnv("SCAN_DIRECTION", "ascending") as "ascending" | "descending",

  // Run limits
  maxBlocksPerRun: parseIntEnv("MAX_BLOCKS_PER_RUN", 1000),
  maxTxPerRun: parseIntEnv("MAX_TX_PER_RUN", 1),

  // Timing
  pollIntervalMs: parseIntEnv("POLL_INTERVAL_MS", 3000),

  // Retry limits
  apiRetryLimit: parseIntEnv("API_RETRY_LIMIT", 5),
  rpcRetryLimit: parseIntEnv("RPC_RETRY_LIMIT", 5),

  // Gas limits (Gwei)
  maxGasGwei: parseIntEnv("MAX_GAS_GWEI", 80),
  maxPriorityFeeGwei: parseIntEnv("MAX_PRIORITY_FEE_GWEI", 3),

  // Capture fee limit (Gwei)
  maxCaptureFeeGwei: BigInt(parseIntEnv("MAX_CAPTURE_FEE_GWEI", 1_000_000_000)),

  // Burn eligibility
  minBurnGwei: BigInt(parseIntEnv("MIN_BURN_GWEI", 1)),

  // Safety confirmations
  requireManualConfirmationForFirstTx: parseBoolEnv(
    "REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX",
    true
  ),
  finalityConfirmations: parseIntEnv("FINALITY_CONFIRMATIONS", 64),
  beyondHeadBehavior: parseBeyondHeadBehavior(optionalEnv("BEYOND_HEAD_BEHAVIOR", "wait")),
  allowMultiplePendingTx: parseBoolEnv("ALLOW_MULTIPLE_PENDING_TX", false),

  // Database
  sqlitePath: optionalEnv("SQLITE_PATH", "./edmt-bot.sqlite"),

  // EDMT API
  edmtBaseUrl: optionalEnv("EDMT_BASE_URL", "https://www.edmt.io"),
  edmtApiBaseUrl: optionalEnv("EDMT_API_BASE_URL", "https://www.edmt.io/api/v1"),

  // ---------------------------------------------------------------------------
  // Unattended Auto Mint
  // ---------------------------------------------------------------------------
  unattendedAutoMint: parseBoolEnv("UNATTENDED_AUTO_MINT", false),
  autoMintMaxTxPerSession: parseIntEnv("AUTO_MINT_MAX_TX_PER_SESSION", 999),
  autoMintMaxTxPerDay: parseIntEnv("AUTO_MINT_MAX_TX_PER_DAY", 999),
  autoMintMaxRuntimeMinutes: parseIntEnv("AUTO_MINT_MAX_RUNTIME_MINUTES", 480),
  autoMintPollIntervalMs: parseIntEnv("AUTO_MINT_POLL_INTERVAL_MS", 12000),
  autoMintConfirmEachTx: parseBoolEnv("AUTO_MINT_CONFIRM_EACH_TX", false),
  autoMintRequireHotWalletBalanceMaxEth: parseFloatEnv(
    "AUTO_MINT_REQUIRE_HOT_WALLET_BALANCE_MAX_ETH",
    0.02
  ),
  autoMintMinWalletBalanceEth: parseFloatEnv("AUTO_MINT_MIN_WALLET_BALANCE_ETH", 0.001),
  autoMintStopOnFirstError: parseBoolEnv("AUTO_MINT_STOP_ON_FIRST_ERROR", false),
  autoMintStopOnReviewRequired: parseBoolEnv("AUTO_MINT_STOP_ON_REVIEW_REQUIRED", true),
  autoMintStopOnFeeRequired: parseBoolEnv("AUTO_MINT_STOP_ON_FEE_REQUIRED", false),
  autoMintOnlyNoFeeBlocks: parseBoolEnv("AUTO_MINT_ONLY_NO_FEE_BLOCKS", true),
  autoMintAllowedStartBlock: process.env["AUTO_MINT_ALLOWED_START_BLOCK"]
    ? parseIntEnv("AUTO_MINT_ALLOWED_START_BLOCK", 0)
    : undefined,
  autoMintAllowedStopBlock: process.env["AUTO_MINT_ALLOWED_STOP_BLOCK"]
    ? parseIntEnv("AUTO_MINT_ALLOWED_STOP_BLOCK", 0)
    : undefined,
  autoMintCooldownAfterTxMs: parseIntEnv("AUTO_MINT_COOLDOWN_AFTER_TX_MS", 60000),
  autoMintEmergencyStopFile: optionalEnv("AUTO_MINT_EMERGENCY_STOP_FILE", "./STOP_AUTOMINT"),
  autoMintSessionLockFile: optionalEnv("AUTO_MINT_SESSION_LOCK_FILE", "./automint.lock"),

  // ---------------------------------------------------------------------------
  // Pipeline Auto Mint Mode
  // ---------------------------------------------------------------------------
  autoMintPipelineMode: parseBoolEnv("AUTO_MINT_PIPELINE_MODE", false),
  autoMintMaxPendingTxs: parseIntEnv("AUTO_MINT_MAX_PENDING_TXS", 3),
  autoMintMaxUnfinalizedTxs: parseIntEnv("AUTO_MINT_MAX_UNFINALIZED_TXS", 10),
  autoMintTxSpacingMs: parseIntEnv("AUTO_MINT_TX_SPACING_MS", 30000),
  autoMintStopOnPendingTxFailure: parseBoolEnv("AUTO_MINT_STOP_ON_PENDING_TX_FAILURE", true),
  autoMintReconcileIntervalMs: parseIntEnv("AUTO_MINT_RECONCILE_INTERVAL_MS", 12000),
  autoMintRequireIncludedBeforeNextTx: parseBoolEnv(
    "AUTO_MINT_REQUIRE_INCLUDED_BEFORE_NEXT_TX",
    false
  ),

  // ---------------------------------------------------------------------------
  // Review Required Reconciliation
  // ---------------------------------------------------------------------------
  autoReconcileReviewRequired: parseBoolEnv("AUTO_RECONCILE_REVIEW_REQUIRED", false),
  reconcileRequireFinality: parseBoolEnv("RECONCILE_REQUIRE_FINALITY", true),
  reconcileMinConfirmations: parseIntEnv("RECONCILE_MIN_CONFIRMATIONS", 64),

  // ---------------------------------------------------------------------------
  // High Burn Priority Mode
  // ---------------------------------------------------------------------------
  highBurnPriorityMode: parseBoolEnv("HIGH_BURN_PRIORITY_MODE", false),
  highBurnScanStartBlock: parseIntEnv("HIGH_BURN_SCAN_START_BLOCK", 12965000),
  highBurnScanEndBlock: process.env["HIGH_BURN_SCAN_END_BLOCK"]
    ? parseIntEnv("HIGH_BURN_SCAN_END_BLOCK", 0)
    : undefined,
  highBurnMinEthTiers: parseFloatArrayEnv(
    "HIGH_BURN_MIN_ETH_TIERS",
    [100, 90, 50, 20, 10, 5, 4, 3, 2, 1, 0.5, 0.25, 0.1]
  ),
  highBurnActiveTierEth: parseFloatEnv("HIGH_BURN_ACTIVE_TIER_ETH", 4),
  highBurnBatchSize: parseIntEnv("HIGH_BURN_BATCH_SIZE", 1000),
  highBurnMaxCandidatesPerTier: parseIntEnv("HIGH_BURN_MAX_CANDIDATES_PER_TIER", 10000),
  highBurnRescanMinted: parseBoolEnv("HIGH_BURN_RESCAN_MINTED", false),
  highBurnUseCache: parseBoolEnv("HIGH_BURN_USE_CACHE", true),
  highBurnCacheTtlHours: parseFloatEnv("HIGH_BURN_CACHE_TTL_HOURS", 168),
  highBurnSort: optionalEnv("HIGH_BURN_SORT", "desc") as "asc" | "desc",
  highBurnOnlyMintable: parseBoolEnv("HIGH_BURN_ONLY_MINTABLE", true),
  highBurnOnlyNoFee: parseBoolEnv("HIGH_BURN_ONLY_NO_FEE", true),
  highBurnSkipAlreadySeen: parseBoolEnv("HIGH_BURN_SKIP_ALREADY_SEEN", true),
  highBurnOnExhausted: parseHighBurnOnExhausted(
    optionalEnv("HIGH_BURN_ON_EXHAUSTED", "fallback_sequential")
  ),
  highBurnUnknownRetryMinutes: parseIntEnv("HIGH_BURN_UNKNOWN_RETRY_MINUTES", 30),
} as const;

export type Config = typeof config;

/**
 * Returns true if the bot is configured for live minting.
 * Both DRY_RUN=false AND ENABLE_LIVE_MINT=true are required.
 */
export function isLiveMintEnabled(): boolean {
  return !config.dryRun && config.enableLiveMint;
}

/**
 * Returns true if a private key is present (without exposing it).
 */
export function hasPrivateKey(): boolean {
  return config.privateKey.length > 0;
}
