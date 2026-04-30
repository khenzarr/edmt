# Dropped TX Resolution — Bugfix Design

## Overview

Block 24987708 için tx hash `0xa19e5faa0b4c13d3d500c83ebe17c286a65c747dd58125a38988b331162ccd4d` kaydı `LEAVE_REVIEW_REQUIRED / receipt_missing` kararıyla takılı kaldı. Bu tek `review_required` kayıt, automint'in başlamasını engelliyor. Mevcut reconciler yalnızca receipt bulunduğunda ve EDMT owner/hash eşleştiğinde `finalized` yapabiliyor; receipt'i olmayan ama zincirde dropped/replaced olan tx'leri çözüme kavuşturacak bir mekanizma yok.

Bu bugfix, `receipt_missing` kararıyla kalan `review_required` kayıtlar için ek bir çözüm yolu ekler: tx'in gerçekten dropped/replaced olduğunu kanıtlayan çok adımlı kontrol (RPC `getTransaction`, `getTransactionReceipt`, wallet latestNonce, DB nonce karşılaştırması) yaparak güvenli bir şekilde `dropped` statüsüne geçirir ve block'u tekrar denenebilir hale getirir. Hiçbir on-chain işlem gönderilmez; yalnızca DB güncellenir. Kanıt olmadan statü değiştirilmez.

**Etkilenen tablolar:** `txs`, `block_results`  
**Yeni CLI flag:** `npm run reconcile -- --fix-dropped`  
**Yeni tx statüsü:** `dropped`  
**Yeni block_results statüsü:** `retryable`

---

## Glossary

