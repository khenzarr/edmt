# Review Required Resolution — Bugfix Design

## Overview

Automint oturumu, `txs` tablosunda `status = 'review_required'` olan herhangi bir kayıt
bulunduğunda `hasReviewRequiredTx()` kontrolünden `true` döndüğü için başlamayı reddediyor.
Bu kayıtların bir kısmı aslında zincirde başarıyla finalize edilmiş durumda; ancak geçici
EDMT API erişim sorunları, owner mismatch şüphesi veya uzun süre bekleyen tx gibi nedenlerle
doğrulama adımı tamamlanamamış.

Bu bugfix, `review_required` kayıtları çok adımlı, kanıta dayalı bir reconciliation süreci
ile inceleyip gerçekten finalize edilmiş olanları `finalized` / `successful_mint` statüsüne
geçirir. Hiçbir on-chain işlem gönderilmez; yalnızca DB güncellenir. Kanıt yoksa statü
yükseltilmez.

**Etkilenen tablolar:** `txs`, `block_results`, `checkpoints`  
**Yeni CLI komutu:** `npm run reconcile`  
**Yeni config değişkenleri:** `AUTO_RECONCILE_REVIEW_REQUIRED`, `RECONCILE_REQUIRE_FINALITY`,
`RECONCILE_MIN_CONFIRMATIONS`

---

## Glossary

- **Bug_Condition (C)**: `txs.status = 'review_required'` olan bir kaydın zincirde
  `receipt.status = 1` ile finalize edilmiş, EDMT API'de `minted_by` bizim wallet adresimizle
  eşleşiyor ve `mint_tx_hash` aynı olduğu durum.
- **Property (P)**: Bug condition sağlandığında beklenen doğru davranış — kaydın
  `txs.status = 'finalized'` ve `block_results.status = 'successful_mint'` olarak
  güncellenmesi.
- **Preservation**: Doğrulanamayan `review_required` kayıtların değişmeden kalması ve
  automint'i engellemeye devam etmesi; mevcut `pending`, `included`, `finalized`,
  `successful_mint` kayıtlarına dokunulmaması.
- **resolveReviewRequired(X)**: `src/reconciler.ts` içinde tanımlanacak, tek bir
  `review_required` kaydı için tüm doğrulama adımlarını çalıştıran fonksiyon.
- **reconcileAll()**: Tüm `review_required` kayıtları sırayla işleyen üst düzey fonksiyon.
- **isBugCondition(X)**: Bir `TxRecord`'un bug condition'ı sağlayıp sağlamadığını belirleyen
  pseudocode fonksiyonu (aşağıda tanımlı).
