# Requirements Document

## Introduction

The High Burn Priority Mint Mode is an optional operating mode for the EDMT/eNAT Mint Bot that
re-orders the minting queue by Ethereum burn value instead of scanning blocks sequentially from
`last_scanned_block`. When enabled, the Bot indexes a configurable range of blocks, calculates
`burnGwei = floor(baseFeePerGas × gasUsed / 1e9)` for each block, stores qualifying candidates in
a dedicated SQLite table, and then selects candidates from the highest-burn tier downward for
minting via the existing pipeline auto-mint infrastructure. All existing safety gates (Gate 1–12)
remain active and unchanged. When the mode is disabled the Bot behaves exactly as before.

---

## Glossary

- **Bot**: The EDMT/eNAT Mint Bot TypeScript/Node.js process.
- **BurnIndexer**: The new module responsible for reading RPC data and populating `high_burn_candidates`.
- **CandidateSelector**: The new module responsible for selecting the next candidate to mint (`getNextHighBurnCandidate()`).
- **TierManager**: The logic that tracks which burn-ETH tier is currently active and handles tier exhaustion and downgrade.
- **HighBurnRunner**: The new session-level orchestrator that replaces `AutoMintRunner`'s sequential scan loop when `HIGH_BURN_PRIORITY_MODE=true`.
- **Pipeline**: The existing `AUTO_MINT_PIPELINE_MODE` infrastructure in `autoMintRunner.ts` / `mintExecutor.ts`.
- **burnGwei**: `floor(baseFeePerGas × gasUsed / 1e9)` — the total ETH burned in a block expressed in Gwei, computed using bigint arithmetic.
- **burnEth**: `burnGwei / 1e9` — the same value expressed in ETH (floating-point, used only for tier comparisons and display).
- **Tier**: A minimum-burn-ETH threshold from `HIGH_BURN_MIN_ETH_TIERS`. Candidates are grouped and processed tier by tier from highest to lowest.
- **Active Tier**: The tier currently being processed by TierManager.
- **Candidate**: A row in `high_burn_candidates` representing a block that meets the active tier threshold.
- **Cache**: The `high_burn_candidates` table itself, used to avoid redundant RPC calls when `HIGH_BURN_USE_CACHE=true`.
- **Gate 1–12**: The existing safety checks in `mintExecutor.ts` that must pass before any transaction is sent.
- **EDMT API**: The external API at `EDMT_API_BASE_URL` used to confirm block mintability.
- **EIP-1559**: The Ethereum upgrade at block 12 965 000 that introduced `baseFeePerGas`; blocks before this height are ineligible.

---

## Requirements

### Requirement 1: Mode Activation and Configuration

**User Story:** As a bot operator, I want to enable High Burn Priority Mode via environment
variables, so that I can switch between sequential scanning and burn-priority minting without
changing code.

#### Acceptance Criteria