- **Bug_Condition (C)**: `txs.status = 'review_required'` olan bir kaydın `getTransaction(txHash) = null` VE `getTransactionReceipt(txHash) = null` VE `latestNonce(wallet) > txNonce` koşullarını sağlayan durum — tx zincirde dropped/replaced olmuş.
- **Property (P)**: Bug condition sağlandığında beklenen doğru davranış — `txs.status = 'dropped'` yapılması, EDMT block status'e göre `block_results.status = 'retryable'` veya `'minted'` olarak güncellenmesi.
- **Preservation**: `getTransaction` null değil (tx pending) veya `latestNonce <= txNonce` durumunda `review_required` olarak bırakılması; mevcut `MARK_FINALIZED` yolunun etkilenmemesi; `--fix-dropped` olmadan dropped resolution çalışmaması.
- **resolveDroppedTx(tx, opts)**: `src/reconciler.ts` içinde eklenecek, tek bir `review_required` kaydı için dropped resolution akışını çalıştıran fonksiyon.
- **isBugCondition(X)**: Bir `TxRecord`'un dropped bug condition'ını sağlayıp sağlamadığını belirleyen pseudocode fonksiyonu.
- **getTransaction(txHash)**: `ethers.provider.getTransaction(txHash)` — tx mempool'da veya zincirde varsa döner, yoksa null.
- **latestNonce**: `getTransactionCount(address, "latest")` — on-chain confirmed nonce (wallet'in kaç tx gönderdiği).
- **txNonce**: `txs.nonce` — DB'deki tx kaydının nonce değeri.
- **MARK_DROPPED_RETRYABLE**: EDMT block status `mintable` iken dropped tx için verilen karar — `txs.status = 'dropped'`, `block_results.status = 'retryable'`.
- **MARK_DROPPED_MINTED**: EDMT block status `minted` iken dropped tx için verilen karar — `txs.status = 'dropped'`, `block_results.status = 'minted'`.
- **dry-run modu**: DB'ye hiçbir yazma yapılmadan dropped resolution kararlarının raporlandığı mod (varsayılan).
- **fix-dropped modu**: `--fix-dropped` flag'i ile aktif edilen, DB güncellemelerinin gerçekten uygulandığı mod.
- **walletAddress**: `ethClient.getWallet().address` — nonce karşılaştırmasında kullanılan adres.

---

## Bug Details

### Bug Condition

Bug, `txs` tablosunda `status = 'review_required'` olan bir kaydın zincirde dropped/replaced olması durumunda tetiklenir. Mevcut `resolveReviewRequired()` fonksiyonu receipt yoksa `LEAVE_REVIEW_REQUIRED / receipt_missing` kararı verir ve durur; tx'in gerçekten dropped olup olmadığını kontrol etmez. Bu kayıt sonsuza kadar `review_required` olarak kalır ve automint'i engeller.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type TxRecord  (txs tablosundan bir satır, status = 'review_required')
  OUTPUT: boolean

  // Bug tetiklenir: tx review_required statüsünde VE zincirde dropped/replaced olmuş
  // (receipt yok, getTransaction yok, latestNonce ilerlemiş)
  RETURN X.status = 'review_required'
         AND getTransactionReceipt(X.tx_hash) = null
         AND getTransaction(X.tx_hash) = null
         AND latestNonce(walletAddress) > X.nonce
END FUNCTION
```

### Examples

- **Örnek 1 — Dropped, block mintable**: Block 24987708, tx `0xa19e5f...`, receipt yok, getTransaction null, latestNonce=15 > txNonce=12, EDMT block status `mintable`. → `txs.status = 'dropped'`, `block_results.status = 'retryable'`, automint yeniden başlar. ✅

- **Örnek 2 — Dropped, block minted_elsewhere**: Block 25000100, tx dropped, EDMT block status `minted` (başkası mint etmiş). → `txs.status = 'dropped'`, `block_results.status = 'minted'`, block tekrar denenmez. ✅

- **Örnek 3 — TX hâlâ pending**: Block 25000200, `getTransaction(txHash)` null değil (tx mempool'da). → `review_required` olarak bırakılır, dropped olarak işaretleme. ⏳

- **Örnek 4 — Nonce ilerlemedi**: Block 25000300, `latestNonce = txNonce` (nonce henüz ilerlemedi, tx hâlâ gönderilebilir olabilir). → `review_required` olarak bırakılır, dropped olarak işaretleme. ⏳

- **Örnek 5 — Dry-run**: Tüm dropped koşulları sağlanmış, ancak `--fix-dropped` yok. → Karar raporlanır, DB değişmez. 📋

---

## Expected Behavior

### Preservation Requirements

**Değişmeden kalması gereken davranışlar:**

- `getTransaction(txHash)` null değil (tx pending/mempool'da görünüyor) ise `review_required` olarak bırakılmaya DEVAM EDİLMELİ.
- Mevcut `resolveReviewRequired()` akışı — receipt.status=1 + EDMT owner match + tx hash match → `MARK_FINALIZED` — bu fix'ten etkilenmemeli.
- `--fix-dropped` flag'i kullanılmadan `npm run reconcile` veya `npm run reconcile -- --fix` çalıştırıldığında dropped resolution mantığı çalışmamalı; mevcut `receipt_missing` kararı değişmemeli.
- `txs.status IN ('pending', 'included')` olan kayıtlar `TxMonitor.poll()` tarafından normal lifecycle'ına göre işlenmeye devam etmeli; dropped resolution bu kayıtlara dokunmamalı.
- `block_results.status IN ('successful_mint', 'finalized')` olan kayıtlar dropped resolution tarafından değiştirilmemeli.
- `latestNonce <= txNonce` iken (nonce ilerlemedi) sistem körlemesine dropped işaretlememeli; `review_required` olarak bırakmaya DEVAM ETMELİ.
- Dry-run modunda DB'ye hiçbir yazma yapılmamalı; mevcut `review_required` statüsü korunmalı.

**Kapsam:**

Bug condition'ı sağlamayan tüm `review_required` kayıtlar (getTransaction null değil, latestNonce <= txNonce, veya `--fix-dropped` flag'i yok) değişmeden kalmalı ve automint'i engellemeye devam etmeli.

---

## Hypothesized Root Cause

Bug description ve mevcut kod analizi temelinde en olası nedenler:

1. **`resolveReviewRequired()` receipt yoksa duruyor**: `src/reconciler.ts` içindeki mevcut akış, `getTransactionReceipt(txHash) = null` durumunda `LEAVE_REVIEW_REQUIRED / receipt_missing` kararı verip durur. Tx'in dropped olup olmadığını kontrol eden ek bir adım yok.

2. **`getTransaction()` RPC çağrısı eksik**: Mevcut reconciler `getTransactionReceipt` çağırıyor ama `getTransaction` (tx'in mempool'da veya zincirde var olup olmadığını kontrol eden) çağrısını yapmıyor. Bu iki çağrı birlikte dropped detection için gerekli.

3. **Nonce karşılaştırması yok**: Mevcut reconciler wallet'in mevcut nonce'unu sorgulamıyor. `latestNonce > txNonce` kontrolü dropped detection için kritik — nonce ilerlediyse tx kesinlikle dropped/replaced demektir.

4. **`--fix-dropped` flag'i yok**: Mevcut CLI'da dropped resolution için ayrı bir flag yok. Dropped resolution, mevcut `--fix` flag'inden ayrı tutulmalı — farklı risk profili ve farklı karar mantığı gerektiriyor.

5. **`block_results` duplicate guard temizlenmiyor**: Tx dropped olduğunda `block_results.status` hâlâ `review_required` veya `submitted` olarak kalıyor. `retryable` statüsü ve duplicate guard temizleme mekanizması yok.

---

## Correctness Properties

Property 1: Bug Condition — Dropped TX Çözüme Kavuşturulmalı

_For any_ `TxRecord` X where `isBugCondition(X)` returns true (status = 'review_required', getTransactionReceipt = null, getTransaction = null, latestNonce > txNonce), the fixed `resolveDroppedTx(X)` function SHALL update `txs.status` to `'dropped'` and update `block_results.status` to `'retryable'` (if EDMT block status is mintable) or `'minted'` (if EDMT block status is minted), and `hasReviewRequiredTx()` SHALL return false after resolution.

**Validates: Requirements 2.1, 2.2, 2.3, 2.8**

Property 2: Preservation — Kanıtsız Dropped İşareti Yapılmamalı

_For any_ `TxRecord` X where `isBugCondition(X)` returns false (getTransaction not null, OR latestNonce <= txNonce, OR --fix-dropped flag absent), the fixed code SHALL leave `txs.status` as `'review_required'`, `hasReviewRequiredTx()` SHALL continue to return `true`, and automint SHALL NOT start.

**Validates: Requirements 2.4, 2.5, 2.6, 3.1, 3.3, 3.7**

---

## Fix Implementation

### Changes Required

Asagidaki degisiklikler root cause analizimizin dogru oldugu varsayimiyla planlanmistir. Exploratory testler farkli bir root cause ortaya koyarsa bu plan revize edilecektir.

---

**Dosya 1:** `src/reconciler.ts` *(guncelleme)*

**Yeni fonksiyon:** `resolveDroppedTx(tx, opts)`

Dropped resolution akisi:
1. `getTransactionReceipt(tx.tx_hash)` cagir — null degil ise dropped degil, mevcut akisa birak
2. `getTransaction(tx.tx_hash)` cagir — null degil ise tx hala pending, `LEAVE_REVIEW_REQUIRED` don (reason: `tx_still_pending`)
3. `getLatestNonce(walletAddress)` cagir — `latestNonce <= tx.nonce` ise nonce ilerlemedi, `LEAVE_REVIEW_REQUIRED` don (reason: `nonce_not_advanced`)
4. Tum kontroller gecti — tx dropped kanitlandi
5. `getBlockStatus(tx.block)` cagir (EDMT API)
6. EDMT status `mintable` — `MARK_DROPPED_RETRYABLE`
7. EDMT status `minted` — `MARK_DROPPED_MINTED`
8. EDMT status `unknown` / API erisilemez — `LEAVE_REVIEW_REQUIRED` (reason: `edmt_api_unavailable`)

**Yeni ReconcileDecision sabitleri:**
```typescript
MARK_DROPPED_RETRYABLE: "MARK_DROPPED_RETRYABLE",
MARK_DROPPED_MINTED:    "MARK_DROPPED_MINTED",
```

**`applyDecision()` guncelleme:** Yeni kararlar icin DB yazma mantigi:
- `MARK_DROPPED_RETRYABLE`: `txs.status = 'dropped'`, `block_results.status = 'retryable'`, reconcile_event insert
- `MARK_DROPPED_MINTED`: `txs.status = 'dropped'`, `block_results.status = 'minted'`, reconcile_event insert

**`reconcileAll()` guncelleme:** `opts.fixDropped = true` ise her `review_required` kayit icin once mevcut `resolveReviewRequired()` akisini calistir; `LEAVE_REVIEW_REQUIRED / receipt_missing` karari gelirse `resolveDroppedTx()` akisini calistir.

**Yeni ReconcileOpts alani:**
```typescript
/** If true, attempt dropped/replaced tx resolution for receipt_missing records */
fixDropped?: boolean;
```

---

**Dosya 2:** `src/ethClient.ts` *(guncelleme)*

**Yeni fonksiyon:** `getTransaction(txHash: string): Promise<ethers.TransactionResponse | null>`

```typescript
export async function getTransaction(txHash: string): Promise<ethers.TransactionResponse | null> {
  return withRetry(
    () => getProvider().getTransaction(txHash),
    `getTransaction(${txHash.slice(0, 10)}...)`
  );
}
```

Not: `getLatestNonce()` zaten mevcut (`src/ethClient.ts` icinde).

---

**Dosya 3:** `src/types.ts` *(guncelleme)*

`TxStatus` tipine `'dropped'` eklenmesi:
```typescript
export type TxStatus = "pending" | "included" | "failed" | "finalized" | "review_required" | "dropped";
```

`BlockLifecycleStatus` tipine `'retryable'` eklenmesi:
```typescript
export type BlockLifecycleStatus =
  | "unknown" | "beyond_current_head" | "not_eligible" | "minted" | "mintable"
  | "submitted" | "included" | "finalized" | "successful_mint"
  | "review_required" | "failed" | "retryable";
```

---

**Dosya 4:** `src/db.ts` *(guncelleme)*

`isBlockSubmittedOrBeyond()` guncelleme: `'retryable'` statusunu `beyondStatuses` setinden cikar — retryable block'lar tekrar mint denemesine acik olmali:
```typescript
const beyondStatuses = new Set([
  "submitted", "included", "finalized", "successful_mint", "review_required", "failed",
  // NOT 'retryable' — retryable blocks should be eligible for new mint attempts
]);
```

---

**Dosya 5:** `src/cli.ts` *(guncelleme)*

`reconcile` komutuna `--fix-dropped` flag'i eklenmesi:
```
npm run reconcile -- --fix-dropped          # dropped resolution + DB guncelle
npm run reconcile -- --fix --fix-dropped    # hem finalize hem dropped resolution
```

CLI cikti guncelleme: `dropped` ve `retryable` kararlarini raporla.

---

**Dosya 6:** `src/logger.ts` *(guncelleme)*

Yeni LogEvent sabitleri:
```typescript
RECONCILE_DROPPED_DETECTED:   "reconcile_dropped_detected",
RECONCILE_DROPPED_RETRYABLE:  "reconcile_dropped_retryable",
RECONCILE_DROPPED_MINTED:     "reconcile_dropped_minted",
RECONCILE_TX_STILL_PENDING:   "reconcile_tx_still_pending",
RECONCILE_NONCE_NOT_ADVANCED: "reconcile_nonce_not_advanced",
```

---

**Dosya 7:** `package.json` *(guncelleme gerekmez)*

`reconcile` script zaten mevcut — `--fix-dropped` flag'i CLI tarafindan parse edilecek.

---

## Testing Strategy

### Validation Approach

Test stratejisi iki asamalidir:

1. **Exploratory (Bug Condition Checking)**: Unfixed kod uzerinde bug'i gosteren testler yazilir. Bu testler basarisiz olmali — root cause analizini dogrular.
2. **Fix + Preservation Checking**: Fix uygulandiktan sonra hem bug condition'in duzeldigi hem de mevcut davranisın korunduğu dogrulanir.

### Exploratory Bug Condition Checking

**Hedef:** Fix uygulanmadan once bug'i somut olarak goster; root cause analizini dogrula veya curut.

**Test Plani:** `review_required` statusunde bir tx kaydi olustur, `getTransactionReceipt` mock'la null dondur, `getTransaction` mock'la null dondur, `latestNonce > txNonce` olacak sekilde ayarla. Mevcut `resolveReviewRequired()` akisinin `LEAVE_REVIEW_REQUIRED / receipt_missing` karari verdigini gozlemle — dropped detection yapilmadigini dogrula.

**Test Senaryolari:**

1. **Dropped TX Tespit Edilemiyor (unfixed)**: `receipt=null`, `getTransaction=null`, `latestNonce=15 > txNonce=12` → unfixed kod `LEAVE_REVIEW_REQUIRED / receipt_missing` doner (will fail on fixed code)
2. **`resolveDroppedTx` Fonksiyonu Yok (unfixed)**: `resolveDroppedTx` import edilmeye calisilir → unfixed kodda fonksiyon yok
3. **`ReconcileDecision.MARK_DROPPED_RETRYABLE` Yok (unfixed)**: Sabit tanimli degil → unfixed kodda undefined
4. **`--fix-dropped` Flag Yok (unfixed)**: `ReconcileOpts.fixDropped` alani yok → unfixed kodda undefined

**Beklenen Counterexample'lar:**
- Unfixed kod: `receipt_missing` karari verilir, dropped detection yapilmaz
- Olasilar: `getTransaction` cagrisi yok, nonce karsilastirmasi yok, `resolveDroppedTx` fonksiyonu yok

### Fix Checking

**Hedef:** Bug condition saglayan tum girdiler icin fixed fonksiyonun beklenen davranisi urettigini dogrula.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := resolveDroppedTx_fixed(X)
  ASSERT result.txStatus = 'dropped'
  ASSERT result.decision IN ('MARK_DROPPED_RETRYABLE', 'MARK_DROPPED_MINTED')
  ASSERT hasReviewRequiredTx() = false  // automint artik baslayabilmeli
END FOR
```

### Preservation Checking

**Hedef:** Bug condition saglamayan tum girdiler icin fixed fonksiyonun orijinal fonksiyonla ayni sonucu urettigini dogrula.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  // getTransaction null degil (pending) → review_required kalmali
  // latestNonce <= txNonce → review_required kalmali
  // --fix-dropped yok → review_required kalmali
  ASSERT resolveDroppedTx_fixed(X).txStatus = 'review_required'
         OR resolveDroppedTx_fixed(X).decision = 'LEAVE_REVIEW_REQUIRED'
END FOR
```

**Test Yaklaşımı:** Property-based testing preservation checking icin onerilir cunku:
- Genis girdi uzayinda otomatik test senaryolari uretir
- Manuel testlerin kacırabileceği edge case'leri yakalar
- Non-buggy girdiler icin davranisın degismedigine dair guclu garanti saglar

**Test Senaryolari:**
1. **TX Hala Pending Preservation**: `getTransaction` null degil → `review_required` kalir (unfixed ile ayni)
2. **Nonce Ilerlemedi Preservation**: `latestNonce <= txNonce` → `review_required` kalir
3. **`--fix-dropped` Yok Preservation**: `fixDropped=false` → dropped resolution calismamalı, `receipt_missing` karari degismemeli
4. **Mevcut MARK_FINALIZED Yolu Preservation**: receipt.status=1 + owner match + tx hash match → `MARK_FINALIZED` karari degismemeli
5. **Dry-run Preservation**: `fixDropped=true` ama `dryRun=true` → DB degismemeli

### Unit Tests

`tests/reconciler.droppedTx.exploration.test.ts` dosyasinda:

| # | Senaryo | Beklenen Sonuc |
|---|---------|----------------|
| 1 | receipt=null, getTransaction=null, latestNonce > txNonce, EDMT=mintable | `MARK_DROPPED_RETRYABLE`, `txs.status='dropped'`, `block_results.status='retryable'` |
| 2 | receipt=null, getTransaction=null, latestNonce > txNonce, EDMT=minted | `MARK_DROPPED_MINTED`, `txs.status='dropped'`, `block_results.status='minted'` |
| 3 | receipt=null, getTransaction NOT null (pending) | `LEAVE_REVIEW_REQUIRED`, reason: `tx_still_pending` |
| 4 | receipt=null, getTransaction=null, latestNonce <= txNonce | `LEAVE_REVIEW_REQUIRED`, reason: `nonce_not_advanced` |
| 5 | receipt=null, getTransaction=null, latestNonce > txNonce, EDMT API unavailable | `LEAVE_REVIEW_REQUIRED`, reason: `edmt_api_unavailable` |
| 6 | `--fix-dropped` yok (fixDropped=false) | Dropped resolution calismamalı, `receipt_missing` karari degismemeli |
| 7 | Dry-run mode (fixDropped=true, dryRun=true) | DB degismemeli, karar raporlanmali |
| 8 | Fix mode (fixDropped=true, dryRun=false) | DB guncellenmeli |
| 9 | Dropped + retryable → `isBlockSubmittedOrBeyond()` false donmeli | Block tekrar mint denemesine acik |
| 10 | Mevcut MARK_FINALIZED yolu (receipt=1, owner match) | `MARK_FINALIZED` karari degismemeli |

`tests/reconciler.droppedTx.preservation.test.ts` dosyasinda:

| # | Senaryo | Beklenen Sonuc |
|---|---------|----------------|
| 11 | TX pending → review_required kalir | Mevcut davranis korunur |
| 12 | Nonce ilerlemedi → review_required kalir | Mevcut davranis korunur |
| 13 | `--fix-dropped` yok → receipt_missing karari degismez | Mevcut davranis korunur |
| 14 | Mevcut finalize yolu etkilenmez | MARK_FINALIZED hala calisiyor |
| 15 | Dry-run dropped resolution → DB degismez | Mevcut dry-run davranisi korunur |

### Property-Based Tests

- Rastgele `{receipt: null, getTransaction: null, latestNonce, txNonce}` kombinasyonlari uret: `latestNonce > txNonce` olanlarda `MARK_DROPPED_*` karari verildigini dogrula.
- Rastgele `{getTransaction: non-null}` girdileri uret: her zaman `LEAVE_REVIEW_REQUIRED` donduğunu dogrula.
- `fixDropped=false` olan tum girdilerde dropped resolution calismadigini dogrula.
- Dry-run modunda hicbir DB yazma islemi gerceklesmedigini dogrula (DB mock ile).

### Integration Tests

- Tam dropped resolution akisi: `review_required` kayit olustur → `reconcileAll({ fixDropped: true })` calistir → `hasReviewRequiredTx()` false doner → automint baslar.
- Dropped + retryable: block `retryable` statusune gecince `isBlockSubmittedOrBeyond()` false doner → yeni mint denemesi mumkun.
- CLI entegrasyonu: `npm run reconcile -- --fix-dropped` calistir → DB guncellenir, rapor stdout'a yazilir.

---

## Safety Rules

Dropped resolution asagidaki guvenlik kurallarina kesinlikle uymalıdır:

| Kural | Aciklama |
|-------|----------|
| **Kanit zorunlu** | `getTransaction=null` VE `latestNonce > txNonce` olmadan `dropped` isareti yapilmaz |
| **TX pending kontrolu** | `getTransaction` null degil ise dropped isareti yapilmaz |
| **Nonce kontrolu** | `latestNonce <= txNonce` ise dropped isareti yapilmaz |
| **Successful_mint yok** | Kanit olmadan `successful_mint` yapilmaz; dropped resolution yalnizca `dropped` statusu atar |
| **Private key gerekmez** | Dropped resolution hicbir zaman private key kullanmaz |
| **TX gonderilmez** | Dropped resolution hicbir on-chain islem gondermez; yalnizca DB gunceller |
| **`--fix-dropped` zorunlu** | Bu flag olmadan dropped resolution mantigi calismamalı |
| **Dry-run varsayilan** | `--fix-dropped` olmadan hicbir DB yazma yapilmaz |
| **EDMT API kontrolu** | Block status EDMT API'den dogrulanmadan `retryable` yapilmaz |
| **Mevcut yol korunur** | `MARK_FINALIZED` yolu (receipt=1 + owner match) bu fix'ten etkilenmez |

---

## Final Validation

Implementasyon tamamlandiktan sonra asagidaki komutlar basariyla calismalıdır:

```bash
npm test
npm run build
npm run lint
npm run format:check
```

**Yeni komutlar:**

```bash
npm run reconcile -- --fix-dropped          # dropped resolution + DB guncelle
npm run reconcile -- --fix --fix-dropped    # hem finalize hem dropped resolution
npm run reconcile -- --block <N> --fix-dropped  # tek blok dropped resolution
```

**Yeni statusler:**

| Tablo | Yeni Status | Anlami |
|-------|-------------|--------|
| `txs` | `dropped` | TX zincirde dropped/replaced olmus, kanıtlanmis |
| `block_results` | `retryable` | Block dropped tx nedeniyle tekrar mint denemesine acik |

**Dropped resolution guvenlik kurallari ozeti:**

- Kanit yoksa dropped isareti yok
- TX hala pending → dropped isareti yapma
- Nonce ilerlemediyse → dropped isareti yapma
- Kanit olmadan `successful_mint` yapma
- Private key gerekmez, TX gonderilmez
- `--fix-dropped` olmadan DB degismez
- EDMT API dogrulamasi olmadan `retryable` yapma
