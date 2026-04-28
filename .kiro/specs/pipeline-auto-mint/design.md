# Design Document — Pipeline Auto Mint Mode

## Overview

Pipeline Auto Mint Mode, `AutoMintRunner`'ın finality beklenmeksizin birden fazla tx'i eş zamanlı olarak "uçuşta" tutabildiği yüksek-throughput çalışma modudur. Mevcut modda her mint tx'i için ~14 dakika (64 confirmation) beklenmekte; bu da 8 saatlik bir session'da ~36 tx ile sınırlı kalmaya yol açmaktadır. Pipeline modu bu kısıtı kaldırarak teorik throughput'u `MAX_UNFINALIZED_TXS × (14 dk / tx)` oranında artırır.

Güvenli varsayılan `AUTO_MINT_PIPELINE_MODE=false` olarak korunur. Tüm mevcut güvenlik kapıları (Gate 1–12) geçerliliğini sürdürür. Yeni config alanları mevcut `AUTO_MINT_*` namespace'ine eklenir.

### Temel Tasarım Kararları

- **İki ayrı checkpoint**: `last_scanned_block` (scan ilerlemesi) ve `last_successful_mint_block` (finality sonrası) birbirinden bağımsız ilerler. Bu sayede duplicate tx riski olmadan tarama sürekliliği sağlanır.
- **Monitor-first loop**: Her iterasyon önce `TxMonitor.poll()` çalıştırır; böylece kapasite bilgisi her zaman güncel kalır.
- **Fresh nonce per tx**: Pipeline modunda her tx için `provider.getTransactionCount(address, "pending")` çağrılır; nonce çakışması tespit edildiğinde tx atlanır.
- **Hata durdurma**: `review_required`, `failed` (flag=true) ve nonce anomaly durumlarında pipeline otomatik durur.

---

## Architecture

### Pipeline Mode Loop Mimarisi

```
┌─────────────────────────────────────────────────────────────────┐
│                    AutoMintRunner.runAutoMint()                  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    LOOP ITERATION                         │   │
│  │                                                          │   │
│  │  ① Pre-checks (emergency stop, session limits, balance)  │   │
│  │                        │                                 │   │
│  │                        ▼                                 │   │
│  │  ② MONITOR PHASE — TxMonitor.poll()                      │   │
│  │     • pending → included (receipt)                       │   │
│  │     • included → finalized (64 conf + EDMT verify)       │   │
│  │     • finalized → advance mint checkpoint                │   │
│  │     • any → review_required (anomaly)                    │   │
│  │                        │                                 │   │
│  │                        ▼                                 │   │
│  │  ③ Stop-condition check (review_required / failed)       │   │
│  │                        │                                 │   │
│  │                        ▼                                 │   │
│  │  ④ CAPACITY CHECK                                        │   │
│  │     pendingCount < MAX_PENDING_TXS?          ──No──►skip │   │
│  │     unfinalizedCount < MAX_UNFINALIZED_TXS?  ──No──►skip │   │
│  │                        │ Yes                             │   │
│  │                        ▼                                 │   │
│  │  ⑤ TX SPACING CHECK                                      │   │
│  │     now - lastTxSentAt >= TX_SPACING_MS?     ──No──►wait │   │
│  │                        │ Yes                             │   │
│  │                        ▼                                 │   │
│  │  ⑥ SCAN/SEND PHASE — decideBlock(currentBlock)           │   │
│  │     mintable → execute() → submit tx                     │   │
│  │     advance scan checkpoint                              │   │
│  │     update lastTxSentAt                                  │   │
│  │                        │                                 │   │
│  │                        ▼                                 │   │
│  │  ⑦ sleep(RECONCILE_INTERVAL_MS)                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Mevcut Mode (pipeline_mode=false) — Değişmez

```
loop:
  if hasPendingTx() → poll() → wait → continue
  decideBlock() → execute() → poll() → cooldown
```

### Pipeline Mode (pipeline_mode=true) — Yeni

```
loop:
  pre-checks
  poll()                          ← Monitor Phase (her iterasyonda)
  check stop conditions
  if pendingCount >= MAX_PENDING  → skip send, sleep, continue
  if unfinalizedCount >= MAX_UNF  → skip send, sleep, continue
  if elapsed < TX_SPACING_MS      → sleep(remaining), continue
  decideBlock() → execute()       ← Scan/Send Phase
  advance scan checkpoint
  sleep(RECONCILE_INTERVAL_MS)
