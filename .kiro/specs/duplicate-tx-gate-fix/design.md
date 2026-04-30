# Duplicate TX Gate Fix — Bugfix Design

## Overview

`MintExecutor` içindeki Gate 9 (`duplicate_tx` gate), `getTxByBlock(block)` ile bir tx kaydı
bulduğunda tx'in `status` değerine bakmaksızın her zaman mint işlemini engelliyor. Bu tasarım
dokümanı, fix'in kapsamını, doğruluk özelliklerini ve test stratejisini tanımlar.

**Fix yaklaşımı:** `src/mintExecutor.ts` içindeki Gate 9 koşuluna tek satırlık bir status filtresi
eklenir. Yalnızca aktif statüsteki (`pending`, `submitted`, `included`, `finalized`,
`successful_mint`) tx'ler duplicate olarak değerlendirilir; terminal statüsteki (`dropped`,
`failed`) tx'ler geçişe izin verir.

**Etkilenen dosya:** Yalnızca `src/mintExecutor.ts` — başka hiçbir dosya değişmez.

---

## Glossary

- **Bug_Condition (C)**: Gate 9'un yanlış bloklamaya neden olduğu durum — `getTxByBlock(block)`
  bir tx kaydı döndürdüğünde ve `existingTx.status IN ('dropped', 'failed')` olduğunda
- **Property (P)**: Terminal statüsteki tx varlığında beklenen doğru davranış — Gate 9 geçilmeli,
  mint işlemi devam etmeli
- **Preservation**: Aktif statüsteki tx'ler için mevcut bloklama davranışı değişmemeli
- **ACTIVE_TX_STATUSES**: `['pending', 'submitted', 'included', 'finalized', 'successful_mint']` —
  duplicate guard'ın bloklaması gereken statüsler
- **Terminal statüs**: `'dropped'` veya `'failed'` — artık aktif olmayan, çözümlenmiş tx statüsleri
- **`getTxByBlock(block)`**: `src/db.ts` içinde, verilen block için `txs` tablosundan en son tx
  kaydını döndüren fonksiyon
- **Gate 9**: `src/mintExecutor.ts` içindeki duplicate tx önleme kapısı; `txs` tablosunu kontrol
  eder
- **`execute(blockResult, opts)`**: `src/mintExecutor.ts` içindeki ana mint fonksiyonu; tüm
  gate'leri sırayla çalıştırır

---

## Bug Details

### Bug Condition

Bug, `getTxByBlock(block)` bir tx kaydı döndürdüğünde ve bu kaydın `status` değeri `'dropped'`
veya `'failed'` olduğunda tetiklenir. Mevcut Gate 9 implementasyonu `existingTx` varlığını
kontrol eder ancak `existingTx.status` değerini görmezden gelir; bu nedenle terminal statüsteki
tx'ler aktif duplicate gibi değerlendirilir.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type { tx_hash: string; status: string; nonce: number }
         (getTxByBlock(block) dönüş değeri)
  OUTPUT: boolean

  RETURN X.status IN ('dropped', 'failed')