1. THE Bot SHALL read the environment variable `HIGH_BURN_PRIORITY_MODE` and default to `false` when the variable is absent or empty.
2. WHEN `HIGH_BURN_PRIORITY_MODE=false`, THE Bot SHALL execute the existing sequential/pipeline checkpoint scanning behavior without modification.
3. WHEN `HIGH_BURN_PRIORITY_MODE=true`, THE Bot SHALL activate HighBurnRunner instead of the standard sequential scan loop.
4. THE Bot SHALL read `HIGH_BURN_SCAN_START_BLOCK` as an integer (default `12965000`) and use it as the lower bound of the indexing range.
5. THE Bot SHALL read `HIGH_BURN_SCAN_END_BLOCK` as an optional integer; WHEN the variable is absent or empty, THE Bot SHALL treat the upper bound as unbounded (current chain head).
6. THE Bot SHALL read `HIGH_BURN_MIN_ETH_TIERS` as a comma-separated list of positive numbers (default `100,90,50,20,10,5,4,3,2,1,0.5,0.25,0.1`) and parse them into a descending-sorted array of tier thresholds.
7. THE Bot SHALL read `HIGH_BURN_ACTIVE_TIER_ETH` as a number (default `4`) and use it as the initial active tier on session start.
8. THE Bot SHALL read `HIGH_BURN_BATCH_SIZE` as a positive integer (default `1000`) and use it as the number of blocks fetched per RPC indexing batch.
9. THE Bot SHALL read `HIGH_BURN_MAX_CANDIDATES_PER_TIER` as a positive integer (default `10000`) and use it as the maximum number of candidates stored per tier.
10. THE Bot SHALL read `HIGH_BURN_RESCAN_MINTED` as a boolean (default `false`); WHEN `false`, THE Bot SHALL skip blocks whose `status` in `high_burn_candidates` is `finalized` or `minted_elsewhere`.
11. THE Bot SHALL read `HIGH_BURN_USE_CACHE` as a boolean (default `true`).
12. THE Bot SHALL read `HIGH_BURN_CACHE_TTL_HOURS` as a positive number (default `168`) representing the maximum age in hours of a cached candidate entry before it is considered stale.
13. THE Bot SHALL read `HIGH_BURN_SORT` as either `asc` or `desc` (default `desc`) and use it to order candidates within a tier during selection.
14. THE Bot SHALL read `HIGH_BURN_ONLY_MINTABLE` as a boolean (default `true`); WHEN `true`, THE CandidateSelector SHALL only return candidates whose EDMT status is confirmed mintable.
15. THE Bot SHALL read `HIGH_BURN_ONLY_NO_FEE` as a boolean (default `true`); WHEN `true`, THE CandidateSelector SHALL only return candidates where `fee_required = false`.
16. THE Bot SHALL read `HIGH_BURN_SKIP_ALREADY_SEEN` as a boolean (default `true`).
17. THE Bot SHALL read `HIGH_BURN_ON_EXHAUSTED` as one of `wait`, `fallback_sequential`, or `stop` (default `fallback_sequential`) and use it to determine behavior when all tiers are exhausted.
18. IF any `HIGH_BURN_*` configuration variable contains an invalid value, THEN THE Bot SHALL throw a descriptive error at startup before any RPC or DB operation is performed.

---

### Requirement 2: Database Schema — `high_burn_candidates` Table

**User Story:** As a bot operator, I want all high-burn candidate data persisted in a dedicated
SQLite table, so that indexing progress survives restarts and RPC calls are not repeated
unnecessarily.

#### Acceptance Criteria

1. THE Bot SHALL create the `high_burn_candidates` table on first run using `CREATE TABLE IF NOT EXISTS` with the following columns: `block` (INTEGER PRIMARY KEY), `burn_gwei` (TEXT NOT NULL), `burn_eth` (REAL NOT NULL), `tier_eth` (REAL NOT NULL), `status` (TEXT NOT NULL), `edmt_status` (TEXT), `minted_by` (TEXT), `mint_tx_hash` (TEXT), `fee_required` (INTEGER), `seen_at` (TEXT NOT NULL), `updated_at` (TEXT NOT NULL), `attempts` (INTEGER NOT NULL DEFAULT 0), `last_attempt_at` (TEXT), `skip_reason` (TEXT).
2. THE Bot SHALL create the following indexes on `high_burn_candidates`: `burn_gwei DESC`, `tier_eth`, `status`, `updated_at`.
3. THE Bot SHALL enforce that `status` is one of: `discovered`, `mintable`, `submitted`, `finalized`, `minted_elsewhere`, `not_eligible`, `fee_required_skipped`, `unknown`, `review_required`, `skipped`.
4. WHEN a block is inserted into `high_burn_candidates`, THE Bot SHALL set `seen_at` and `updated_at` to the current UTC ISO-8601 timestamp.
5. WHEN a candidate's status changes, THE Bot SHALL update `updated_at` to the current UTC ISO-8601 timestamp.

---

### Requirement 3: Burn Indexing

**User Story:** As a bot operator, I want the Bot to index blocks by their burn value using
Ethereum RPC data, so that high-burn candidates are identified and stored without relying solely
on the EDMT API.

#### Acceptance Criteria