- **dry-run modu**: DB'ye hiçbir yazma yapılmadan reconcile kararlarının raporlandığı mod.
- **fix modu**: DB güncellemelerinin gerçekten uygulandığı mod (`--fix` flag'i ile aktif).
- **walletAddress**: `ethClient.getWallet().address` — EDMT API owner karşılaştırmasında
  kullanılan adres.
- **RECONCILE_REQUIRE_FINALITY**: `true` ise yeterli confirmation olmadan statü
  yükseltilmez.
- **RECONCILE_MIN_CONFIRMATIONS**: Finality için gereken minimum blok onay sayısı
  (varsayılan: 64).

---

## Bug Details

### Bug Condition

Bug, `txs` tablosunda `status = 'review_required'` olan bir kaydın zincirde başarıyla
finalize edilmiş olmasına rağmen sistemin bunu doğrulamaması durumunda tetiklenir.
`hasReviewRequiredTx()` fonksiyonu yalnızca sayım yapar; kaydın gerçekten sorunlu mu yoksa
sadece doğrulanmamış mı olduğunu ayırt etmez.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type TxRecord  (txs tablosundan bir satır)
  OUTPUT: boolean

  // Bug tetiklenir: tx review_required statüsünde VE zincirde başarıyla finalize edilmiş
  RETURN X.status = 'review_required'
         AND X.tx_hash IS NOT NULL
         AND receipt(X.tx_hash).status = 1
         AND edmt_api(X.block).minted_by = walletAddress          // owner match
         AND edmt_api(X.block).mint_tx_hash = X.tx_hash           // tx hash match
         AND (NOT RECONCILE_REQUIRE_FINALITY
              OR confirmations(X.tx_hash) >= RECONCILE_MIN_CONFIRMATIONS)
END FUNCTION
```

### Examples

- **Örnek 1 — Başarılı reconcile**: Block 24973104, tx hash `0xb35d...`, receipt.status=1,
  EDMT API `minted_by = 0x16fc...` (bizim wallet), `mint_tx_hash` eşleşiyor, 128 confirmation.
  → `txs.status = 'finalized'`, `block_results.status = 'successful_mint'` ✅

- **Örnek 2 — Receipt yok**: Block 25000000, tx hash mevcut ama receipt henüz yok.
  → `review_required` olarak bırakılır, raporda `receipt_missing` nedeni gösterilir ⏳

- **Örnek 3 — Receipt failed**: Block 25000001, receipt.status=0.
  → `txs.status = 'failed'` veya `review_required` olarak bırakılır, raporda
  `receipt_failed` nedeni gösterilir ❌

- **Örnek 4 — Owner mismatch**: Block 25000002, receipt.status=1 ama EDMT API
  `minted_by = 0xABCD...` (başka bir wallet).
  → `review_required` olarak bırakılır, raporda `owner_mismatch` nedeni gösterilir 🔒

- **Örnek 5 — TX hash mismatch**: Block 25000003, receipt.status=1, owner eşleşiyor ama
  EDMT API `mint_tx_hash` farklı bir hash döndürüyor.
  → `review_required` olarak bırakılır, raporda `tx_hash_mismatch` nedeni gösterilir 🔒

- **Örnek 6 — Yeterli confirmation yok**: Block 25000004, tüm kontroller geçiyor ama
  `RECONCILE_REQUIRE_FINALITY=true` ve yalnızca 10 confirmation var.
  → `review_required` olarak bırakılır, raporda `insufficient_confirmations` nedeni
  gösterilir ⏳

---

## Expected Behavior

### Preservation Requirements

**Değişmeden kalması gereken davranışlar:**

- `txs.status IN ('pending', 'included')` olan kayıtlar `TxMonitor.poll()` tarafından
  normal lifecycle'ına göre işlenmeye devam etmeli; reconciler bu kayıtlara dokunmamalı.
- `block_results.status IN ('successful_mint', 'finalized')` olan kayıtlar reconciler
  tarafından değiştirilmemeli.
- `autoMintStopOnReviewRequired = true` konfigürasyonu aktifken yeni oluşan
  `review_required` kayıtları hâlâ automint'i durdurmalı.
- `last_successful_mint_block` checkpoint'i zaten daha yüksek bir değere sahipse
  güncellenmemeli.
- Receipt.status ≠ 1 olan kayıtlar `review_required` veya `failed` olarak kalmalı;
  `finalized`/`successful_mint`'e yükseltilmemeli.
- EDMT API owner mismatch durumunda kayıt `review_required` olarak kalmalı.
- TX hash mismatch durumunda kayıt `review_required` olarak kalmalı.
- Dry-run modunda DB'ye hiçbir yazma yapılmamalı.

**Kapsam:**

Bug condition'ı sağlamayan tüm `review_required` kayıtlar (receipt yok, receipt failed,
owner mismatch, tx hash mismatch, yetersiz confirmation) değişmeden kalmalı ve automint'i
engellemeye devam etmeli.

---

## Hypothesized Root Cause

Bug description ve mevcut kod analizi temelinde en olası nedenler:

1. **`hasReviewRequiredTx()` kör sayım yapıyor**: `src/db.ts` içindeki fonksiyon yalnızca
   `COUNT(*) WHERE status = 'review_required'` sorgular; kaydın gerçekten sorunlu mu yoksa
   sadece doğrulanmamış mı olduğunu ayırt etmez. Automint başlamadan önce bu kayıtları
   reconcile etme mekanizması yoktur.

2. **`TxMonitor.verifyOwnership()` geçici hatalarda `review_required` bırakıyor**: EDMT API
   geçici olarak erişilemez olduğunda (`status = 'unknown'`) veya beklenmedik bir statü
   döndürdüğünde tx `review_required` olarak işaretleniyor. Bu kayıtlar daha sonra otomatik
   olarak yeniden kontrol edilmiyor.

3. **Reconcile mekanizması yok**: Mevcut `scripts/reconcile-db.mjs` tek bir hardcoded kaydı
   manuel olarak düzeltiyor. Genel amaçlı, kanıta dayalı, otomatik bir reconcile akışı
   bulunmuyor.

4. **Automint startup'ta reconcile denemesi yok**: `runAutoMint()` içinde
   `hasReviewRequiredTx()` kontrolü `true` döndürdüğünde direkt `review_required_detected`
   ile durduruluyor; önce reconcile deneme seçeneği sunulmuyor.

5. **`reason` alanı güncellenmeden kalıyor**: `review_required` olarak işaretlenen kayıtların
   `reason` alanı ilk atamadan sonra güncellenmediği için neden `review_required` kaldığı
   takip edilemiyor.

---

## Correctness Properties

Property 1: Bug Condition — Review Required Reconciliation

_For any_ `TxRecord` X where `isBugCondition(X)` returns true (status = 'review_required',
receipt.status = 1, EDMT owner match, tx hash match, sufficient confirmations), the fixed
`resolveReviewRequired(X)` function SHALL update `txs.status` to `'finalized'`,
`block_results.status` to `'successful_mint'`, and update `last_successful_mint_block`
checkpoint if the block number is greater than the current checkpoint value.

**Validates: Requirements 2.1, 2.2, 2.4**

Property 2: Preservation — Unresolvable Records Stay Review Required

_For any_ `TxRecord` X where `isBugCondition(X)` returns false (receipt missing, receipt
failed, owner mismatch, tx hash mismatch, or insufficient confirmations), the fixed
`resolveReviewRequired(X)` function SHALL leave `txs.status` as `'review_required'`,
`hasReviewRequiredTx()` SHALL continue to return `true`, and automint SHALL NOT start.

**Validates: Requirements 2.3, 3.1, 3.2, 3.5**

---

## Fix Implementation

### Changes Required

Aşağıdaki değişiklikler root cause analizimizin doğru olduğu varsayımıyla planlanmıştır.
Exploratory testler farklı bir root cause ortaya koyarsa bu plan revize edilecektir.

---

**Dosya 1:** `src/reconciler.ts` *(yeni dosya)*

**Açıklama:** Tüm reconcile mantığını içeren yeni modül.

**Fonksiyonlar:**

1. **`resolveReviewRequired(tx, opts)`** — Tek bir `review_required` kaydı için
   reconcile akışını çalıştırır:
   - `getTransactionReceipt(tx.tx_hash)` çağırır
   - Receipt yoksa → `ReconcileDecision.LEAVE_REVIEW_REQUIRED` (reason: `receipt_missing`)
   - `receipt.status !== 1` → `ReconcileDecision.MARK_FAILED` veya
     `LEAVE_REVIEW_REQUIRED` (reason: `receipt_failed`)
   - `receipt.status === 1` → `getBlockStatus(tx.block)` çağırır
   - EDMT API erişilemiyorsa → `LEAVE_REVIEW_REQUIRED` (reason: `edmt_api_unavailable`)
   - `minted_by !== walletAddress` → `LEAVE_REVIEW_REQUIRED` (reason: `owner_mismatch`)
   - `mint_tx_hash !== tx.tx_hash` → `LEAVE_REVIEW_REQUIRED` (reason: `tx_hash_mismatch`)
   - `RECONCILE_REQUIRE_FINALITY=true` ve yetersiz confirmation →
     `LEAVE_REVIEW_REQUIRED` (reason: `insufficient_confirmations`)
   - Tüm kontroller geçerse → `ReconcileDecision.MARK_FINALIZED`

2. **`reconcileAll(opts)`** — Tüm `review_required` kayıtları sırayla işler, rapor döndürür.

3. **`applyDecision(tx, decision, opts)`** — `dry-run` modunda sadece loglar; `fix` modunda
   DB'yi günceller:
   - `txs.status = 'finalized'`
   - `block_results.status = 'successful_mint'`
   - `last_successful_mint_block` checkpoint'ini gerekirse günceller
   - `high_burn_candidates.status = 'finalized'` (varsa)

---

**Dosya 2:** `src/config.ts` *(güncelleme)*

**Yeni config değişkenleri:**

```typescript
autoReconcileReviewRequired: parseBoolEnv("AUTO_RECONCILE_REVIEW_REQUIRED", false),
reconcileRequireFinality:    parseBoolEnv("RECONCILE_REQUIRE_FINALITY", true),
reconcileMinConfirmations:   parseIntEnv("RECONCILE_MIN_CONFIRMATIONS", 64),
```

---

**Dosya 3:** `src/autoMintRunner.ts` *(güncelleme)*

**Değişiklik:** `runAutoMint()` içinde `hasReviewRequiredTx()` kontrolünden önce:

```typescript
if (config.autoReconcileReviewRequired && hasReviewRequiredTx()) {
  logger.info({ event: LogEvent.RECONCILE_STARTED }, "AutoMint: attempting auto-reconcile...");
  const report = await reconcileAll({ dryRun: false, fix: true });
  logger.info({ event: LogEvent.RECONCILE_FINISHED, report }, "AutoMint: reconcile complete");
}
// Ardından mevcut hasReviewRequiredTx() kontrolü çalışır
```

---

**Dosya 4:** `src/cli.ts` *(güncelleme)*

**Yeni komut:** `reconcile`

```
npm run reconcile                    # dry-run (varsayılan)
npm run reconcile -- --dry-run       # açık dry-run
npm run reconcile -- --fix           # DB güncellemelerini uygula
npm run reconcile -- --block <N>     # tek blok reconcile
npm run reconcile -- --tx <TX_HASH>  # tek tx reconcile
```

---

**Dosya 5:** `src/db.ts` *(güncelleme)*

**Yeni fonksiyonlar:**

- `getReviewRequiredTxs()` — Tüm `review_required` tx kayıtlarını döndürür (block, tx_hash,
  reason, updated_at dahil).
- `updateTxStatusWithReason(txHash, status, reason)` — Status ve reason alanını birlikte
  günceller.

**Opsiyonel yeni tablo:** `reconcile_events` — Reconcile geçmişini kayıt altına almak için.
Mevcut schema yeterliyse eklenmeyebilir; ancak audit trail için önerilir.

```sql
CREATE TABLE IF NOT EXISTS reconcile_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  block           INTEGER NOT NULL,
  tx_hash         TEXT    NOT NULL,
  previous_status TEXT    NOT NULL,
  new_status      TEXT    NOT NULL,
  decision        TEXT    NOT NULL,
  reason          TEXT,
  created_at      TEXT    NOT NULL
);
```

---

**Dosya 6:** `src/logger.ts` *(güncelleme)*

**Yeni LogEvent değerleri:**

```typescript
RECONCILE_STARTED:              "reconcile_started",
RECONCILE_CANDIDATE_FOUND:      "reconcile_candidate_found",
RECONCILE_RECEIPT_MISSING:      "reconcile_receipt_missing",
RECONCILE_RECEIPT_FAILED:       "reconcile_receipt_failed",
RECONCILE_EDMT_VERIFIED:        "reconcile_edmt_verified",
RECONCILE_OWNER_MISMATCH:       "reconcile_owner_mismatch",
RECONCILE_TX_HASH_MISMATCH:     "reconcile_tx_hash_mismatch",
RECONCILE_FINALIZED:            "reconcile_finalized",
RECONCILE_LEFT_REVIEW_REQUIRED: "reconcile_left_review_required",
RECONCILE_FINISHED:             "reconcile_finished",
```

---

**Dosya 7:** `package.json` *(güncelleme)*

```json
"reconcile": "node --loader ts-node/esm src/cli.ts reconcile"
```

---

**Dosya 8:** `.env.example` *(güncelleme)*

```env
# Review Required Reconciliation
AUTO_RECONCILE_REVIEW_REQUIRED=false
RECONCILE_REQUIRE_FINALITY=true
RECONCILE_MIN_CONFIRMATIONS=64
```

---

## Testing Strategy

### Validation Approach

Test stratejisi iki aşamalıdır:

1. **Exploratory (Bug Condition Checking)**: Unfixed kod üzerinde bug'ı gösteren testler
   yazılır. Bu testler başarısız olmalı — root cause analizini doğrular.
2. **Fix + Preservation Checking**: Fix uygulandıktan sonra hem bug condition'ın
   düzeldiği hem de mevcut davranışın korunduğu doğrulanır.

### Exploratory Bug Condition Checking

**Hedef:** Fix uygulanmadan önce bug'ı somut olarak göster; root cause analizini doğrula
veya çürüt.

**Test Planı:** `review_required` statüsünde bir tx kaydı oluştur, receipt mock'la
`status=1` döndür, EDMT API mock'la owner match döndür. Mevcut `runAutoMint()` akışının
bu kaydı reconcile etmeden `review_required_detected` ile durduğunu gözlemle.

**Test Senaryoları:**

1. **Mevcut automint bloğu**: `review_required` kayıt var, `AUTO_RECONCILE_REVIEW_REQUIRED=false`
   → `runAutoMint()` `review_required_detected` döndürür (unfixed kodda beklenen davranış)
2. **Reconcile fonksiyonu yok**: `resolveReviewRequired` fonksiyonu mevcut değil → import
   hatası (unfixed kodda beklenen)
3. **DB güncelleme yok**: Receipt=1, owner match olmasına rağmen `txs.status` hâlâ
   `review_required` kalıyor (unfixed kodda beklenen)

**Beklenen Counterexample'lar:**

- `runAutoMint()` her zaman `review_required_detected` döndürür; receipt veya EDMT
  durumuna bakmaksızın.
- Olası nedenler: reconcile mekanizması yok, `hasReviewRequiredTx()` kör sayım yapıyor.

### Fix Checking

**Hedef:** Bug condition sağlayan tüm girdiler için fixed fonksiyonun beklenen davranışı
ürettiğini doğrula.

**Pseudocode:**

```
FOR ALL X WHERE isBugCondition(X) DO
  result := resolveReviewRequired_fixed(X)
  ASSERT result.decision = 'MARK_FINALIZED'
  ASSERT txs[X.tx_hash].status = 'finalized'
  ASSERT block_results[X.block].status = 'successful_mint'
  ASSERT hasReviewRequiredTx() = false  // automint artık başlayabilmeli
