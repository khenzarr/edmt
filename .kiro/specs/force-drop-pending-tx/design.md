# Force Drop Pending TX Bugfix Design

## Overview

`--force-drop --tx <HASH>` komutu, `txs.status = 'pending'`, `'included'` veya `'submitted'` olan tx kayıtlarını candidate olarak seçemiyor. `reconcileAll()` yalnızca `getReviewRequiredTxs()` ile `review_required` statüsündeki kayıtları seçtiği için, explicit hash filtresi verilse bile bu tx'ler 0 candidate döndürüyor.

Fix yaklaşımı **minimal ve cerrahi**: `resolveForceDropTx()` fonksiyonuna dokunulmadan, yalnızca `reconcileAll()` içindeki candidate seçim mantığı genişletilir. `opts.forceDrop && opts.txFilter` durumunda, `getReviewRequiredTxs()` sonucuna ek olarak `getStuckTxByHash(txHash)` ile `pending`/`included`/`submitted` statüsündeki tx de candidate listesine eklenir. `resolveForceDropTx()` içindeki `status !== 'review_required'` guard da bu statüsleri kabul edecek şekilde güncellenir.

Etkilenen dosyalar: `src/db.ts`, `src/reconciler.ts` (minimal), `src/cli.ts` (değişmez)

---

## Glossary

- **Bug_Condition (C)**: `txs.status IN ('pending', 'included', 'submitted')` olan bir tx için `--force-drop --tx <HASH>` çalıştırıldığında `reconcileAll()` 0 candidate döndürme koşulu
- **Property (P)**: `--force-drop --tx <HASH>` verildiğinde, hedef tx'in statüsünden bağımsız olarak candidate listesine alınması ve tüm force-drop safety check'lerinin çalıştırılması
- **Preservation**: `--force-drop` olmadan `pending`/`included`/`submitted` tx'lere dokunulmaması; mevcut `review_required` reconcile akışının değişmemesi
- **reconcileAll(opts)**: `src/reconciler.ts` içinde tüm reconcile mantığını yöneten ana fonksiyon; candidate seçimi ve karar uygulamasını koordine eder
- **resolveForceDropTx(tx, opts)**: `src/reconciler.ts` içinde 11 safety check uygulayan force-drop karar fonksiyonu; bu fix kapsamında **değiştirilmez** (yalnızca status guard genişletilir)
- **getReviewRequiredTxs()**: `src/db.ts` içinde yalnızca `status = 'review_required'` kayıtları döndüren mevcut sorgu; bu fix kapsamında **değiştirilmez**
- **getStuckTxByHash(txHash)**: `src/db.ts` içine eklenecek yeni sorgu; `txs` tablosundan status fark etmeksizin explicit hash ile tek bir tx döndürür
- **ReconcileOpts**: `forceDrop`, `txFilter`, `blockFilter`, `fixDropped` alanlarını içeren reconcile seçenekleri interface'i
- **stuck tx**: Zincirde bulunamayan (getTransaction null, receipt null) ancak DB'de `pending`/`included`/`submitted` olarak kalan tx

---

## Bug Details

### Bug Condition

Bug, `--force-drop --tx <HASH>` komutu çalıştırıldığında ve hedef tx'in `txs.status IN ('pending', 'included', 'submitted')` olduğu durumda tetiklenir. `reconcileAll()` yalnızca `getReviewRequiredTxs()` ile candidate seçtiği için, explicit hash filtresi verilse bile bu tx'ler hiç işlenmez ve 0 candidate döndürülür.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type TxRecord  (txs tablosundan bir satır)
  OUTPUT: boolean

  // Bug tetiklenir: tx pending/included/submitted statüsünde VE
  // explicit --force-drop --tx <HASH> ile hedefleniyor VE
  // reconcileAll bu tx'i candidate olarak seçmiyor
  RETURN X.status IN ('pending', 'included', 'submitted')
         AND opts.forceDrop = true
         AND opts.txFilter = X.tx_hash
         AND getReviewRequiredTxs() does NOT include X
         AND reconcileAll(opts).total = 0