1. WHEN BurnIndexer processes a block, THE BurnIndexer SHALL call `getBlock(blockNumber)` via the existing `ethClient` to retrieve `baseFeePerGas` and `gasUsed`.
2. THE BurnIndexer SHALL compute `burnGwei = floor(baseFeePerGas × gasUsed / 1e9)` using bigint arithmetic to avoid precision loss.
3. THE BurnIndexer SHALL compute `burnEth = burnGwei / 1e9` as a floating-point number for tier comparison and display only.
4. WHEN `burnEth >= HIGH_BURN_ACTIVE_TIER_ETH`, THE BurnIndexer SHALL insert or update the block in `high_burn_candidates` with `status = discovered` and the computed `burn_gwei`, `burn_eth`, and `tier_eth` values.
5. WHEN `burnEth < HIGH_BURN_ACTIVE_TIER_ETH`, THE BurnIndexer SHALL NOT insert the block into `high_burn_candidates`.
6. WHEN a block's `baseFeePerGas` is null (pre-EIP-1559 block), THE BurnIndexer SHALL skip the block without inserting a record.
7. WHEN `HIGH_BURN_USE_CACHE=true` and the block already exists in `high_burn_candidates` with a non-stale `seen_at` (within `HIGH_BURN_CACHE_TTL_HOURS`), THE BurnIndexer SHALL skip the RPC call and log a `high_burn_cache_hit` event.
8. WHEN `HIGH_BURN_SKIP_ALREADY_SEEN=true` and the block's `status` in `high_burn_candidates` is one of `submitted`, `finalized`, `minted_elsewhere`, or `skipped`, THE BurnIndexer SHALL skip the block and log a `high_burn_skip_seen` event.
9. THE BurnIndexer SHALL process blocks in batches of `HIGH_BURN_BATCH_SIZE` and respect the existing `withRetry` RPC retry logic from `ethClient`.
10. WHEN `HIGH_BURN_SCAN_END_BLOCK` is set and the current block exceeds it, THE BurnIndexer SHALL stop indexing and not process further blocks.
11. WHEN `HIGH_BURN_SCAN_START_BLOCK` is below `12965000`, THE BurnIndexer SHALL treat `12965000` as the effective start block.

---

### Requirement 4: Tier Logic and Tier Manager

**User Story:** As a bot operator, I want the Bot to process candidates from the highest burn
tier first and automatically downgrade to lower tiers when a tier is exhausted, so that the
highest-value blocks are always minted first.

#### Acceptance Criteria

1. THE TierManager SHALL initialize with the tier from `HIGH_BURN_ACTIVE_TIER_ETH` as the active tier.
2. THE TierManager SHALL process tiers in descending order of threshold value (e.g., 100 → 90 → 50 → 20 → 10 → 5 → 4 → 3 → 2 → 1 → 0.5 → 0.25 → 0.1).
3. WHEN the active tier has no more mintable candidates (all candidates are in a terminal status: `finalized`, `minted_elsewhere`, `skipped`, `not_eligible`, `fee_required_skipped`), THE TierManager SHALL log a `high_burn_tier_exhausted` event and downgrade to the next lower tier.
4. WHEN TierManager downgrades to a lower tier, THE TierManager SHALL log a `high_burn_tier_downgraded` event including the previous and new tier values.
5. WHEN all tiers are exhausted, THE TierManager SHALL log a `high_burn_all_tiers_exhausted` event and apply the behavior defined by `HIGH_BURN_ON_EXHAUSTED`.
6. WHEN `HIGH_BURN_ON_EXHAUSTED=fallback_sequential`, THE HighBurnRunner SHALL hand control back to the standard sequential checkpoint scanner.
7. WHEN `HIGH_BURN_ON_EXHAUSTED=wait`, THE HighBurnRunner SHALL pause for `AUTO_MINT_POLL_INTERVAL_MS` milliseconds and retry candidate selection.
8. WHEN `HIGH_BURN_ON_EXHAUSTED=stop`, THE HighBurnRunner SHALL terminate the session with stop reason `high_burn_all_tiers_exhausted`.
9. THE TierManager SHALL log a `high_burn_tier_started` event each time a new tier becomes active.

---