END FOR
```

### Preservation Checking

**Hedef:** Bug condition sağlamayan tüm girdiler için fixed fonksiyonun orijinal fonksiyonla
aynı sonucu ürettiğini doğrula.

**Pseudocode:**

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT resolveReviewRequired_fixed(X).decision = 'LEAVE_REVIEW_REQUIRED'
         OR resolveReviewRequired_fixed(X).decision = 'MARK_FAILED'
  ASSERT hasReviewRequiredTx() = true   // automint hâlâ engellenmeli
END FOR
```

**Test Yaklaşımı:** Property-based testing önerilir çünkü:
- Geniş girdi uzayında otomatik test senaryoları üretir
- Manuel testlerin kaçırabileceği edge case'leri yakalar
- Non-buggy girdiler için davranışın değişmediğine dair güçlü garanti sağlar

### Unit Tests

`tests/reconciler.test.ts` dosyasında en az şu test senaryoları yer almalıdır:

| # | Senaryo | Beklenen Sonuç |
|---|---------|----------------|
| 1 | Receipt missing | `review_required` kalır, reason: `receipt_missing` |
| 2 | Receipt status=0 | `failed` veya `review_required` kalır, reason: `receipt_failed` |
| 3 | Receipt status=1 + owner match + tx hash match + yeterli confirmation | `finalized` / `successful_mint` olur |
| 4 | Owner mismatch | `review_required` kalır, reason: `owner_mismatch` |
| 5 | TX hash mismatch | `review_required` kalır, reason: `tx_hash_mismatch` |
| 6 | `RECONCILE_REQUIRE_FINALITY=true` + yetersiz confirmation | `review_required` kalır, reason: `insufficient_confirmations` |
| 7 | `RECONCILE_REQUIRE_FINALITY=false` + az confirmation | `finalized` / `successful_mint` olur |
| 8 | Dry-run mode | DB değişmez, karar raporda gösterilir |
| 9 | Fix mode | DB güncellenir |
| 10 | EDMT API erişilemiyor | `review_required` kalır, reason: `edmt_api_unavailable` |
| 11 | `last_successful_mint_block` zaten daha yüksek | Checkpoint güncellenmez |
| 12 | `last_successful_mint_block` daha düşük | Checkpoint güncellenir |