END FUNCTION
```

### Examples

- **Örnek 1 (Production bug)**: Block 24987965, tx `0x3fc11effe...`, nonce 643, `status = 'pending'`. `npm run reconcile -- --force-drop --tx 0x3fc11effe...` → `0 candidates found`. Beklenen: 1 candidate, force-drop safety check'leri çalışmalı.
- **Örnek 2**: `status = 'included'` olan bir tx için `--force-drop --tx HASH` → 0 candidate. Beklenen: candidate seçilmeli, `resolveForceDropTx()` çalışmalı.
- **Örnek 3**: `status = 'submitted'` olan bir tx için `--force-drop --tx HASH` → 0 candidate. Beklenen: candidate seçilmeli.
- **Edge case**: `status = 'review_required'` olan tx için mevcut davranış değişmemeli; `getReviewRequiredTxs()` bu tx'i zaten seçiyor.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `--force-drop` flag'i olmadan `npm run reconcile` veya `npm run reconcile -- --fix` çalıştırıldığında `pending`/`included`/`submitted` tx'lere dokunulmamalı
- `--force-drop` explicit `--tx` veya `--block` filtresi olmadan kullanıldığında CLI hata verip çıkmaya devam etmeli (mevcut guard korunmalı)
- `review_required` statüsündeki tx'ler için mevcut `resolveReviewRequired()` ve `resolveForceDropTx()` akışları değişmemeli
- `txs.status = 'finalized'` veya `'successful_mint'` olan kayıtlara dokunulmamalı
- `getTransaction(txHash)` null değil ise force-drop reddedilmeye devam etmeli
- `getTransactionReceipt(txHash)` null değil ise force-drop reddedilmeye devam etmeli
- Aynı nonce veya block için başka active tx varsa force-drop reddedilmeye devam etmeli
- Dry-run modunda DB'ye hiçbir yazma yapılmamalı

**Scope:**
`opts.forceDrop = false` olan tüm çağrılar için `pending`/`included`/`submitted` tx'ler tamamen etkilenmez. Yalnızca `opts.forceDrop = true && opts.txFilter` kombinasyonu yeni davranışı tetikler.

---

## Hypothesized Root Cause

Bug'ın kökü `reconcileAll()` içindeki candidate seçim mantığında:

1. **Sabit candidate kaynağı**: `reconcileAll()` her zaman `getReviewRequiredTxs()` ile başlıyor. Bu sorgu `WHERE status = 'review_required'` filtresi uyguluyor. `pending`/`included`/`submitted` tx'ler bu sorguya dahil edilmiyor.

2. **txFilter sonradan uygulanıyor**: `opts.txFilter` filtresi `getReviewRequiredTxs()` sonucuna uygulanıyor. Hedef tx zaten `review_required` listesinde yoksa, hash filtresi uygulandıktan sonra boş liste kalıyor.

3. **resolveForceDropTx() status guard**: `resolveForceDropTx()` içinde `tx.status !== 'review_required'` kontrolü var. Candidate seçim sorunu çözülse bile, `pending` statüsündeki bir tx bu guard'a takılırdı.

4. **CLI guard doğru çalışıyor**: `--force-drop` için `--tx` veya `--block` zorunluluğu CLI'da doğru uygulanıyor. Bu guard değişmemeli.

---

## Correctness Properties

Property 1: Bug Condition — Pending TX Force-Drop Candidate Seçimi

_For any_ tx where `isBugCondition(X)` holds (`X.status IN ('pending', 'included', 'submitted')`, `opts.forceDrop = true`, `opts.txFilter = X.tx_hash`), the fixed `reconcileAll()` function SHALL include that tx in the candidate list (`report.total >= 1`) and run `resolveForceDropTx()` against it, returning a decision other than the implicit "0 candidates" non-result.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — Force-Drop Olmadan Pending TX'lere Dokunulmamalı

_For any_ tx where `X.status IN ('pending', 'included', 'submitted')` and `opts.forceDrop = false` (or `opts.txFilter` is not set), the fixed `reconcileAll()` function SHALL produce `report.total = 0` for these tx'ler, preserving the existing behavior that only `review_required` records are processed in normal reconcile runs.

**Validates: Requirements 3.1, 3.4, 3.5**

---

## Fix Implementation

### Changes Required

Mevcut root cause analizine göre iki minimal değişiklik gerekiyor:

**File 1**: `src/db.ts`

**New Function**: `getStuckTxByHash(txHash: string)`

**Implementation**:
```typescript
/**
 * Get a single tx by hash, regardless of status.
 * Used by force-drop resolution to find pending/included/submitted stuck txs.
 * Returns undefined if not found.
 */