```

---

## Components and Interfaces

### config.ts — Yeni Alanlar

```typescript
// Pipeline mode
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
```

### autoMintRunner.ts — Loop Refactoring

Mevcut `SessionState` interface'ine eklenen alanlar:

```typescript
interface SessionState {
  // ... mevcut alanlar ...
  lastTxSentAt: number;          // Date.now() — tx spacing için
  stopNewTx: boolean;            // nonce anomaly / review_required / failed → true
  stopReason: StopReason;        // stop nedeni
}
```

Pipeline loop'unda iki yeni yardımcı fonksiyon:

```typescript
// Kapasite kontrolü
function checkPipelineCapacity(
  pendingCount: number,
  unfinalizedCount: number
): "ok" | "pending_full" | "unfinalized_full"

// Stop condition kontrolü (poll() sonrası)
async function checkPipelineStopConditions(
  state: SessionState
): Promise<StopReason | null>
```

### db.ts — Yeni Sorgular

```typescript
/**
 * Pipeline kapasite kontrolü için pending tx sayısı.
 * status = 'pending' olan tx'leri sayar.
 */
export function getPendingTxCount(): number

/**
 * Pipeline kapasite kontrolü için unfinalized tx sayısı.
 * status IN ('pending', 'included') olan tx'leri sayar.
 */
export function getUnfinalizedTxCount(): number

/**
 * Belirli bir block için tx'in submitted veya daha ileri bir status'ta
 * olup olmadığını kontrol eder (duplicate prevention).
 */
export function isBlockSubmittedOrBeyond(block: number): boolean
```

### ethClient.ts — Yeni Fonksiyon

```typescript
/**
 * Bir adres için pending nonce değerini döndürür.
 * provider.getTransactionCount(address, "pending") wrapper'ı.
 * Pipeline modunda her tx öncesi çağrılır.
 */
export async function getPendingNonce(address: string): Promise<number>
```

### mintExecutor.ts — Pipeline Nonce Desteği

`execute()` fonksiyonuna `opts` parametresine `pipelineMode?: boolean` eklenir. Pipeline modunda Gate 10 (pending tx check) bypass edilir; nonce yönetimi `getPendingNonce()` ile yapılır.

```typescript
export async function execute(
  blockResult: BlockResult,
  opts: {
    mode?: "manual" | "automint";
    pipelineMode?: boolean;        // yeni
    expectedNonce?: number;        // yeni — pipeline'dan geçirilir
  } = {}
): Promise<MintResult>
```

Gate 10 pipeline modunda şu şekilde değişir:

```typescript
// Gate 10: Pending tx check (pipeline modunda farklı davranış)
if (opts.pipelineMode) {
  // Nonce pipeline'dan geçirilir; duplicate check Gate 9'da yapılır
} else if (!config.allowMultiplePendingTx && hasPendingTx()) {
  // mevcut davranış
}
```

### logger.ts — Yeni LogEvent Sabitleri

```typescript
export const LogEvent = {
  // ... mevcut sabitler ...

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
} as const;
```

### types.ts — Yeni StopReason Değerleri

```typescript
export type StopReason =
  | /* ... mevcut değerler ... */
  | "pending_tx_failure_detected"   // yeni
  | "nonce_anomaly_detected"        // yeni
```

---

## Data Models

### Checkpoint Stratejisi

Pipeline modunda iki checkpoint birbirinden bağımsız ilerler:

| Checkpoint | Anahtar | Ne Zaman İlerler |
|---|---|---|
| Scan Checkpoint | `last_scanned_block` | Tx submit edildiğinde veya block atlandığında |
| Mint Checkpoint | `last_successful_mint_block` | Finality + EDMT owner doğrulaması sonrası |

```
Block 1000 → tx submit → last_scanned_block = 1001
Block 1001 → tx submit → last_scanned_block = 1002
Block 1002 → not_eligible → last_scanned_block = 1003
...
Block 1000 tx → finalized + verified → last_successful_mint_block = 1000
Block 1001 tx → finalized + verified → last_successful_mint_block = 1001
```

Scan checkpoint'i `last_scanned_block` pipeline'da tx submit sonrası `advanceScannedBlock(block, "submitted")` ile ilerler. Bu yeni bir status değeridir; `checkpoint.ts`'deki `ADVANCE_STATUSES` set'ine eklenir.

### Tx Durumu Geçişleri (Pipeline)

```
pending ──receipt(status=1)──► included ──64 conf + EDMT verify──► finalized/successful_mint
        ──receipt(status≠1)──► failed
        ──age > 200 blocks──► review_required