`tests/autoMintRunner.reconcile.test.ts` dosyasında:

| # | Senaryo | Beklenen Sonuç |
|---|---------|----------------|
| 13 | `review_required` var + `AUTO_RECONCILE_REVIEW_REQUIRED=false` | Automint başlamaz (`review_required_detected`) |
| 14 | `review_required` var + reconcile enabled + tüm kayıtlar temizlendi | Automint başlar |
| 15 | `review_required` var + reconcile enabled + bazı kayıtlar temizlenemedi | Automint başlamaz |
| 16 | `--dry-run` flag | DB değişmez |
| 17 | `--fix` flag | DB güncellenir |
| 18 | `--block <N>` flag | Yalnızca o blok reconcile edilir |
| 19 | `--tx <TX_HASH>` flag | Yalnızca o tx reconcile edilir |

### Property-Based Tests

- Rastgele `review_required` tx kayıtları üret; receipt=1, owner match, tx hash match
  durumunda her zaman `MARK_FINALIZED` kararı verildiğini doğrula.
- Rastgele `review_required` tx kayıtları üret; receipt missing veya receipt=0 durumunda
  her zaman `LEAVE_REVIEW_REQUIRED` veya `MARK_FAILED` kararı verildiğini doğrula.
- Dry-run modunda hiçbir DB yazma işlemi gerçekleşmediğini doğrula (DB mock ile).

