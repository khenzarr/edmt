# Design Document — High Burn Priority Mint Mode

## Overview

High Burn Priority Mint Mode (`HIGH_BURN_PRIORITY_MODE=true`) re-orders the minting queue by Ethereum burn value. Instead of scanning blocks sequentially from `last_scanned_block`, the bot indexes blocks by their `burnEth` value, groups them into tier buckets, and selects candidates from the highest tier downward. All existing safety gates (Gate 1–12) remain active. When `HIGH_BURN_PRIORITY_MODE=false` (default), the existing sequential/pipeline behavior is completely unchanged.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    HIGH BURN PRIORITY MODE                       │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ BurnIndexer  │───▶│  TierManager │───▶│ CandidateSelector│   │
│  │              │    │              │    │                  │   │
│  │ RPC → burnGwei│   │ tier buckets │    │getNextHighBurn   │   │
│  │ → high_burn_ │    │ exhaustion   │    │Candidate()       │   │
│  │   candidates │    │ downgrade    │    │                  │   │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘   │
│                                                   │             │
│                                          ┌────────▼─────────┐   │
│                                          │  HighBurnRunner  │   │
│                                          │                  │   │
│                                          │ (replaces        │   │
│                                          │  sequential scan │   │
│                                          │  in AutoMint     │   │
│                                          │  Runner when     │   │
│                                          │  mode=true)      │   │
│                                          └────────┬─────────┘   │
│                                                   │             │
│                                          ┌────────▼─────────┐   │
│                                          │  MintExecutor    │   │
│                                          │  (Gate 1–12,     │   │
│                                          │  unchanged)      │   │
│                                          └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Components

**BurnIndexer** (`src/highBurnIndexer.ts`)
- Reads `baseFeePerGas` and `gasUsed` from Ethereum RPC via `ethClient.calculateBurnGwei()`
- Computes `burnGwei` and `burnEth`, assigns tier bucket via `assignTier()`
- Writes qualifying blocks to `high_burn_candidates` table
- Handles cache hits and skip-seen logic

**TierManager** (`src/highBurnSelector.ts`)
- Tracks the active tier
- Detects tier exhaustion and triggers downgrade
- Applies `HIGH_BURN_ON_EXHAUSTED` behavior when all tiers are exhausted

**CandidateSelector** (`src/highBurnSelector.ts`)
- Implements `getNextHighBurnCandidate()` with priority ordering
- Queries `high_burn_candidates` with duplicate-prevention joins

**HighBurnRunner** (integrated into `src/autoMintRunner.ts`)
- Activated when `HIGH_BURN_PRIORITY_MODE=true`
- Replaces `decideBlock(currentBlock)` with `getNextHighBurnCandidate()`
- Preserves all pipeline guards (capacity, spacing, nonce, duplicate)

**Pipeline AutoMint Integration**
- When `AUTO_MINT_PIPELINE_MODE=true` AND `HIGH_BURN_PRIORITY_MODE=true`: pipeline capacity limits, tx spacing, nonce reconcile, and duplicate guard all apply unchanged
- `execute()` called with `{ mode: "automint", pipelineMode: true, expectedNonce }`

### Regression Note

> **`HIGH_BURN_PRIORITY_MODE=false` (default):** Zero changes to any existing code path. The `high_burn_candidates` table is not queried. No `high_burn_*` log events are emitted. `last_scanned_block` checkpoint behavior is identical to the pre-feature state. All existing tests continue to pass without modification.

---

## 2. Tier Semantics

### Bucket Boundaries

`HIGH_BURN_MIN_ETH_TIERS` defines **minimum threshold bucket boundaries**, not exact target values. Each tier represents a half-open interval `[tierEth, nextHigherTier)`.

Given tiers (sorted descending): `[100, 90, 50, 20, 10, 5, 4, 3, 2, 1, 0.5, 0.25, 0.1]`

| Tier Label | Bucket Range |
|---|---|
| 100 | burnEth >= 100 |
| 90  | 90 <= burnEth < 100 |
| 50  | 50 <= burnEth < 90 |
| 20  | 20 <= burnEth < 50 |
| 10  | 10 <= burnEth < 20 |
| 5   | 5 <= burnEth < 10 |
| 4   | 4 <= burnEth < 5 |
| 3   | 3 <= burnEth < 4 |
| 2   | 2 <= burnEth < 3 |
| 1   | 1 <= burnEth < 2 |
| 0.5 | 0.5 <= burnEth < 1 |
| 0.25| 0.25 <= burnEth < 0.5 |
| 0.1 | 0.1 <= burnEth < 0.25 |
| —   | burnEth < 0.1 → no tier |

