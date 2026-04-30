# Bugfix Requirements Document

## Introduction

`--force-drop` komutu yalnızca `review_required` statüsündeki tx kayıtlarını işleyebiliyor. Ancak zincirde takılı kalan tx'ler bazen `txs.status = 'pending'`, `'included'` veya `'submitted'` olarak DB'de kalabiliyor. Bu durumda `npm run reconcile -- --force-drop --tx <HASH>` komutu 0 candidate döndürüyor çünkü `reconcileAll` yalnızca `review_required` kayıtları seçiyor.

Production örneği: Block 24987965, tx hash `0x3fc11effe8171e8dcd27dc88c64b8843b9e1bebecabc967bc241234fd060c131`, nonce 643. Etherscan'de bulunamıyor, `npm run pending` bu tx'i listeliyor, ancak `--force-drop --tx HASH` 0 candidate döndürüyor. Sonuç olarak automint `nonce_anomaly_detected` / `monitoring_only` durumunda bloke oluyor.

Etkilenen tablolar: `txs`, `block_results`  
Etkilenen CLI flag'i: `npm run reconcile -- --force-drop --tx <HASH>`  
Yeni davranış: explicit `--tx` veya `--block` filtresi verildiğinde `pending`, `included`, `submitted` statüsündeki tx'ler de force-drop kapsamına alınır.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `--force-drop --tx <HASH>` komutu çalıştırıldığında ve hedef tx'in `txs.status = 'pending'` olduğu durumda THEN sistem 0 candidate döndürür; `reconcileAll` yalnızca `review_required` kayıtları seçtiği için `pending` tx hiç işlenmez

1.2 WHEN `--force-drop --tx <HASH>` komutu çalıştırıldığında ve hedef tx'in `txs.status = 'included'` olduğu durumda THEN sistem 0 candidate döndürür; `included` statüsündeki tx `getReviewRequiredTxs()` sorgusuna dahil edilmez

1.3 WHEN `--force-drop --tx <HASH>` komutu çalıştırıldığında ve hedef tx'in `txs.status = 'submitted'` olduğu durumda THEN sistem 0 candidate döndürür; `submitted` statüsündeki tx `getReviewRequiredTxs()` sorgusuna dahil edilmez

1.4 WHEN `pending` veya `included` statüsündeki bir tx zincirde bulunamıyorsa (getTransaction null, getTransactionReceipt null) ve nonce ilerlemişse THEN sistem bu tx'i dropped olarak işaretleyecek bir mekanizmaya sahip değildir; tx DB'de sonsuza kadar `pending` olarak kalır

1.5 WHEN `pending` statüsündeki stuck tx DB'de kaldığında THEN `hasPendingTx()` `true` döndürmeye devam eder ve automint `nonce_anomaly_detected` / `monitoring_only` durumunda bloke olur

1.6 WHEN `--force-drop --fix --tx <HASH>` komutu `pending` statüsündeki bir tx için çalıştırıldığında THEN sistem hiçbir DB güncellemesi yapmaz; tx `pending` olarak kalır, block `retryable` yapılmaz

### Expected Behavior (Correct)

2.1 WHEN `--force-drop --tx <HASH>` komutu çalıştırıldığında ve hedef tx'in `txs.status IN ('pending', 'included', 'submitted', 'review_required')` olduğu durumda THEN sistem bu tx'i candidate olarak seçmeli ve force-drop diagnostic'i çalıştırmalı

2.2 WHEN explicit `--tx <HASH>` veya `--block <N>` filtresi verildiğinde ve hedef tx `pending` / `included` / `submitted` statüsündeyse THEN sistem `getTransaction(txHash)`, `getTransactionReceipt(txHash)`, `latestNonce`, `pendingNonce`, EDMT block status ve DB çakışma kontrollerini içeren tüm force-drop safety check'lerini çalıştırmalı

2.3 WHEN tüm force-drop safety check'leri geçildiğinde (receipt null, getTransaction null, latestNonce >= txNonce, pendingNonce === latestNonce, EDMT mintable, owner null, mintTx null, aynı nonce/block için başka active tx yok) THEN sistem dry-run modunda bu tx'i ELIGIBLE olarak göstermeli

2.4 WHEN `--force-drop --fix --tx <HASH>` komutu çalıştırıldığında ve tüm safety check'ler geçildiğinde THEN sistem `txs.status = 'dropped'` olarak güncellenmeli, `block_results.status = 'retryable'` olarak güncellenmeli ve reconcile event kaydı oluşturulmalı

2.5 WHEN EDMT block status `minted` döndürdüğünde THEN sistem `txs.status = 'dropped'` olarak güncellenmeli ve `block_results.status = 'minted'` olarak güncellenmeli; block retryable yapılmamalı

