/**
 * Structured JSON logger using pino.
 * Sensitive fields (privateKey, PRIVATE_KEY, key, seed, mnemonic) are
 * automatically redacted and will NEVER appear in log output.
 */

import pino from "pino";

const REDACTED_FIELDS = [
  "privateKey",
  "PRIVATE_KEY",
  "private_key",
  "key",
  "seed",
  "mnemonic",
  "secret",
  "password",
  "*.privateKey",
  "*.PRIVATE_KEY",
  "*.private_key",
  "*.key",
  "*.seed",
  "*.mnemonic",
  "*.secret",
  "*.password",
  "config.privateKey",
  "config.PRIVATE_KEY",
];

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: {
    paths: REDACTED_FIELDS,
    censor: "[REDACTED]",
  },
  transport:
    process.env["NODE_ENV"] !== "production" && process.env["LOG_PRETTY"] === "true"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

// ---------------------------------------------------------------------------
// Typed log event helpers — ensures consistent event names across modules
// ---------------------------------------------------------------------------

export const LogEvent = {
  // Block scanning
  BLOCK_DECISION: "block_decision",
  BLOCK_BEYOND_HEAD: "block_beyond_head",
  BLOCK_NOT_ELIGIBLE: "block_not_eligible",
  BLOCK_MINTED: "block_minted",
  BLOCK_MINTABLE: "block_mintable",
  BLOCK_UNKNOWN: "block_unknown",

  // Mint execution
  MINT_DRY_RUN: "mint_dry_run",
  MINT_SUBMITTED: "mint_submitted",
  MINT_SKIPPED: "mint_skipped",
  MINT_GATE_FAILED: "mint_gate_failed",

  // Transaction monitoring
  TX_INCLUDED: "tx_included",
  TX_FAILED: "tx_failed",
  TX_FINALIZED: "tx_finalized",
  TX_REVIEW_REQUIRED: "tx_review_required",
  TX_REORG_SUSPECTED: "tx_reorg_suspected",

  // Checkpoint
  CHECKPOINT_ADVANCED: "checkpoint_advanced",
  CHECKPOINT_HELD: "checkpoint_held",

  // API / RPC
  API_RETRY: "api_retry",
  API_FALLBACK: "api_fallback",
  API_UNAVAILABLE: "api_unavailable",
  RPC_RETRY: "rpc_retry",
  RPC_ERROR: "rpc_error",

  // Database
  DB_ERROR: "db_error",
  DB_WRITE: "db_write",

  // System
  BOT_START: "bot_start",
  BOT_STOP: "bot_stop",
  CONFIG_LOADED: "config_loaded",

  // Pipeline mode
  PIPELINE_MODE_ENABLED: "pipeline_mode_enabled",
  PIPELINE_TX_SPACING_WAIT: "pipeline_tx_spacing_wait",
  PIPELINE_PENDING_CAPACITY_AVAILABLE: "pipeline_pending_capacity_available",
  PIPELINE_PENDING_CAPACITY_FULL: "pipeline_pending_capacity_full",
  PIPELINE_TX_SUBMITTED: "pipeline_tx_submitted",
  PIPELINE_MONITOR_POLL: "pipeline_monitor_poll",
  PIPELINE_FINALIZED_RECONCILED: "pipeline_finalized_reconciled",
  PIPELINE_NONCE_ANOMALY: "pipeline_nonce_anomaly",
  PIPELINE_DUPLICATE_PREVENTED: "pipeline_duplicate_prevented",
  // Pipeline nonce state
  PIPELINE_NONCE_STATE_CHECK: "pipeline_nonce_state_check",
  PIPELINE_NONCE_STATE_RECONCILED: "pipeline_nonce_state_reconciled",
  PIPELINE_NONCE_STATE_MISMATCH: "pipeline_nonce_state_mismatch",

  // High Burn Priority Mode
  HIGH_BURN_MODE_ENABLED: "high_burn_mode_enabled",
  HIGH_BURN_CANDIDATE_DISCOVERED: "high_burn_candidate_discovered",
  HIGH_BURN_CANDIDATE_CACHED: "high_burn_candidate_cached",
  HIGH_BURN_CANDIDATE_SELECTED: "high_burn_candidate_selected",
  HIGH_BURN_CANDIDATE_MINTED_ELSEWHERE: "high_burn_candidate_minted_elsewhere",
  HIGH_BURN_CANDIDATE_SUBMITTED: "high_burn_candidate_submitted",
  HIGH_BURN_CANDIDATE_FINALIZED: "high_burn_candidate_finalized",
  HIGH_BURN_TIER_STARTED: "high_burn_tier_started",
  HIGH_BURN_TIER_EXHAUSTED: "high_burn_tier_exhausted",
  HIGH_BURN_TIER_DOWNGRADED: "high_burn_tier_downgraded",
  HIGH_BURN_ALL_TIERS_EXHAUSTED: "high_burn_all_tiers_exhausted",
  HIGH_BURN_CACHE_HIT: "high_burn_cache_hit",
  HIGH_BURN_SKIP_SEEN: "high_burn_skip_seen",
} as const;

export type LogEventName = (typeof LogEvent)[keyof typeof LogEvent];