### `assignTier()` Function

```typescript
/**
 * Assign a block to its tier bucket.
 * Returns the tier label (the lower bound of the bucket), or null if below minimum.
 *
 * Algorithm:
 *   1. Sort tiers descending.
 *   2. Find the largest tier value where burnEth >= tier.
 *   3. Return that tier value, or null if burnEth < min(tiers).
 */
export function assignTier(burnEth: number, tiers: number[]): number | null {
  const sorted = [...tiers].sort((a, b) => b - a); // descending
  for (const tier of sorted) {
    if (burnEth >= tier) return tier;
  }
  return null; // below minimum tier
}
```

### Examples

| burnEth | assignTier result | Reason |
|---|---|---|
| 150.0 | 100 | >= 100 |
| 99.9 | 90 | >= 90, < 100 |
| 90.0 | 90 | >= 90, < 100 |
| 89.999 | 50 | >= 50, < 90 |
| 4.7 | 4 | >= 4, < 5 |
| 3.99 | 3 | >= 3, < 4 |
| 0.09 | null | < 0.1 (minimum) |

**Key insight:** After exhausting the 100-tier, the bot scans ALL blocks with `90 <= burnEth < 100` (the 90-tier bucket), sorted by `burnGwei DESC`. It does not look for blocks with exactly 90 ETH burn.

---

## 3. Burn Indexing Design

### Calculation

```typescript
// From ethClient.ts (existing) — reused as-is
export async function calculateBurnGwei(blockNumber: number): Promise<bigint | undefined>

// burnGwei = floor(baseFeePerGas * gasUsed / 1_000_000_000)  [bigint arithmetic]
// burnEth  = Number(burnGwei) / 1_000_000_000                [float, for tier comparison only]
```

### Indexing Flow

```
for each block in [startBlock, endBlock] in batches of HIGH_BURN_BATCH_SIZE:

  1. CACHE CHECK (HIGH_BURN_USE_CACHE=true):
     if block in high_burn_candidates AND seen_at within TTL:
       log high_burn_cache_hit
       continue

  2. SKIP-SEEN CHECK (HIGH_BURN_SKIP_ALREADY_SEEN=true):
     if block.status IN ('submitted','finalized','minted_elsewhere','skipped','fee_required_skipped','not_eligible'):
       log high_burn_skip_seen
       continue

  3. RPC FETCH:
     block = getBlock(blockNumber)
     if block.baseFeePerGas == null: continue  (pre-EIP-1559)

  4. BURN CALCULATION:
     burnGwei = floor(baseFeePerGas * gasUsed / 1e9)
     burnEth  = Number(burnGwei) / 1e9

  5. TIER ASSIGNMENT:
     tierEth = assignTier(burnEth, config.highBurnMinEthTiers)
     if tierEth == null: continue  (below minimum tier)

  6. CAPACITY CHECK:
     if count(high_burn_candidates WHERE tier_eth = tierEth) >= HIGH_BURN_MAX_CANDIDATES_PER_TIER:
       continue  (tier full)

  7. UPSERT:
     INSERT OR IGNORE INTO high_burn_candidates (block, burn_gwei, burn_eth, tier_eth, status, seen_at, updated_at)
     VALUES (block, burnGwei.toString(), burnEth.toString(), tierEth, 'discovered', now, now)
     log high_burn_candidate_discovered
```

### Batch Processing

- `HIGH_BURN_BATCH_SIZE` (default 1000): blocks fetched per iteration
- RPC calls use existing `withRetry()` from `ethClient.ts`
- `HIGH_BURN_SCAN_END_BLOCK`: if set, stop when `blockNumber > endBlock`
- `HIGH_BURN_SCAN_START_BLOCK`: minimum 12965000 (EIP-1559 activation)

---

## 4. Database Schema

### `high_burn_candidates` Table