export function getStuckTxByHash(txHash: string): {
  id: number;
  block: number;
  tx_hash: string;
  status: string;
  reason: string | null;
  updated_at: string;
  nonce: number;
} | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, block, tx_hash, status, reason, updated_at, nonce
       FROM txs
       WHERE tx_hash = ?
         AND status IN ('pending', 'included', 'submitted')
       LIMIT 1`
    )
    .get(txHash) as { ... } | undefined;
}
```

---

**File 2**: `src/reconciler.ts`

**Change 1 — reconcileAll() candidate seçimi genişletilmeli**:

`opts.forceDrop && opts.txFilter` durumunda, `getReviewRequiredTxs()` + filter sonucuna ek olarak `getStuckTxByHash(opts.txFilter)` çağrılır. Sonuç zaten listede yoksa eklenir (duplicate guard).

```
// Pseudocode
candidates = getReviewRequiredTxs()
if opts.blockFilter: candidates = candidates.filter(block)
if opts.txFilter: candidates = candidates.filter(txHash)

// NEW: force-drop için pending/included/submitted tx de ekle
if opts.forceDrop && opts.txFilter:
  stuckTx = getStuckTxByHash(opts.txFilter)
  if stuckTx && NOT already in candidates:
    candidates.push(stuckTx)
```

**Change 2 — resolveForceDropTx() status guard genişletilmeli**:

Mevcut `tx.status !== 'review_required'` guard'ı `pending`/`included`/`submitted`'ı da kabul edecek şekilde güncellenir:

```
// Mevcut (kısıtlayıcı):
if (tx.status !== 'review_required') → LEAVE_REVIEW_REQUIRED

// Yeni (genişletilmiş):
const FORCE_DROP_ELIGIBLE_STATUSES = ['review_required', 'pending', 'included', 'submitted']
if (!FORCE_DROP_ELIGIBLE_STATUSES.includes(tx.status)) → LEAVE_REVIEW_REQUIRED
```

**File 3**: `src/cli.ts` — **Değişiklik gerekmez**. Mevcut `--force-drop` guard ve output zaten doğru çalışıyor.

---

## Testing Strategy

### Validation Approach

İki aşamalı yaklaşım: önce bug'ı kanıtlayan exploration testi (unfixed code'da fail etmeli), sonra fix sonrası geçmesi gereken fix verification ve preservation testleri.

### Exploratory Bug Condition Checking

**Goal**: `pending` statüsündeki stuck tx için `--force-drop --tx HASH` çağrısının 0 candidate döndürdüğünü kanıtla. Unfixed code'da fail etmeli.

**Test Plan**: `reconcileAll({ forceDrop: true, txFilter: HASH, fixDropped: true })` çağrısında `pending` statüsündeki tx'in candidate listesine girmediğini göster. `getReviewRequiredTxs()` mock'u boş liste döndürür (tx `review_required` değil), `getStuckTxByHash()` henüz mevcut değil.