### Integration Tests

- Tam reconcile akışı: `review_required` kayıt oluştur → `reconcileAll()` çalıştır →
  `hasReviewRequiredTx()` false döndürür → `runAutoMint()` başlar.
- Kısmi reconcile: 3 `review_required` kayıt, 2'si temizlenir, 1'i kalır →
  `hasReviewRequiredTx()` hâlâ true → automint başlamaz.
- CLI entegrasyonu: `npm run reconcile -- --dry-run` çalıştır → DB değişmez, rapor
  stdout'a yazılır.

---

## Safety Rules

Reconciler aşağıdaki güvenlik kurallarına kesinlikle uymalıdır:

| Kural | Açıklama |
|-------|----------|
| **Kanıt zorunlu** | Receipt.status=1 olmadan statü yükseltme yapılmaz |
| **Owner doğrulama** | EDMT `minted_by` bizim wallet adresimizle eşleşmiyorsa `successful_mint` yapılmaz |
| **TX hash doğrulama** | EDMT `mint_tx_hash` kaydımızdaki hash ile eşleşmiyorsa `successful_mint` yapılmaz |
| **Receipt missing** | Receipt alınamazsa `review_required` olarak bırakılır, beklenir |
| **Receipt failed** | Receipt.status=0 ise `failed` veya `review_required` olarak işaretlenir |
| **Private key gerekmez** | Reconciler hiçbir zaman private key kullanmaz |
| **TX gönderilmez** | Reconciler hiçbir on-chain işlem göndermez; yalnızca DB günceller |
| **Dry-run varsayılan** | `--fix` flag'i olmadan hiçbir DB yazma yapılmaz |
| **Finality kontrolü** | `RECONCILE_REQUIRE_FINALITY=true` iken yetersiz confirmation varsa yükseltme yapılmaz |
| **Checkpoint koruması** | `last_successful_mint_block` yalnızca mevcut değerden büyükse güncellenir |