```sql
CREATE TABLE IF NOT EXISTS high_burn_candidates (
  block           INTEGER PRIMARY KEY,
  burn_gwei       TEXT    NOT NULL,          -- bigint stored as string
  burn_eth        TEXT    NOT NULL,          -- float stored as string
  tier_eth        REAL    NOT NULL,          -- tier bucket lower bound
  status          TEXT    NOT NULL DEFAULT 'discovered',
  edmt_status     TEXT,                      -- 'mintable' | 'minted' | 'not_eligible' | null
  minted_by       TEXT,                      -- wallet address if minted_elsewhere
  mint_tx_hash    TEXT,                      -- our tx hash if finalized
  fee_required    INTEGER,                   -- 0 or 1
  seen_at         TEXT    NOT NULL,          -- ISO-8601 UTC
  updated_at      TEXT    NOT NULL,          -- ISO-8601 UTC
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,                      -- ISO-8601 UTC
  skip_reason     TEXT                       -- human-readable skip reason
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_hbc_burn_gwei
  ON high_burn_candidates (CAST(burn_gwei AS INTEGER) DESC);

CREATE INDEX IF NOT EXISTS idx_hbc_tier_eth
  ON high_burn_candidates (tier_eth);

CREATE INDEX IF NOT EXISTS idx_hbc_status
  ON high_burn_candidates (status);

CREATE INDEX IF NOT EXISTS idx_hbc_updated_at
  ON high_burn_candidates (updated_at);
```

### Status Values

| Status | Meaning |
|---|---|
| `discovered` | Indexed by BurnIndexer, not yet checked by EDMT API |
| `mintable` | EDMT API confirmed mintable |
| `submitted` | Our tx submitted, pending confirmation |
| `finalized` | Our tx finalized, owner verified |
| `minted_elsewhere` | EDMT API shows already minted by another wallet |
| `not_eligible` | EDMT API returned not_eligible |
| `fee_required_skipped` | feeRequired=true + HIGH_BURN_ONLY_NO_FEE=true |
| `unknown` | EDMT API returned unknown — retry later |
| `review_required` | TxMonitor flagged for manual review |
| `skipped` | Manually skipped or other reason |

### DB Functions (new in `src/db.ts`)

```typescript
// Insert or ignore a new candidate
export function upsertHighBurnCandidate(params: {
  block: number; burnGwei: bigint; burnEth: number; tierEth: number;
}): void

// Update candidate status
export function updateHighBurnCandidateStatus(
  block: number,
  status: HighBurnCandidateStatus,
  extra?: { edmt_status?: string; minted_by?: string; mint_tx_hash?: string;
            fee_required?: boolean; skip_reason?: string }
): void

// Get next candidate for a tier (used by CandidateSelector)
export function queryNextHighBurnCandidate(
  tierEth: number,
  opts: { onlyNoFee: boolean; onlyMintable: boolean }
): HighBurnCandidateRow | undefined

// Check if a tier is exhausted
export function isHighBurnTierExhausted(tierEth: number): boolean

// Get status summary grouped by tier
export function getHighBurnStatusSummary(): Array<{
  tier_eth: number; status: string; count: number;
}>

// Reset tier candidates to 'discovered'
export function resetHighBurnTier(tierEth: number): number  // returns count reset

// Count candidates per tier
export function countHighBurnCandidatesByTier(tierEth: number): number
```

---

## 5. Candidate Selection

### `getNextHighBurnCandidate()` Design

```typescript
export interface HighBurnCandidateRow {
  block: number;
  burn_gwei: string;
  burn_eth: string;
  tier_eth: number;
  status: string;
  edmt_status: string | null;
  fee_required: number | null;
  attempts: number;
}

export function getNextHighBurnCandidate(
  tierEth: number,
  opts: { onlyNoFee: boolean; onlyMintable: boolean }
): HighBurnCandidateRow | null
```

### SQL Query