**Test Cases**:
1. **Pending TX Exploration**: `status = 'pending'` olan tx için `reconcileAll({ forceDrop: true, txFilter: tx.tx_hash })` → `report.total = 0` (unfixed code'da bu böyle — bug kanıtı)
2. **Included TX Exploration**: `status = 'included'` olan tx için aynı çağrı → `report.total = 0` (bug kanıtı)
3. **Submitted TX Exploration**: `status = 'submitted'` olan tx için aynı çağrı → `report.total = 0` (bug kanıtı)

**Expected Counterexamples**:
- `report.total = 0` — tx candidate listesine girmiyor
- `getStuckTxByHash` fonksiyonu mevcut değil (unfixed code'da import fail eder veya undefined döner)

### Fix Checking

**Goal**: Fix sonrası, `pending`/`included`/`submitted` tx'lerin force-drop candidate listesine girdiğini ve `resolveForceDropTx()` kararının döndüğünü doğrula.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := reconcileAll_fixed({ forceDrop: true, txFilter: X.tx_hash, fixDropped: true })
  ASSERT result.total >= 1
  ASSERT result.results[0].tx.tx_hash = X.tx_hash
  ASSERT result.results[0].decision IN (
    'MARK_DROPPED_RETRYABLE',
    'MARK_DROPPED_MINTED',
    'LEAVE_REVIEW_REQUIRED'  // safety check fail durumunda
  )
  // 0 candidate döndürmemeli
  ASSERT result.total != 0
END FOR
```

### Preservation Checking

**Goal**: `opts.forceDrop = false` durumunda `pending`/`included`/`submitted` tx'lerin seçilmediğini doğrula.

**Pseudocode:**
```
FOR ALL X WHERE X.status IN ('pending', 'included', 'submitted')
             AND opts.forceDrop = false DO
  result := reconcileAll_fixed(X, { forceDrop: false })
  ASSERT result.total = 0  // pending tx'ler seçilmemeli
  ASSERT X.status unchanged
END FOR
```

**Testing Approach**: Preservation için örnek tabanlı testler yeterli çünkü:
- Input uzayı küçük ve iyi tanımlı (`forceDrop=false` → pending tx seçilmez)
- Mevcut `reconciler.forceDrop.test.ts` testleri `review_required` akışını zaten kapsıyor
- Yeni preservation testleri `pending`/`included`/`submitted` statüslerini explicit olarak test etmeli

**Test Cases**:
1. **Preservation 1 — forceDrop=false**: `pending` tx için `reconcileAll({ forceDrop: false })` → `report.total = 0`
2. **Preservation 2 — no txFilter**: `pending` tx için `reconcileAll({ forceDrop: true })` (txFilter yok) → CLI guard devreye girer, DB'ye yazma yok
3. **Preservation 3 — review_required unchanged**: `review_required` tx için mevcut `resolveForceDropTx()` akışı değişmemeli
4. **Preservation 4 — dry-run**: `pending` tx için `reconcileAll({ forceDrop: true, txFilter: HASH, dryRun: true })` → DB'ye yazma yok

### Unit Tests

- `getStuckTxByHash()` fonksiyonu: `pending`/`included`/`submitted` tx döndürmeli; `review_required`/`finalized` için undefined döndürmeli
- `reconcileAll()` candidate seçimi: `forceDrop=true && txFilter` durumunda `pending` tx eklenmeli
- `resolveForceDropTx()` status guard: `pending`/`included`/`submitted` statüsleri kabul edilmeli; `finalized`/`dropped` reddedilmeli

### Property-Based Tests

- `forceDrop=false` olan tüm çağrılar için `pending`/`included`/`submitted` tx'ler seçilmemeli (status değişmemeli)
- `forceDrop=true && txFilter=HASH` olan çağrılar için hedef tx her zaman candidate listesinde olmalı (status `pending`/`included`/`submitted`/`review_required` ise)
- Safety check'ler geçilmediğinde (getTransaction not null, receipt not null, vb.) `LEAVE_REVIEW_REQUIRED` dönmeli — bu mevcut `reconciler.forceDrop.test.ts` testleri tarafından zaten kapsanıyor

### Integration Tests

- Production senaryosu: Block 24987965, tx `0x3fc11effe...`, `status = 'pending'` → `--force-drop --tx HASH` → 1 candidate, tüm safety check'ler çalışıyor
- `--force-drop` olmadan `npm run reconcile` → `pending` tx'lere dokunulmuyor
- Fix sonrası `npm run pending` → force-drop uygulanan tx listelenmemeli
- Fix sonrası `isBlockSubmittedOrBeyond(block)` → `false` (block retryable)