### Requirement 5: Candidate Selection — `getNextHighBurnCandidate()`

**User Story:** As a bot operator, I want the Bot to always select the single best available
candidate for minting, so that the highest-value unminted block is processed next.

#### Acceptance Criteria

1. THE CandidateSelector SHALL implement `getNextHighBurnCandidate()` which returns the next candidate to mint or `null` if none is available.
2. THE CandidateSelector SHALL apply the following priority order when selecting a candidate: (a) highest active tier first, (b) highest `burn_gwei` within the tier when `HIGH_BURN_SORT=desc` or lowest when `HIGH_BURN_SORT=asc`, (c) candidates with `attempts = 0` before candidates with `attempts > 0`, (d) EDMT status confirmed mintable (`edmt_status = mintable`), (e) `fee_required = false` when `HIGH_BURN_ONLY_NO_FEE=true`, (f) no existing submitted/pending transaction for the block in the `txs` table.
3. THE CandidateSelector SHALL NOT return a candidate whose `status` is `submitted`, `finalized`, `minted_elsewhere`, `skipped`, `not_eligible`, or `fee_required_skipped`.
4. THE CandidateSelector SHALL NOT return a candidate that already has a row in the `txs` table with `status` in `pending`, `included`, or `finalized`.
5. WHEN `HIGH_BURN_ONLY_MINTABLE=true`, THE CandidateSelector SHALL only return candidates where `edmt_status = mintable`.
6. WHEN `HIGH_BURN_ONLY_NO_FEE=true`, THE CandidateSelector SHALL only return candidates where `fee_required = 0`.
7. WHEN no candidate satisfies all criteria in the active tier, THE CandidateSelector SHALL return `null` to signal tier exhaustion to TierManager.

---

### Requirement 6: Live Mint Safety Gates

**User Story:** As a bot operator, I want all existing safety gates to remain active in High
Burn Priority Mode, so that no unsafe transactions are ever sent regardless of the candidate
source.

#### Acceptance Criteria

1. THE Bot SHALL apply all existing Gate 1–12 checks in `mintExecutor.ts` to every high-burn candidate before sending a transaction.
2. THE Bot SHALL require `edmtStatusConfirmed = true` for every candidate before executing a mint transaction.
3. THE Bot SHALL require `status = mintable` (confirmed via EDMT API) for every candidate before executing a mint transaction.
4. THE Bot SHALL require `minted_by = null` (no existing owner) for every candidate before executing a mint transaction.
5. WHEN `HIGH_BURN_ONLY_NO_FEE=true`, THE Bot SHALL skip any candidate where `fee_required = true` and update its `status` to `fee_required_skipped`.
6. THE Bot SHALL prevent duplicate transactions: WHEN a transaction for a block already exists in the `txs` table with status `pending`, `included`, or `finalized`, THE Bot SHALL NOT submit a new transaction for that block.
7. THE Bot SHALL enforce all existing gas limits (`MAX_GAS_GWEI`, `MAX_PRIORITY_FEE_GWEI`) for high-burn candidate transactions.
8. THE Bot SHALL enforce all existing nonce safety checks for high-burn candidate transactions.
9. THE Bot SHALL enforce all existing wallet balance limits for high-burn candidate transactions.
10. WHEN a conflict exists between `block_results` and `high_burn_candidates` for the same block, THE Bot SHALL treat the block as already submitted and SHALL NOT send a duplicate transaction.

---

### Requirement 7: Minted Cache and Status Lifecycle

**User Story:** As a bot operator, I want the Bot to track the final status of every candidate
so that minted or finalized blocks are never retried.

#### Acceptance Criteria

1. WHEN the EDMT API returns `minted` for a candidate block, THE Bot SHALL update the candidate's `status` to `minted_elsewhere`, record `minted_by`, and SHALL NOT retry that candidate.
2. WHEN a transaction submitted by the Bot is finalized on-chain, THE Bot SHALL update the candidate's `status` to `finalized`, record `mint_tx_hash`, and SHALL NOT retry that candidate.
3. WHEN a transaction for a candidate is in `submitted`, `pending`, or `included` state, THE Bot SHALL NOT submit a new transaction for that block.
4. WHEN a candidate's EDMT status is `unknown`, THE Bot SHALL increment `attempts` and update `last_attempt_at`, and SHALL NOT retry the candidate in the same loop iteration.
5. WHEN a candidate's `status` is updated to a terminal value (`finalized`, `minted_elsewhere`, `skipped`, `not_eligible`, `fee_required_skipped`), THE Bot SHALL update `updated_at` to the current UTC ISO-8601 timestamp.