```sql
SELECT hbc.*
FROM high_burn_candidates hbc
WHERE hbc.tier_eth = :tierEth
  AND hbc.status NOT IN (
    'submitted', 'finalized', 'minted_elsewhere',
    'skipped', 'not_eligible', 'fee_required_skipped'
  )
  -- Duplicate prevention: no active tx in txs table
  AND NOT EXISTS (
    SELECT 1 FROM txs t
    WHERE t.block = hbc.block
      AND t.status IN ('pending', 'included', 'finalized')
  )
  -- Duplicate prevention: no submitted record in block_results
  AND NOT EXISTS (
    SELECT 1 FROM block_results br
    WHERE br.block = hbc.block
      AND br.status IN ('submitted', 'included', 'finalized', 'successful_mint')
  )
  [AND hbc.fee_required = 0]          -- when onlyNoFee=true
  [AND hbc.edmt_status = 'mintable']  -- when onlyMintable=true
ORDER BY
  hbc.attempts ASC,                              -- attempts=0 first
  CAST(hbc.burn_gwei AS INTEGER) DESC            -- highest burn first
LIMIT 1
```

### Priority Order Summary

1. Active tier only (`tier_eth = activeTierEth`)
2. Highest `burn_gwei` (CAST to INTEGER for correct numeric sort)
3. `attempts = 0` before `attempts > 0`
4. `edmt_status = 'mintable'` (when `HIGH_BURN_ONLY_MINTABLE=true`)
5. `fee_required = 0` (when `HIGH_BURN_ONLY_NO_FEE=true`)
6. No existing tx in `txs` table (pending/included/finalized)
7. No submitted record in `block_results`

---

## 6. Tier Exhaustion

### `isTierExhausted()` Logic

A tier is exhausted when ALL candidates in that tier have a terminal status:

```typescript
export function isHighBurnTierExhausted(tierEth: number): boolean {
  // Returns true if no candidate in this tier has a non-terminal status
  // Terminal: finalized, minted_elsewhere, skipped, not_eligible, fee_required_skipped
  // Non-terminal: discovered, mintable, unknown, review_required
  // Also: submitted is non-terminal (tx in flight)
}
```

### TierManager State Machine

```
activeTier = HIGH_BURN_ACTIVE_TIER_ETH

loop:
  candidate = getNextHighBurnCandidate(activeTier, opts)

  if candidate != null:
    → mint candidate

  else:
    if isTierExhausted(activeTier):
      log high_burn_tier_exhausted { tierEth: activeTier }
      nextTier = getNextLowerTier(activeTier, allTiers)

      if nextTier != null:
        log high_burn_tier_downgraded { fromTier: activeTier, toTier: nextTier }
        activeTier = nextTier
        log high_burn_tier_started { tierEth: activeTier }
        continue

      else:
        log high_burn_all_tiers_exhausted
        apply HIGH_BURN_ON_EXHAUSTED behavior
```

### `getNextLowerTier()` Function

```typescript
export function getNextLowerTier(
  currentTier: number,
  allTiers: number[]  // sorted descending
): number | null {
  const sorted = [...allTiers].sort((a, b) => b - a);
  const idx = sorted.indexOf(currentTier);
  if (idx === -1 || idx === sorted.length - 1) return null;
  return sorted[idx + 1];
}
```

### Exhaustion Behaviors

| `HIGH_BURN_ON_EXHAUSTED` | Behavior |
|---|---|
| `fallback_sequential` | HighBurnRunner yields; AutoMintRunner continues with `decideBlock(currentBlock)` |
| `wait` | Sleep `AUTO_MINT_POLL_INTERVAL_MS`, retry candidate selection |
| `stop` | Session ends with `stopReason = "high_burn_all_tiers_exhausted"` |

---

## 7. Pipeline Integration

### Loop Architecture (HIGH_BURN_PRIORITY_MODE=true)

```
HighBurnRunner loop (replaces sequential scan in AutoMintRunner):

  ① Pre-checks (emergency stop, session limits, balance) — unchanged
  ② Monitor Phase: TxMonitor.poll() — unchanged (if pipeline mode)
  ③ Stop condition check — unchanged
  ④ Capacity check (if pipeline mode) — unchanged
  ⑤ Tx spacing check (if pipeline mode) — unchanged
  ⑥ Nonce check — unchanged (two-phase reconcile)

  ⑦ HIGH BURN CANDIDATE SELECTION (replaces decideBlock):
     candidate = getNextHighBurnCandidate(activeTierEth, opts)

     if candidate == null:
       → TierManager.tryDowngrade()
       → apply HIGH_BURN_ON_EXHAUSTED if all tiers exhausted
       → continue

  ⑧ Execute mint:
     mintResult = execute(blockResult, {
       mode: "automint",
       pipelineMode: config.autoMintPipelineMode,
       expectedNonce
     })

  ⑨ Post-submit:
     if mintResult.status == "submitted":
       updateHighBurnCandidateStatus(candidate.block, "submitted")
       log high_burn_candidate_submitted
       lastTxSentAt = Date.now()
       lastSubmittedNonce = expectedNonce

  ⑩ Sleep(reconcileIntervalMs)
```