included ──EDMT owner match──► successful_mint
         ──EDMT owner mismatch──► review_required
         ──EDMT unavailable──► review_required
```

### Nonce Yönetimi

Pipeline modunda nonce çakışmasını önlemek için:

1. Her tx öncesi `getPendingNonce(walletAddress)` çağrılır.
2. Dönen nonce değeri `expectedNonce` olarak `execute()` fonksiyonuna geçirilir.
3. `execute()` içinde `sendRawTransaction` çağrısından önce nonce doğrulanır.
4. Eğer nonce beklenenden farklıysa (gap veya replacement), `pipeline_nonce_anomaly` log event'i yazılır ve session durdurulur.

```typescript
// autoMintRunner.ts — pipeline loop içinde
const currentNonce = await getPendingNonce(walletAddress);
if (lastSubmittedNonce !== undefined && currentNonce < lastSubmittedNonce + 1) {
  // Nonce anomaly: gap veya dropped tx
  logger.error({ event: LogEvent.PIPELINE_NONCE_ANOMALY, ... });
  state.stopNewTx = true;
  stopReason = "nonce_anomaly_detected";
  break;
}
```

### SQLite Şema Değişiklikleri

Yeni sorgu gereksinimleri mevcut şema ile karşılanabilir; şema değişikliği gerekmez.

- `getPendingTxCount()`: `SELECT COUNT(*) FROM txs WHERE status = 'pending'`
- `getUnfinalizedTxCount()`: `SELECT COUNT(*) FROM txs WHERE status IN ('pending', 'included')`
- `isBlockSubmittedOrBeyond()`: `SELECT status FROM block_results WHERE block = ?` → status ∈ {submitted, included, finalized, successful_mint, review_required, failed}

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Config Integer Parse Round-Trip

*For any* valid non-negative integer string value assigned to `AUTO_MINT_MAX_PENDING_TXS`, `AUTO_MINT_MAX_UNFINALIZED_TXS`, `AUTO_MINT_TX_SPACING_MS`, or `AUTO_MINT_RECONCILE_INTERVAL_MS`, parsing the environment variable should produce a number equal to the original integer value.

**Validates: Requirements 1.2, 1.3, 1.4, 1.6**

---

### Property 2: Config Boolean Parse Round-Trip

*For any* valid boolean string representation (`"true"`, `"false"`, `"1"`, `"0"`) assigned to `AUTO_MINT_PIPELINE_MODE`, `AUTO_MINT_STOP_ON_PENDING_TX_FAILURE`, or `AUTO_MINT_REQUIRE_INCLUDED_BEFORE_NEXT_TX`, parsing should produce the correct boolean value.

**Validates: Requirements 1.1, 1.5, 1.7**

---

### Property 3: Pipeline Kapasite Kontrolü İnvariantı

*For any* combination of `(pendingCount, unfinalizedCount, maxPending, maxUnfinalized)` where `pendingCount >= maxPending` OR `unfinalizedCount >= maxUnfinalized`, the pipeline loop SHALL NOT call `execute()` for a new tx in that iteration.

Conversely, when `pendingCount < maxPending` AND `unfinalizedCount < maxUnfinalized`, the loop SHALL proceed to the Scan/Send Phase.

**Validates: Requirements 2.3, 2.4, 2.5**

---

### Property 4: Tx Spacing İnvariantı

*For any* `(lastTxSentAt, txSpacingMs)` pair, if `Date.now() - lastTxSentAt < txSpacingMs`, the pipeline loop SHALL NOT submit a new tx. If `Date.now() - lastTxSentAt >= txSpacingMs`, the loop SHALL be permitted to submit (subject to capacity and other checks).

**Validates: Requirements 3.2, 3.3**

---

### Property 5: Scan Checkpoint İlerleme İnvariantı

*For any* block `N` for which a tx is successfully submitted in pipeline mode, `last_scanned_block` SHALL be advanced to at least `N + 1` after the submission. The checkpoint SHALL NOT be advanced for blocks where `decideBlock()` returns `unknown` status.

**Validates: Requirements 5.1, 5.5**

---

### Property 6: Mint Checkpoint Finality İnvariantı

*For any* tx, `last_successful_mint_block` SHALL be advanced to block `N` if and only if the tx for block `N` has reached finality (64+ confirmations) AND the EDMT indexer has confirmed owner match. The checkpoint SHALL NOT advance for `pending`, `included`, `failed`, or `review_required` tx states.

**Validates: Requirements 5.2**

---

### Property 7: Duplicate Tx Önleme İnvariantı

*For any* block `N` that already has a record in `block_results` with status ∈ {`submitted`, `included`, `finalized`, `successful_mint`, `review_required`, `failed`}, calling `execute()` for block `N` SHALL return a `skipped_duplicate_tx` result and SHALL NOT submit a new transaction to the network.

**Validates: Requirements 5.3, 5.4**

---

### Property 8: Nonce Uniqueness İnvariantı

*For any* sequence of N transactions submitted in pipeline mode within a single session, all nonce values SHALL be distinct. No two submitted transactions SHALL share the same nonce value.

**Validates: Requirements 4.1, 4.2**

---

### Property 9: Hata Durdurma İnvariantı

*For any* session state where `stopNewTx = true` (triggered by `review_required`, `failed` with `STOP_ON_PENDING_TX_FAILURE=true`, or nonce anomaly), the pipeline loop SHALL NOT call `execute()` for any subsequent block in that session.

**Validates: Requirements 6.1, 6.2, 6.3**

---

### Property 10: Pipeline Mode=false Backward Compatibility İnvariantı

*For any* session state where `AUTO_MINT_PIPELINE_MODE=false` and `hasPendingTx()` returns true, the loop SHALL NOT call `execute()` for a new tx — preserving the existing behavior exactly.

**Validates: Requirements 1.8, 2.6**

---

### Property 11: Fee Filtering Scan Continuity İnvariantı

*For any* block where `feeRequired=true` and `AUTO_MINT_ONLY_NO_FEE_BLOCKS=true` in pipeline mode, the block SHALL be skipped (scan checkpoint advanced) and the session SHALL continue without stopping. The total number of blocks scanned SHALL increase by 1 for each such skipped block.

**Validates: Requirements 7.1**

---

### Property 12: Session Limit İnvariantı (Pipeline Mode)

*For any* pipeline session, the total number of transactions submitted (`txSentThisSession`) SHALL never exceed `AUTO_MINT_MAX_TX_PER_SESSION`. When the limit is reached, the session SHALL stop with reason `session_tx_limit_reached` regardless of remaining capacity.

**Validates: Requirements 8.1**

---

## Error Handling

### Hata Kategorileri ve Yanıtları

| Hata Durumu | Tetikleyici | Yanıt |
|---|---|---|
| `review_required` tx | TxMonitor.poll() sonrası | `stopNewTx=true`, `review_required_detected` |
| `failed` tx + flag=true | TxMonitor.poll() sonrası | `stopNewTx=true`, `pending_tx_failure_detected` |
| `failed` tx + flag=false | TxMonitor.poll() sonrası | Log yaz, pipeline devam et |
| Nonce anomaly | Nonce kontrolü | `stopNewTx=true`, `nonce_anomaly_detected` |
| RPC hatası (poll) | TxMonitor.poll() | Log yaz, iterasyona devam et |
| RPC hatası (execute) | execute() | Log yaz, `autoMintStopOnFirstError` kontrolü |
| Duplicate tx | Gate 9 | `skipped_duplicate_tx`, scan checkpoint ilerle |
| Kapasite dolu | Kapasite kontrolü | `pipeline_pending_capacity_full` log, sleep, continue |
| Spacing süresi dolmadı | Spacing kontrolü | `pipeline_tx_spacing_wait` log, sleep, continue |

### Stop Condition Kontrolü (poll() Sonrası)

```typescript
async function checkPipelineStopConditions(
  state: SessionState
): Promise<StopReason | null> {
  // 1. review_required kontrolü
  if (config.autoMintStopOnReviewRequired && hasReviewRequiredTx()) {
    return "review_required_detected";
  }
  // 2. failed tx kontrolü
  if (config.autoMintStopOnPendingTxFailure && hasFailedTx()) {
    return "pending_tx_failure_detected";
  }
  return null;
}
```

### Nonce Anomaly Tespiti

Nonce anomaly şu koşullarda tetiklenir:
- `getPendingNonce()` dönen değer, son submit edilen nonce'dan küçükse (dropped tx)
- `getPendingNonce()` dönen değer, son submit edilen nonce'dan 2+ fazlaysa (gap)

---

## Testing Strategy

### Dual Testing Yaklaşımı

- **Unit testler**: Belirli örnekler, edge case'ler ve hata koşulları
- **Property testler**: Tüm inputlar için geçerli evrensel özellikler (vitest + fast-check)

### Property-Based Testing Kütüphanesi

**fast-check** (TypeScript/Node.js için) kullanılacaktır. Minimum 100 iterasyon per property test.

```typescript
import fc from "fast-check";
// Her property test: fc.assert(fc.property(...), { numRuns: 100 })
```

### Test Dosyası Yapısı

```
tests/
├── autoMintRunner.test.ts          — mevcut (genişletilecek)
│   ├── pipeline mode disabled tests
│   ├── pipeline capacity control tests
│   ├── tx spacing tests
│   ├── stop condition tests
│   └── checkpoint advancement tests
├── mintExecutor.test.ts            — mevcut (genişletilecek)
│   ├── pipeline nonce handling
│   └── duplicate prevention (pipeline)
├── txMonitor.test.ts               — mevcut (genişletilecek)
│   └── mint checkpoint advancement
├── db.test.ts                      — yeni
│   ├── getPendingTxCount()
│   ├── getUnfinalizedTxCount()
│   └── isBlockSubmittedOrBeyond()
└── config.test.ts                  — yeni
    ├── pipeline config parse round-trip (PBT)
    └── boolean config parse round-trip (PBT)