---

### Requirement 8: Pipeline Integration

**User Story:** As a bot operator, I want High Burn Priority Mode to work with the existing
pipeline auto-mint infrastructure, so that multiple transactions can be in-flight simultaneously
without waiting for finality.

#### Acceptance Criteria

1. WHEN `HIGH_BURN_PRIORITY_MODE=true` and `AUTO_MINT_PIPELINE_MODE=true`, THE HighBurnRunner SHALL select high-burn candidates and submit transactions using the existing pipeline `execute()` call with `pipelineMode: true`.
2. THE HighBurnRunner SHALL continue scanning for the next candidate without waiting for transaction finality when pipeline mode is active.
3. THE HighBurnRunner SHALL respect `AUTO_MINT_MAX_PENDING_TXS` and `AUTO_MINT_MAX_UNFINALIZED_TXS` capacity limits before submitting each transaction.
4. THE HighBurnRunner SHALL respect `AUTO_MINT_TX_SPACING_MS` between consecutive transaction submissions.
5. THE HighBurnRunner SHALL call `TxMonitor.poll()` at each `AUTO_MINT_RECONCILE_INTERVAL_MS` interval to update transaction statuses.
6. WHEN `HIGH_BURN_PRIORITY_MODE=true` and `AUTO_MINT_PIPELINE_MODE=false`, THE HighBurnRunner SHALL operate in sequential mode: submit one transaction and wait for confirmation before selecting the next candidate.

---

### Requirement 9: CLI Commands

**User Story:** As a bot operator, I want dedicated CLI commands for High Burn Priority Mode, so
that I can index blocks, check status, mint candidates, and reset the cache from the command line.

#### Acceptance Criteria

1. THE Bot SHALL provide a `highburn:scan` CLI command that accepts `--from <BLOCK>`, `--to <BLOCK>`, and `--min-eth <NUMBER>` options and runs BurnIndexer without sending any transactions.
2. THE Bot SHALL provide a `highburn:status` CLI command that displays candidate counts grouped by tier and status.
3. THE Bot SHALL provide a `highburn:mint` CLI command that starts a HighBurnRunner session using the configured `HIGH_BURN_*` settings.
4. THE Bot SHALL provide a `highburn:reset-cache` CLI command that accepts `--tier <ETH>` and resets all candidates for the specified tier to `status = discovered`.
5. WHEN `--from` is omitted from `highburn:scan`, THE Bot SHALL use `HIGH_BURN_SCAN_START_BLOCK` as the default start block.
6. WHEN `--to` is omitted from `highburn:scan`, THE Bot SHALL use `HIGH_BURN_SCAN_END_BLOCK` if set, otherwise scan to the current chain head.
7. WHEN `--min-eth` is omitted from `highburn:scan`, THE Bot SHALL use `HIGH_BURN_ACTIVE_TIER_ETH` as the default minimum burn threshold.

---

### Requirement 10: Structured Log Events

**User Story:** As a bot operator, I want all High Burn Priority Mode actions to emit structured
log events, so that I can monitor, alert on, and audit the mode's behavior.

#### Acceptance Criteria