### Finality Reconciliation

When `TxMonitor.poll()` finalizes a tx for a high-burn candidate:
- `TxMonitor` updates `txs.status = 'finalized'`
- `TxMonitor` calls `setSuccessfulMintBlock(block)` (existing)
- `HighBurnRunner` (or a post-poll hook) updates `high_burn_candidates.status = 'finalized'`
- Log `high_burn_candidate_finalized`

When EDMT API returns `minted` for a candidate:
- `high_burn_candidates.status = 'minted_elsewhere'`
- `minted_by` recorded
- Log `high_burn_candidate_minted_elsewhere`

### Interaction with AUTO_MINT_PIPELINE_MODE

| HIGH_BURN_PRIORITY_MODE | AUTO_MINT_PIPELINE_MODE | Behavior |
|---|---|---|
| false | false | Existing sequential mode (unchanged) |
| false | true | Existing pipeline mode (unchanged) |
| true | false | High burn sequential: one tx at a time, wait for confirmation |
| true | true | High burn pipeline: multiple txs in-flight, capacity/spacing/nonce guards active |

---

## 8. Cache and Re-scan Strategy

### Cache Hit (HIGH_BURN_USE_CACHE=true)

```
if block in high_burn_candidates:
  age = now - seen_at (in hours)
  if age <= HIGH_BURN_CACHE_TTL_HOURS:
    log high_burn_cache_hit { block, seenAt }
    skip RPC call
    return existing record
  else:
    stale cache → re-fetch from RPC
```

### Skip-Seen (HIGH_BURN_SKIP_ALREADY_SEEN=true)

```
if block.status IN ('submitted','finalized','minted_elsewhere',
                    'skipped','fee_required_skipped','not_eligible'):
  log high_burn_skip_seen { block, status }
  skip entirely (no RPC, no DB write)
```

### Unknown Retry Policy

```
if block.status == 'unknown':
  attempts++
  last_attempt_at = now
  DO NOT retry in same loop iteration
  Retry only when:
    - New session starts (attempts reset is optional)
    - OR cache TTL expired (seen_at stale)
  Max retry guard: if attempts > HIGH_BURN_CACHE_TTL_HOURS (proxy), mark as 'skipped'
```

### Terminal Status (never re-processed)

| Status | Re-processed? |
|---|---|
| `finalized` | No (unless HIGH_BURN_RESCAN_MINTED=true) |
| `minted_elsewhere` | No (unless HIGH_BURN_RESCAN_MINTED=true) |
| `submitted` | No (tx in flight) |
| `fee_required_skipped` | No |
| `not_eligible` | No |
| `skipped` | No |
| `unknown` | Yes, with retry policy |
| `discovered` | Yes |
| `mintable` | Yes |

---

## 9. CLI Design

### `highburn:scan`

```
npm run highburn:scan -- --from <BLOCK> --to <BLOCK> --min-eth <NUMBER>
```

| Parameter | Default | Description |
|---|---|---|
| `--from` | `HIGH_BURN_SCAN_START_BLOCK` | Start block (min 12965000) |
| `--to` | `HIGH_BURN_SCAN_END_BLOCK` or chain head | End block |
| `--min-eth` | `HIGH_BURN_ACTIVE_TIER_ETH` | Minimum burn ETH threshold |

- **Purpose:** Index blocks for high-burn candidates. No transactions sent.
- **Output:** Progress log per batch, final summary: `{ scanned, discovered, cached, skipped, byTier }`
- **Safety:** Does not require `DRY_RUN=false` or `ENABLE_LIVE_MINT=true`. Read-only DB writes only.

### `highburn:status`

```
npm run highburn:status
```

- **Purpose:** Display candidate statistics grouped by tier and status.
- **Output:** Table: `tier_eth | total | mintable | submitted | finalized | minted_elsewhere | skipped | unknown`
- **No RPC calls.**