END FUNCTION
```

### Examples

- **Dropped TX (production örneği):** Block 24987965, tx `0x3fc11effe...` force-drop ile
  `dropped` statüsüne alındı, block `retryable` yapıldı, EDMT `mintable` döndürüyor.
  **Mevcut:** Gate 9 `skipped_duplicate_tx` döndürüyor.
  **Beklenen:** Gate 9 geçilmeli, mint devam etmeli.

- **Failed TX:** Block X için tx `failed` statüsünde. Block yeniden mintable oldu.
  **Mevcut:** Gate 9 `skipped_duplicate_tx` döndürüyor.
  **Beklenen:** Gate 9 geçilmeli, mint devam etmeli.

- **Pending TX (korunmalı):** Block Y için tx `pending` statüsünde.
  **Mevcut:** Gate 9 `skipped_duplicate_tx` döndürüyor.
  **Beklenen:** Aynı — `skipped_duplicate_tx` döndürmeye devam etmeli.

- **No TX (korunmalı):** Block Z için hiç tx kaydı yok.
  **Mevcut:** Gate 9 geçiliyor.
  **Beklenen:** Aynı — Gate 9 geçilmeye devam etmeli.

---

## Expected Behavior

### Preservation Requirements

**Değişmemesi gereken davranışlar:**

- `existingTx.status = 'pending'` → `skipped_duplicate_tx` döndürmeye DEVAM ETMELİ
- `existingTx.status = 'submitted'` → `skipped_duplicate_tx` döndürmeye DEVAM ETMELİ
- `existingTx.status = 'included'` → `skipped_duplicate_tx` döndürmeye DEVAM ETMELİ
- `existingTx.status = 'finalized'` → `skipped_duplicate_tx` döndürmeye DEVAM ETMELİ
- `existingTx.status = 'successful_mint'` → `skipped_duplicate_tx` döndürmeye DEVAM ETMELİ
- `getTxByBlock(block)` `undefined` döndürdüğünde → Gate 9 geçilmeye DEVAM ETMELİ
- Pipeline mode `isBlockSubmittedOrBeyond` gate'i → bağımsız çalışmaya DEVAM ETMELİ (bu fix
  pipeline gate'e dokunmaz)

**Kapsam:**

`ACTIVE_TX_STATUSES` listesinde yer alan statüslere sahip tx'ler için Gate 9 davranışı
değişmez. Yalnızca `dropped` ve `failed` statüsleri için Gate 9 artık bloklamaz.

---

## Hypothesized Root Cause

Mevcut Gate 9 implementasyonu (`src/mintExecutor.ts`, ~satır 185-198):

```typescript
const existingTx = getTxByBlock(block);
if (existingTx) {
  logger.warn({ ..., existingStatus: existingTx.status }, `Duplicate tx prevented...`);
  return { block, status: "skipped_duplicate_tx", ... };
}
```

**Kök neden:** `if (existingTx)` koşulu yalnızca kaydın varlığını kontrol eder; `existingTx.status`
değerini değerlendirmez. `dropped` ve `failed` statüsleri terminal/çözümlenmiş statüsler olmasına
rağmen aktif duplicate gibi muamele görür.

**Neden bu şekilde yazıldı:** Gate 9 ilk implementasyonunda `TxStatus` tipine `'dropped'` ve
`'failed'` statüsleri eklenmemişti ya da force-drop akışı henüz tasarlanmamıştı. Duplicate guard
başlangıçta "herhangi bir tx kaydı varsa engelle" mantığıyla yazıldı.

---

## Correctness Properties

Property 1: Bug Condition — Terminal Statüsteki TX Mint'i Engellememelidir

_For any_ `blockResult` where `getTxByBlock(blockResult.block)` returns a record `X` and
`isBugCondition(X)` is true (i.e., `X.status IN ('dropped', 'failed')`), the fixed `execute`
function SHALL NOT return `{ status: 'skipped_duplicate_tx' }` due to Gate 9. The function
SHALL pass Gate 9 and continue to subsequent gates.

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation — Aktif Statüsteki TX'ler Hâlâ Bloklanmalıdır

_For any_ `blockResult` where `getTxByBlock(blockResult.block)` returns a record `X` and
`X.status IN ('pending', 'submitted', 'included', 'finalized', 'successful_mint')`, the fixed
`execute` function SHALL return `{ status: 'skipped_duplicate_tx' }`, preserving the existing
duplicate prevention behavior for all active transaction statuses.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

---

## Fix Implementation

### Changes Required

**Dosya:** `src/mintExecutor.ts`

**Fonksiyon:** `execute`

**Gate 9 — Mevcut (hatalı):**

```typescript
const existingTx = getTxByBlock(block);
if (existingTx) {
  logger.warn(
    {
      event: LogEvent.MINT_GATE_FAILED,
      block,
      gate: "duplicate_tx",
      existingTxHash: existingTx.tx_hash,
      existingStatus: existingTx.status,
    },
    `Duplicate tx prevented for block ${block} — existing tx: ${existingTx.tx_hash}`
  );
  return {
    block,
    status: "skipped_duplicate_tx",
    reason: `Existing tx ${existingTx.tx_hash} (${existingTx.status}) for block ${block}`,
  };
}
```

**Gate 9 — Yeni (doğru):**

```typescript
const ACTIVE_TX_STATUSES = ['pending', 'submitted', 'included', 'finalized', 'successful_mint'];
const existingTx = getTxByBlock(block);
if (existingTx && ACTIVE_TX_STATUSES.includes(existingTx.status)) {
  logger.warn(
    {
      event: LogEvent.MINT_GATE_FAILED,
      block,
      gate: "duplicate_tx",
      existingTxHash: existingTx.tx_hash,
      existingStatus: existingTx.status,
    },
    `Duplicate tx prevented for block ${block} — existing tx: ${existingTx.tx_hash}`
  );
  return {
    block,
    status: "skipped_duplicate_tx",
    reason: `Existing tx ${existingTx.tx_hash} (${existingTx.status}) for block ${block}`,
  };
}
// dropped/failed → fall through, allow new mint attempt
```

**Spesifik değişiklikler:**

1. **`ACTIVE_TX_STATUSES` sabiti eklenir:** Gate 9 bloğunun hemen üstüne, fonksiyon scope'unda
   tanımlanır. Değer: `['pending', 'submitted', 'included', 'finalized', 'successful_mint']`

2. **`if (existingTx)` → `if (existingTx && ACTIVE_TX_STATUSES.includes(existingTx.status))`:**
   Tek satır değişikliği. Başka hiçbir şey değişmez.

3. **Başka dosya değişikliği yok:** `src/db.ts`, `src/types.ts`, test dosyaları veya diğer
   modüller değişmez.

---

## Testing Strategy

### Validation Approach

Test stratejisi iki aşamalıdır:

1. **Exploration (unfixed code):** Bug'ı kanıtlayan counterexample'lar üretilir. `dropped` statüslü
   tx varken `execute` çağrıldığında `skipped_duplicate_tx` döndüğü gözlemlenir.
2. **Fix + Preservation (fixed code):** Fix uygulandıktan sonra hem bug condition hem de
   preservation property'leri doğrulanır.

### Exploratory Bug Condition Checking

**Hedef:** Fix uygulanmadan önce bug'ı kanıtlayan counterexample'ları yüzeye çıkarmak.
Root cause analizini doğrulamak veya çürütmek.

**Test planı:** `getTxByBlock` mock'u `{ tx_hash: '0x...', status: 'dropped', nonce: 42 }`
döndürecek şekilde ayarlanır. `execute(mintableBlock)` çağrılır. Unfixed code'da
`result.status === 'skipped_duplicate_tx'` beklenir — bu bug'ın kanıtıdır.

**Test dosyası:** `tests/mintExecutor.duplicateTxGate.exploration.test.ts`

**Test cases:**

1. **Dropped TX Exploration:** `existingTx.status = 'dropped'` → unfixed code'da
   `skipped_duplicate_tx` döner (FAIL beklenir fix sonrası, PASS beklenir unfixed'ta)
2. **Failed TX Exploration:** `existingTx.status = 'failed'` → unfixed code'da
   `skipped_duplicate_tx` döner (FAIL beklenir fix sonrası, PASS beklenir unfixed'ta)

**Beklenen counterexample'lar:**

- `dropped` statüslü tx varken `execute` → `skipped_duplicate_tx` döner (bug kanıtı)
- `failed` statüslü tx varken `execute` → `skipped_duplicate_tx` döner (bug kanıtı)

### Fix Checking

**Hedef:** Bug condition'ı karşılayan tüm input'lar için fixed fonksiyonun beklenen davranışı
ürettiğini doğrulamak.

**Pseudocode:**

```
FOR ALL blockResult WHERE isBugCondition(getTxByBlock(blockResult.block)) DO
  result := execute_fixed(blockResult)
  ASSERT result.status != 'skipped_duplicate_tx'