---

## Final Validation

Implementasyon tamamlandıktan sonra aşağıdaki komutlar başarıyla çalışmalıdır:

```bash
npm test
npm run build
npm run lint
npm run format:check
```

**Yeni komutlar:**

```bash
npm run reconcile                    # dry-run (varsayılan)
npm run reconcile -- --dry-run       # açık dry-run
npm run reconcile -- --fix           # DB güncellemelerini uygula
npm run reconcile -- --block <N>     # tek blok reconcile
npm run reconcile -- --tx <TX_HASH>  # tek tx reconcile
```

**Yeni config değişkenleri:**

```env
AUTO_RECONCILE_REVIEW_REQUIRED=false   # automint startup'ta otomatik reconcile
RECONCILE_REQUIRE_FINALITY=true        # finality olmadan statü yükseltme yapma
RECONCILE_MIN_CONFIRMATIONS=64         # minimum blok onay sayısı
```

**Reconcile güvenlik kuralları özeti:**

- Kanıt yoksa statü yükseltme yok
- EDMT owner mismatch → `successful_mint` yapma
- TX hash mismatch → `successful_mint` yapma
- Receipt missing → bekle / `review_required` bırak
- Receipt failed → `failed` veya `review_required` bırak
- Private key gerekmez, TX gönderilmez
- Dry-run varsayılan; `--fix` ile DB güncellenir

**Implementasyona hazır mı?** Evet — tüm bağımlılıklar mevcut (`ethClient.getTransactionReceipt`,
`edmtClient.getBlockStatus`, `db.ts` helpers, `checkpoint.ts`), yeni dosya ve değişiklikler
net olarak tanımlanmış, test planı eksiksiz.