### `highburn:mint`

```
npm run highburn:mint
```

- **Purpose:** Start a HighBurnRunner session using configured `HIGH_BURN_*` settings.
- **Requires:** `UNATTENDED_AUTO_MINT=true`, `DRY_RUN=false`, `ENABLE_LIVE_MINT=true`, `HIGH_BURN_PRIORITY_MODE=true`
- **Behavior:** Identical to `automint` but uses `getNextHighBurnCandidate()` for block selection.
- **Safety:** All Gate 1–12 checks apply. Emergency stop, lock file, wallet balance checks all active.

### `highburn:reset-cache`

```
npm run highburn:reset-cache -- --tier <ETH>
```

| Parameter | Required | Description |
|---|---|---|
| `--tier` | Yes | Tier ETH value to reset (e.g., `4`) |

- **Purpose:** Reset all candidates for a specific tier to `status='discovered'`.
- **Safety:** Requires explicit `--tier` argument. No wildcard reset. Prompts confirmation.
- **Output:** `Reset N candidates for tier 4 ETH`

---

## 10. Logging

All log events use the existing `pino` logger. New `LogEvent` constants:

```typescript
// In src/logger.ts LogEvent object:
HIGH_BURN_MODE_ENABLED:              "high_burn_mode_enabled",
HIGH_BURN_CANDIDATE_DISCOVERED:      "high_burn_candidate_discovered",
HIGH_BURN_CANDIDATE_CACHED:          "high_burn_candidate_cached",
HIGH_BURN_CANDIDATE_SELECTED:        "high_burn_candidate_selected",
HIGH_BURN_CANDIDATE_MINTED_ELSEWHERE:"high_burn_candidate_minted_elsewhere",
HIGH_BURN_CANDIDATE_SUBMITTED:       "high_burn_candidate_submitted",
HIGH_BURN_CANDIDATE_FINALIZED:       "high_burn_candidate_finalized",
HIGH_BURN_TIER_STARTED:              "high_burn_tier_started",
HIGH_BURN_TIER_EXHAUSTED:            "high_burn_tier_exhausted",
HIGH_BURN_TIER_DOWNGRADED:           "high_burn_tier_downgraded",
HIGH_BURN_ALL_TIERS_EXHAUSTED:       "high_burn_all_tiers_exhausted",
HIGH_BURN_CACHE_HIT:                 "high_burn_cache_hit",
HIGH_BURN_SKIP_SEEN:                 "high_burn_skip_seen",
```

### Event Payloads

| Event | Fields |
|---|---|
| `high_burn_mode_enabled` | `activeTierEth`, `tiers`, `onExhausted` |
| `high_burn_candidate_discovered` | `block`, `burnGwei`, `burnEth`, `tierEth` |
| `high_burn_candidate_cached` | `block`, `burnGwei`, `tierEth`, `seenAt` |
| `high_burn_candidate_selected` | `block`, `burnGwei`, `burnEth`, `tierEth`, `attempts` |
| `high_burn_candidate_minted_elsewhere` | `block`, `mintedBy` |
| `high_burn_candidate_submitted` | `block`, `txHash`, `nonce`, `tierEth` |
| `high_burn_candidate_finalized` | `block`, `txHash`, `tierEth` |
| `high_burn_tier_started` | `tierEth` |
| `high_burn_tier_exhausted` | `tierEth`, `candidateCount` |
| `high_burn_tier_downgraded` | `fromTier`, `toTier` |
| `high_burn_all_tiers_exhausted` | `onExhausted` |
| `high_burn_cache_hit` | `block`, `seenAt` |
| `high_burn_skip_seen` | `block`, `status` |

---

## 11. Safety Invariants