2.6 WHEN `getTransaction(txHash)` null değil (tx hâlâ pending/mempool'da görünüyor) ise THEN sistem force-drop'u reddetmeli; tx mevcut statüsünde bırakılmalı

2.7 WHEN `getTransactionReceipt(txHash)` null değil (receipt mevcut) ise THEN sistem force-drop'u reddetmeli; tx mevcut statüsünde bırakılmalı

2.8 WHEN `--force-drop` flag'i explicit `--tx` veya `--block` filtresi olmadan kullanıldığında THEN sistem hata verip çıkmalı; global pending tx'ler otomatik drop edilmemeli

2.9 WHEN force-drop tamamlandıktan sonra THEN `npm run pending` bu tx'i listelememeli ve `npm run status` pending tx sayısını 0 göstermeli

2.10 WHEN block `retryable` yapıldıktan sonra THEN `isBlockSubmittedOrBeyond(block)` `false` döndürmeli ve automint bu block'u yeniden deneyebilmeli

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `--force-drop` flag'i explicit `--tx` veya `--block` filtresi olmadan kullanıldığında THEN sistem hata verip çıkmaya DEVAM ETMELİ; bu güvenlik kontrolü değişmemeli

3.2 WHEN `getTransaction(txHash)` null değil (tx pending/mempool'da görünüyor) ise THEN sistem bu tx'i dropped olarak işaretlemeye DEVAM ETMEMELİ; mevcut statüsünde bırakmaya DEVAM ETMELİ

3.3 WHEN `getTransactionReceipt(txHash)` null değil (receipt mevcut) ise THEN sistem force-drop'u reddetmeye DEVAM ETMELİ

3.4 WHEN `--force-drop` flag'i olmadan `npm run reconcile` veya `npm run reconcile -- --fix` çalıştırıldığında THEN `pending` / `included` / `submitted` statüsündeki tx'lere dokunulmamalı; mevcut reconcile davranışı değişmemeli

3.5 WHEN `review_required` statüsündeki tx'ler için mevcut `resolveReviewRequired` ve `resolveForceDropTx` akışları çalıştırıldığında THEN bu akışlar değişmemeli; `review_required` tx'ler için mevcut davranış korunmalı

3.6 WHEN `txs` tablosunda `status = 'finalized'` veya `status = 'successful_mint'` olan kayıtlar varsa THEN force-drop bu kayıtlara dokunmamalı

3.7 WHEN EDMT block status `minted` döndürdüğünde THEN sistem block'u retryable yapmamalı; `block_results.status = 'minted'` olarak güncellemeye DEVAM ETMELİ

3.8 WHEN aynı nonce için başka bir active tx (pending/included/submitted/finalized) varsa THEN sistem force-drop'u reddetmeye DEVAM ETMELİ

3.9 WHEN aynı block için başka bir active tx varsa THEN sistem force-drop'u reddetmeye DEVAM ETMELİ

3.10 WHEN dry-run modunda force-drop çalıştırıldığında THEN DB'ye hiçbir yazma yapılmamalı; mevcut tx statüsü korunmalı

---

## Bug Condition (Pseudocode)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type TxRecord  (txs tablosundan bir satır)
  OUTPUT: boolean

  // Bug tetiklenir: tx pending/included/submitted statüsünde VE
  // explicit --force-drop --tx <HASH> ile hedefleniyor VE
  // reconcileAll bu tx'i candidate olarak seçmiyor
  RETURN X.status IN ('pending', 'included', 'submitted')
         AND forceDrop = true
         AND txFilter = X.tx_hash
         AND getReviewRequiredTxs() does NOT include X
END FUNCTION
```

```pascal
// Property: Fix Checking — pending/included/submitted tx'ler force-drop kapsamına alınmalı
FOR ALL X WHERE isBugCondition(X) DO
  result ← reconcileAll'({ forceDrop: true, txFilter: X.tx_hash })
  ASSERT result.total >= 1
  ASSERT result.results[0].tx.tx_hash = X.tx_hash
  // Tüm safety check'ler geçilirse:
  ASSERT result.results[0].decision IN ('MARK_DROPPED_RETRYABLE', 'MARK_DROPPED_MINTED', 'LEAVE_REVIEW_REQUIRED')
  // 0 candidate döndürmemeli
  ASSERT result.total != 0
END FOR
```

```pascal
// Property: Preservation Checking — --force-drop olmadan pending tx'lere dokunulmamalı
FOR ALL X WHERE X.status IN ('pending', 'included', 'submitted')
             AND forceDrop = false DO
  ASSERT reconcileAll'(X, forceDrop=false).total = 0  // pending tx'ler seçilmemeli
  ASSERT X.status unchanged
END FOR
```

```pascal
// Property: Preservation Checking — explicit filtre olmadan force-drop çalışmamalı
FOR ALL X WHERE forceDrop = true AND txFilter = undefined AND blockFilter = undefined DO
  ASSERT CLI exits with error
  ASSERT no DB writes performed
END FOR
```