END FOR
```

**Test cases:**

- `existingTx.status = 'dropped'` → `result.status` ≠ `'skipped_duplicate_tx'`
- `existingTx.status = 'failed'` → `result.status` ≠ `'skipped_duplicate_tx'`

### Preservation Checking

**Hedef:** Bug condition'ı karşılamayan input'lar için fixed fonksiyonun orijinal fonksiyonla
aynı sonucu ürettiğini doğrulamak.

**Pseudocode:**

```
FOR ALL blockResult WHERE NOT isBugCondition(getTxByBlock(blockResult.block))
                      AND getTxByBlock(blockResult.block).status IN ACTIVE_TX_STATUSES DO
  ASSERT execute_original(blockResult) = execute_fixed(blockResult)
  // Her ikisi de 'skipped_duplicate_tx' döndürmeli
END FOR
```

**Testing approach:** Property-based testing önerilir çünkü:
- `ACTIVE_TX_STATUSES` listesindeki tüm statüsler için otomatik test üretir
- Manuel unit test'lerin kaçırabileceği edge case'leri yakalar
- Fix'in aktif statüsler için davranışı değiştirmediğine dair güçlü garanti sağlar

**Test dosyası:** `tests/mintExecutor.duplicateTxGate.preservation.test.ts`

**Test cases:**

1. **Pending TX Preservation:** `existingTx.status = 'pending'` → `skipped_duplicate_tx`
   döndürmeye devam etmeli
2. **Submitted TX Preservation:** `existingTx.status = 'submitted'` → `skipped_duplicate_tx`
   döndürmeye devam etmeli
3. **Included TX Preservation:** `existingTx.status = 'included'` → `skipped_duplicate_tx`
   döndürmeye devam etmeli
4. **Finalized TX Preservation:** `existingTx.status = 'finalized'` → `skipped_duplicate_tx`
   döndürmeye devam etmeli
5. **Successful Mint TX Preservation:** `existingTx.status = 'successful_mint'` →
   `skipped_duplicate_tx` döndürmeye devam etmeli
6. **No TX Preservation:** `getTxByBlock` `undefined` döndürdüğünde → Gate 9 geçilmeye devam
   etmeli

### Unit Tests

- `existingTx.status = 'dropped'` → Gate 9 geçilir, mint devam eder
- `existingTx.status = 'failed'` → Gate 9 geçilir, mint devam eder
- `existingTx.status = 'pending'` → `skipped_duplicate_tx` döner
- `existingTx.status = 'submitted'` → `skipped_duplicate_tx` döner
- `existingTx.status = 'included'` → `skipped_duplicate_tx` döner
- `existingTx.status = 'finalized'` → `skipped_duplicate_tx` döner
- `existingTx.status = 'successful_mint'` → `skipped_duplicate_tx` döner
- `getTxByBlock` `undefined` döndürdüğünde → Gate 9 geçilir

### Property-Based Tests

- `ACTIVE_TX_STATUSES` listesindeki rastgele statüsler için `skipped_duplicate_tx` döndüğünü
  doğrula (preservation property)
- Terminal statüsler (`dropped`, `failed`) için Gate 9'un geçildiğini doğrula (fix property)
- `getTxByBlock` `undefined` döndürdüğünde Gate 9'un geçildiğini doğrula

### Integration Tests

- Force-drop + retryable akışı: tx `dropped` yapılır, block `retryable` yapılır, yeni mint
  denemesi başarılı olur
- Mevcut `mintExecutor.test.ts` Test 11 (duplicate tx prevention) hâlâ geçer — `pending` statüslü
  tx için `skipped_duplicate_tx` döner
- Pipeline mode gate'i (`isBlockSubmittedOrBeyond`) bu fix'ten etkilenmez