1. THE Bot SHALL emit a `high_burn_mode_enabled` log event at session start when `HIGH_BURN_PRIORITY_MODE=true`.
2. THE Bot SHALL emit a `high_burn_candidate_discovered` log event each time a new block is inserted into `high_burn_candidates`.
3. THE Bot SHALL emit a `high_burn_candidate_cached` log event each time a block is skipped due to a valid cache hit.
4. THE Bot SHALL emit a `high_burn_candidate_selected` log event each time `getNextHighBurnCandidate()` returns a candidate.
5. THE Bot SHALL emit a `high_burn_candidate_minted_elsewhere` log event when a candidate's status is updated to `minted_elsewhere`.
6. THE Bot SHALL emit a `high_burn_candidate_submitted` log event when a transaction is submitted for a candidate.
7. THE Bot SHALL emit a `high_burn_candidate_finalized` log event when a candidate's transaction is finalized.
8. THE Bot SHALL emit a `high_burn_tier_started` log event when a tier becomes active.
9. THE Bot SHALL emit a `high_burn_tier_exhausted` log event when a tier has no more mintable candidates.
10. THE Bot SHALL emit a `high_burn_tier_downgraded` log event when TierManager moves to the next lower tier.
11. THE Bot SHALL emit a `high_burn_all_tiers_exhausted` log event when all tiers are exhausted.
12. THE Bot SHALL emit a `high_burn_cache_hit` log event when a block is skipped due to a cache hit.
13. THE Bot SHALL emit a `high_burn_skip_seen` log event when a block is skipped because it was already seen.
14. ALL log events SHALL include at minimum: `event` (the event name string), `block` (block number where applicable), and `tier_eth` (active tier where applicable).

---

### Requirement 11: Burn Calculation Correctness

**User Story:** As a bot operator, I want the burn calculation to be mathematically correct and
consistent with the Ethereum protocol, so that tier assignments are accurate.

#### Acceptance Criteria

1. THE BurnIndexer SHALL compute `burnGwei` as `floor(baseFeePerGas × gasUsed / 1_000_000_000)` using bigint division (integer floor).
2. THE BurnIndexer SHALL compute `burnEth` as `Number(burnGwei) / 1_000_000_000` for display and tier comparison.
3. FOR ALL blocks where `baseFeePerGas` and `gasUsed` are known, parsing the block data and computing `burnGwei` then converting to `burnEth` and back to `burnGwei` SHALL produce the original `burnGwei` value (round-trip property).
4. WHEN `burnGwei = 0`, THE BurnIndexer SHALL treat `burnEth = 0` and the block SHALL NOT qualify for any tier with threshold > 0.
5. THE BurnIndexer SHALL use the same `calculateBurnGwei()` function already present in `ethClient.ts` to ensure consistency with the rest of the codebase.

---

### Requirement 12: Existing Behavior Preservation

**User Story:** As a bot operator, I want the existing sequential and pipeline scanning modes to
be completely unaffected when High Burn Priority Mode is disabled, so that I can upgrade without
risk.

#### Acceptance Criteria

1. WHEN `HIGH_BURN_PRIORITY_MODE=false`, THE Bot SHALL NOT create or query the `high_burn_candidates` table during normal operation.
2. WHEN `HIGH_BURN_PRIORITY_MODE=false`, THE Bot SHALL NOT modify the `last_scanned_block` checkpoint in any way that differs from the existing behavior.
3. WHEN `HIGH_BURN_PRIORITY_MODE=false`, THE Bot SHALL NOT emit any `high_burn_*` log events.
4. THE existing `AUTO_MINT_PIPELINE_MODE` flag SHALL continue to operate independently and SHALL NOT require `HIGH_BURN_PRIORITY_MODE=true` to function.
5. ALL existing Gate 1–12 checks in `mintExecutor.ts` SHALL remain unchanged in both code and behavior.

---

### Requirement 13: Documentation

**User Story:** As a bot operator, I want comprehensive documentation for High Burn Priority
Mode, so that I can configure, operate, and troubleshoot the feature without reading source code.

#### Acceptance Criteria

1. THE project README SHALL include a "High Burn Priority Mode" section documenting all `HIGH_BURN_*` environment variables, their types, defaults, and descriptions.
2. THE project RUNBOOK SHALL include an operational procedures section for High Burn Priority Mode covering startup, monitoring, tier exhaustion handling, and cache reset procedures.
3. THE `.env.example` file SHALL include all `HIGH_BURN_*` variables with Turkish-language inline comments describing each variable's purpose and accepted values.
4. THE README "High Burn Priority Mode" section SHALL include a recommended configuration profile for common use cases.
