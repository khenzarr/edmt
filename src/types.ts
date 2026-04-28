/**
 * Core type definitions for the EDMT/eNAT Mint Bot.
 * All domain types, enums, and interfaces are defined here.
 */

// ---------------------------------------------------------------------------
// Block status — returned by EdmtClient.getBlockStatus()
// ---------------------------------------------------------------------------

export type BlockStatus =
  | "mintable"
  | "minted"
  | "beyond_current_head"
  | "not_eligible"
  | "unknown";

// ---------------------------------------------------------------------------
// Transaction lifecycle status
// ---------------------------------------------------------------------------

export type TxStatus = "pending" | "included" | "failed" | "finalized" | "review_required";

// ---------------------------------------------------------------------------
// Block lifecycle (extended, used in block_results table)
// ---------------------------------------------------------------------------

export type BlockLifecycleStatus =
  | "unknown"
  | "beyond_current_head"
  | "not_eligible"
  | "minted"
  | "mintable"
  | "submitted"
  | "included"
  | "finalized"
  | "successful_mint"
  | "review_required"
  | "failed";

// ---------------------------------------------------------------------------
// Beyond-head behaviour enum
// ---------------------------------------------------------------------------

export type BeyondHeadBehavior = "wait" | "skip" | "stop";

// ---------------------------------------------------------------------------
// Checkpoint keys stored in the checkpoints table
// ---------------------------------------------------------------------------

export type CheckpointKey =
  | "last_scanned_block"
  | "last_submitted_block"
  | "last_successful_mint_block"
  | "last_finalized_tx";

// ---------------------------------------------------------------------------
// Block result — returned by EdmtClient.getBlockStatus()
// ---------------------------------------------------------------------------

export interface BlockResult {
  block: number;
  status: BlockStatus;
  burnGwei?: bigint;
  owner?: string;
  mintTx?: string;
  feeRequired?: boolean;
  requiredFeeGwei?: bigint;
  /** Human-readable reason for the status decision */
  reason?: string;
  /** Whether the status was confirmed via EDMT block-specific API */
  edmtStatusConfirmed?: boolean;
}

// ---------------------------------------------------------------------------
// Transaction record — stored in txs table
// ---------------------------------------------------------------------------

export interface TxRecord {
  id?: number;
  block: number;
  txHash: string;
  status: TxStatus;
  nonce: number;
  gasInfo: GasInfo;
  submittedAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Gas info — serialised to JSON in txs.gas_info column
// ---------------------------------------------------------------------------

export interface GasInfo {
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gasLimit?: string;
}

// ---------------------------------------------------------------------------
// Mint execution result
// ---------------------------------------------------------------------------

export type MintResultStatus =
  | "dry_run"
  | "submitted"
  | "skipped_dry_run"
  | "skipped_live_mint_disabled"
  | "skipped_no_private_key"
  | "skipped_duplicate_tx"
  | "skipped_pending_tx"
  | "skipped_fee_exceeds_max"
  | "skipped_gas_exceeds_max"
  | "skipped_tx_run_limit"
  | "skipped_fee_quote_unavailable"
  | "skipped_edmt_status_unconfirmed"
  | "error";

export interface MintResult {
  block: number;
  status: MintResultStatus;
  txHash?: string;
  payload?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Error record — stored in errors table
// ---------------------------------------------------------------------------

export interface ErrorRecord {
  id?: number;
  block?: number;
  stage: string;
  message: string;
  stack?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Scan batch result
// ---------------------------------------------------------------------------

export interface ScanBatchResult {
  processed: number;
  mintable: number;
  minted: number;
  notEligible: number;
  beyondHead: number;
  unknown: number;
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// Unattended Auto Mint — StopReason and AutoMintReport
// ---------------------------------------------------------------------------

export type StopReason =
  | "unattended_auto_mint_disabled"
  | "live_mint_disabled"
  | "no_private_key"
  | "lock_file_exists"
  | "session_tx_limit_reached"
  | "daily_tx_limit_reached"
  | "max_runtime_exceeded"
  | "emergency_stop_file_detected"
  | "fee_required_block_detected"
  | "review_required_detected"
  | "allowed_stop_block_reached"
  | "first_error_stop"
  | "wallet_balance_low"
  | "wallet_balance_high"
  | "pending_tx_failure_detected"
  | "nonce_anomaly_detected"
  | "high_burn_all_tiers_exhausted"
  | "completed";

export interface AutoMintReport {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  startBlock: number;
  endBlock?: number;
  blocksScanned: number;
  txSentThisSession: number;
  stopReason: StopReason;
  txHashes: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// High Burn Priority Mode
// ---------------------------------------------------------------------------

export type HighBurnCandidateStatus =
  | "discovered"
  | "mintable"
  | "submitted"
  | "finalized"
  | "minted_elsewhere"
  | "not_eligible"
  | "fee_required_skipped"
  | "unknown"
  | "review_required"
  | "skipped";

export interface HighBurnCandidate {
  block: number;
  burnGwei: bigint;
  burnEth: number;
  tierEth: number;
  status: HighBurnCandidateStatus;
  edmt_status: string | null;
  minted_by: string | null;
  mint_tx_hash: string | null;
  fee_required: boolean | null;
  seen_at: string;
  updated_at: string;
  attempts: number;
  last_attempt_at: string | null;
  skip_reason: string | null;
}

/** Raw DB row from high_burn_candidates table */
export interface HighBurnCandidateRow {
  block: number;
  burn_gwei: string;
  burn_eth: number;
  tier_eth: number;
  status: string;
  edmt_status: string | null;
  minted_by: string | null;
  mint_tx_hash: string | null;
  fee_required: number | null;
  seen_at: string;
  updated_at: string;
  attempts: number;
  last_attempt_at: string | null;
  skip_reason: string | null;
}