| Invariant | Enforcement |
|---|---|
| No live tx without `edmtStatusConfirmed=true` | Gate 5 in `mintExecutor.ts` (unchanged) |
| No live tx when `feeRequired=true` and `HIGH_BURN_ONLY_NO_FEE=true` | CandidateSelector SQL filter + Gate 6/7 |
| No duplicate tx (txs table) | CandidateSelector SQL `NOT EXISTS` join |
| No duplicate tx (block_results table) | CandidateSelector SQL `NOT EXISTS` join |
| No duplicate tx (high_burn_candidates.status=submitted) | Status filter in `getNextHighBurnCandidate()` |
| Nonce guard (two-phase reconcile) | Preserved from pipeline-auto-mint implementation |
| Pipeline capacity limits | `checkPipelineCapacity()` called before every tx |
| Wallet balance limits | `checkWalletBalance()` called every loop iteration |
| Emergency stop (`STOP_AUTOMINT`) | Checked first in every loop iteration |
| `submitted`/`finalized`/`minted_elsewhere` never re-minted | Status filter in `getNextHighBurnCandidate()` |
| Gate 1–12 in `mintExecutor.ts` never bypassed | `execute()` called with same opts as pipeline mode |
| `HIGH_BURN_PRIORITY_MODE=false` → zero behavior change | Conditional branch in `autoMintRunner.ts` |

---

## 12. Testing Strategy

### Test Files

```
tests/
├── highBurnIndexer.test.ts     — BurnIndexer + assignTier + DB writes
├── highBurnSelector.test.ts    — CandidateSelector + TierManager
└── autoMintRunner.highBurn.test.ts — HighBurnRunner integration
```

### Tier Assignment Tests (`highBurnIndexer.test.ts`)

| Test | Input | Expected |
|---|---|---|
| burnEth=99.9 → 90 tier | `assignTier(99.9, tiers)` | `90` |
| burnEth=90.0 → 90 tier | `assignTier(90.0, tiers)` | `90` |
| burnEth=89.999 → 50 tier | `assignTier(89.999, tiers)` | `50` |
| burnEth=4.7 → 4 tier | `assignTier(4.7, tiers)` | `4` |
| burnEth=3.99 → 3 tier | `assignTier(3.99, tiers)` | `3` |
| burnEth=0.09 → null | `assignTier(0.09, tiers)` | `null` |

### BurnIndexer Tests

| Test | Scenario |
|---|---|
| burnGwei calculation | `baseFeePerGas=1e9n, gasUsed=1e9n` → `burnGwei=1n` |
| burnEth >= tier → candidate inserted | `burnEth=4.5, tier=4` → row in DB |
| burnEth < lowest tier → not inserted | `burnEth=0.05, tiers=[0.1,...]` → no row |
| cache hit → no RPC call | block in DB within TTL → `getBlock()` not called |
| skip-seen → no processing | status=`finalized` → skipped, log emitted |

### CandidateSelector Tests (`highBurnSelector.test.ts`)

| Test | Scenario |
|---|---|
| Candidates sorted burnGwei DESC | Two candidates in same tier → higher burn selected first |
| 100-tier before 4-tier | Candidates in both tiers → 100-tier selected |
| Tier exhausted → downgrade | All 100-tier candidates terminal → downgrade to 90-tier |
| `minted_elsewhere` not returned | status=`minted_elsewhere` → `getNextHighBurnCandidate()` returns null |
| `submitted` not returned | status=`submitted` → not returned |
| `finalized` not returned | status=`finalized` → not returned |
| feeRequired + onlyNoFee → skipped | `fee_required=1`, `onlyNoFee=true` → not returned |
| unknown not retried same loop | status=`unknown` → attempts incremented, not returned again |
| block_results conflict → no duplicate | block in `block_results` with status=`submitted` → not returned |
| txs conflict → no duplicate | block in `txs` with status=`pending` → not returned |

### HighBurnRunner Integration Tests (`autoMintRunner.highBurn.test.ts`)

| Test | Scenario |
|---|---|
| `HIGH_BURN_ON_EXHAUSTED=fallback_sequential` | All tiers exhausted → `decideBlock()` called |
| `HIGH_BURN_ON_EXHAUSTED=stop` | All tiers exhausted → session stops |
| Pipeline mode + high burn candidate | Candidate found → `execute()` called with `pipelineMode:true` |
| Duplicate prevention | Candidate in `txs` as pending → `execute()` not called |
| `HIGH_BURN_PRIORITY_MODE=false` regression | Existing sequential tests still pass |

---

## 13. Implementation Plan (Tasks)

### Task 1: types.ts — New Types
- Add `HighBurnCandidateStatus` union type
- Add `HighBurnCandidate` interface
- Add `"high_burn_all_tiers_exhausted"` to `StopReason`