```

### Property Test Etiket Formatı

Her property test şu formatta etiketlenir:

```typescript
// Feature: pipeline-auto-mint, Property 3: Pipeline Kapasite Kontrolü İnvariantı
fc.assert(
  fc.property(
    fc.integer({ min: 0, max: 20 }),  // pendingCount
    fc.integer({ min: 0, max: 20 }),  // unfinalizedCount
    fc.integer({ min: 1, max: 10 }),  // maxPending
    fc.integer({ min: 1, max: 15 }),  // maxUnfinalized
    (pendingCount, unfinalizedCount, maxPending, maxUnfinalized) => {
      const shouldSkip =
        pendingCount >= maxPending || unfinalizedCount >= maxUnfinalized;
      const result = checkPipelineCapacity(
        pendingCount, unfinalizedCount, maxPending, maxUnfinalized
      );
      return shouldSkip ? result !== "ok" : result === "ok";
    }
  ),
  { numRuns: 100 }
);
```

### Unit Test Kapsamı

| Test | Dosya | Tip |
|---|---|---|
| pipeline_mode=false + pending tx → no execute | autoMintRunner.test.ts | PBT (Property 10) |
| pipeline_mode=true + pending < max → execute | autoMintRunner.test.ts | PBT (Property 3) |
| pipeline_mode=true + pending >= max → skip | autoMintRunner.test.ts | PBT (Property 3) |
| pipeline_mode=true + unfinalized >= max → skip | autoMintRunner.test.ts | PBT (Property 3) |
| tx spacing dolmadan → no execute | autoMintRunner.test.ts | PBT (Property 4) |
| submitted block → skipped_duplicate_tx | mintExecutor.test.ts | PBT (Property 7) |
| failed + stop=true → session stop | autoMintRunner.test.ts | PBT (Property 9) |
| review_required → session stop | autoMintRunner.test.ts | PBT (Property 9) |
| tx finalized → mint checkpoint advance | txMonitor.test.ts | PBT (Property 6) |
| tx submit → scan checkpoint advance | autoMintRunner.test.ts | PBT (Property 5) |
| unknown status → checkpoint hold | autoMintRunner.test.ts | PBT (Property 5) |
| feeRequired + onlyNoFee → skip + continue | autoMintRunner.test.ts | PBT (Property 11) |
| nonce uniqueness across N txs | mintExecutor.test.ts | PBT (Property 8) |
| config int parse round-trip | config.test.ts | PBT (Property 1) |
| config bool parse round-trip | config.test.ts | PBT (Property 2) |
| session limit in pipeline mode | autoMintRunner.test.ts | PBT (Property 12) |