### Task 2: logger.ts — New LogEvent Constants
- Add all 13 `HIGH_BURN_*` log event constants

### Task 3: config.ts — New Config Fields
- Add all 17 `HIGH_BURN_*` config fields with parse helpers
- Add `parseFloatArrayEnv()` for `HIGH_BURN_MIN_ETH_TIERS`
- Add `parseHighBurnOnExhausted()` validator

### Task 4: db.ts — high_burn_candidates Schema + CRUD
- Add `high_burn_candidates` table creation in `createTables()`
- Implement: `upsertHighBurnCandidate()`, `updateHighBurnCandidateStatus()`, `queryNextHighBurnCandidate()`, `isHighBurnTierExhausted()`, `getHighBurnStatusSummary()`, `resetHighBurnTier()`, `countHighBurnCandidatesByTier()`

### Task 5: src/highBurnIndexer.ts — BurnIndexer (new file)
- `assignTier(burnEth, tiers): number | null`
- `indexBlockRange(from, to, minEth, opts): Promise<IndexSummary>`
- Cache hit and skip-seen logic
- Batch processing with `HIGH_BURN_BATCH_SIZE`

### Task 6: src/highBurnSelector.ts — CandidateSelector + TierManager (new file)
- `getNextHighBurnCandidate(tierEth, opts): HighBurnCandidateRow | null`
- `isTierExhausted(tierEth): boolean`
- `getNextLowerTier(currentTier, allTiers): number | null`
- `TierManager` class with state tracking

### Task 7: autoMintRunner.ts — HighBurnRunner Integration
- Add `HIGH_BURN_PRIORITY_MODE` branch in pipeline loop
- Replace `decideBlock()` with `getNextHighBurnCandidate()` when mode=true
- Add tier exhaustion handling and `HIGH_BURN_ON_EXHAUSTED` behavior
- Add `high_burn_mode_enabled` log at session start
- Update `high_burn_candidates.status` after submit and finality

### Task 8: src/cli.ts — CLI Commands
- Add `highburn:scan`, `highburn:status`, `highburn:mint`, `highburn:reset-cache` commands
- Update `package.json` scripts

### Task 9: .env.example — HIGH_BURN_* Variables
- Add all 17 variables with Turkish inline comments

### Task 10: tests/highBurnIndexer.test.ts
- `assignTier()` tests (6 tier assignment cases)
- BurnIndexer unit tests (cache, skip-seen, DB write)

### Task 11: tests/highBurnSelector.test.ts
- CandidateSelector tests (sorting, filtering, duplicate prevention)
- TierManager tests (exhaustion, downgrade)

### Task 12: tests/autoMintRunner.highBurn.test.ts
- HighBurnRunner integration tests
- Exhaustion behavior tests
- Pipeline + high burn combined tests
- Regression: `HIGH_BURN_PRIORITY_MODE=false` existing tests unchanged

### Task 13: README.md + RUNBOOK.md
- "High Burn Priority Mode" section in README
- Operational procedures in RUNBOOK

### Task 14: Final Checkpoint
- `npm test` — all tests pass
- `npm run build` — no TypeScript errors
- `npm run lint` — no ESLint errors
- `npm run format:check` — Prettier compliant

---

## Correctness Properties

### Property 1: Tier Assignment Correctness
For any `burnEth` and sorted-descending `tiers`, `assignTier(burnEth, tiers)` returns the largest tier value `t` such that `burnEth >= t`, or `null` if `burnEth < min(tiers)`.

### Property 2: Candidate Priority Invariant
For any two candidates A and B in the same tier, if `burnGwei(A) > burnGwei(B)` and both have `attempts=0`, then A is always selected before B.

### Property 3: No Duplicate Tx Invariant
For any block N, if `txs` contains a row with `block=N` and `status IN ('pending','included','finalized')`, then `getNextHighBurnCandidate()` SHALL NOT return block N.

### Property 4: Tier Monotonicity Invariant
TierManager SHALL only downgrade (move to lower tier), never upgrade. Once a tier is exhausted, it is not revisited unless `highburn:reset-cache` is called.

### Property 5: Safety Gate Preservation Invariant
For any candidate selected by `getNextHighBurnCandidate()`, all Gate 1–12 checks in `mintExecutor.ts` are applied before any transaction is sent. No gate is bypassed.
