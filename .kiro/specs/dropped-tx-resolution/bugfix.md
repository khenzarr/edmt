# Bugfix Requirements Document

## Introduction

Reconciler dry-run çıktısında block 24987708 için tx hash `0xa19e5faa0b4c13d3d500c83ebe17c286a65c747dd58125a38988b331162ccd4d` kaydı `LEAVE_REVIEW_REQUIRED / receipt_missing` kararıyla kaldı. Bu tek `review_required` kayıt, automint'in başlamasını engelliyor. Mevcut reconciler yalnızca receipt bulunduğunda ve EDMT owner/hash eşleştiğinde `finalized` yapabiliyor; receipt'i olmayan ama zincirde dropped/replaced olan tx'leri çözüme kavuşturacak bir mekanizma yok.

Bu bugfix, `receipt_missing` kararıyla kalan `review_required` kayıtlar için ek bir çözüm yolu ekler: tx'in gerçekten dropped/replaced olduğunu kanıtlayan çok adımlı kontrol (RPC `getTransaction`, `getTransactionReceipt`, wallet latest/pending nonce, DB nonce karşılaştırması, aynı nonce'a sahip başka tx varlığı, aynı block için başka submitted/included/finalized tx varlığı, EDMT API block status) yaparak güvenli bir şekilde `dropped` statüsüne geçirir ve block'u tekrar denenebilir hale getirir. Hiçbir on-chain işlem gönderilmez; yalnızca DB güncellenir. Kanıt olmadan statü değiştirilmez.

Etkilenen tablolar: `txs`, `block_results`  
Yeni CLI flag'i: `npm run reconcile -- --fix-dropped`  
Yeni tx statüsü: `dropped`

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN bir `review_required` tx kaydı için `getTransactionReceipt(txHash)` null döndürüyorsa THEN sistem `LEAVE_REVIEW_REQUIRED / receipt_missing` kararı verir ve bu kaydı çözüme kavuşturmadan bırakır; automint başlamaz

1.2 WHEN `receipt_missing` kararıyla kalan bir `review_required` kayıt için tx zincirde dropped/replaced olmuş olsa bile (getTransaction null, latestNonce > txNonce) THEN sistem bu tx'i dropped olarak işaretleyecek bir mekanizmaya sahip değildir; kayıt sonsuza kadar `review_required` olarak kalır

1.3 WHEN bir tx dropped/replaced kabul edilebilir durumda olsa bile THEN sistem `block_results` tablosundaki duplicate guard'ı temizlemez veya block'u `retryable` yapmaz; aynı block bir daha mint denemesi için değerlendirilemez

1.4 WHEN `review_required` kayıt `receipt_missing` nedeniyle çözüme kavuşturulamazsa THEN `hasReviewRequiredTx()` `true` döndürmeye devam eder ve automint her seferinde `review_required_detected` stop reason ile durur

1.5 WHEN dropped resolution için `npm run reconcile -- --fix` çalıştırıldığında THEN sistem dropped tx'leri tanıyıp işleyecek mantığa sahip değildir; `receipt_missing` kararı değişmez

### Expected Behavior (Correct)

2.1 WHEN `--fix-dropped` flag'i ile reconcile çalıştırıldığında ve bir `review_required` tx için `getTransaction(txHash)` null döndürüyor, `getTransactionReceipt(txHash)` null döndürüyor ve wallet `latestNonce > txNonce` ise THEN sistem bu tx'i `dropped` olarak işaretlemeli (`txs.status = 'dropped'`) ve `review_required` kaydını temizlemeli

2.2 WHEN bir tx `dropped` olarak işaretlendiğinde ve EDMT API block status `mintable` döndürüyorsa THEN sistem `block_results.status = 'retryable'` olarak güncellenmeli ve duplicate guard kaldırılmalı; aynı block tekrar mint denemesine açık olmalı

2.3 WHEN bir tx `dropped` olarak işaretlendiğinde ve EDMT API block status `minted` döndürüyorsa (başka biri mint etmiş) THEN sistem `block_results.status = 'minted'` olarak güncellenmeli; block tekrar denenmemeli

2.4 WHEN `getTransaction(txHash)` null değil (tx hâlâ pending görünüyor) ise THEN sistem bu tx'i dropped olarak işaretlememeli; kayıt `review_required` olarak bırakılmalı ve automint başlatılmamalı

2.5 WHEN dropped resolution dry-run modunda çalıştırıldığında (`--fix-dropped` olmadan) THEN sistem DB'ye hiçbir yazma yapmamalı; yalnızca kararı raporlamalı

2.6 WHEN `--fix-dropped` flag'i kullanılmadan `npm run reconcile` çalıştırıldığında THEN sistem dropped resolution mantığını çalıştırmamalı; mevcut `receipt_missing` kararı değişmemeli

2.7 WHEN EDMT API block status `owner mismatch` veya `tx hash mismatch` döndürüyorsa THEN sistem `successful_mint` yapmamalı; `minted_elsewhere` veya manual review olarak bırakmalı

2.8 WHEN dropped resolution tamamlandıktan sonra tüm `review_required` kayıtlar temizlendiyse THEN `hasReviewRequiredTx()` `false` döndürmeli ve automint oturumu normal şekilde başlayabilmeli

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `getTransaction(txHash)` null değil (tx pending/mempool'da görünüyor) ise THEN sistem bu tx'i dropped olarak işaretlemeye DEVAM ETMEMELİ; `review_required` olarak bırakmaya DEVAM ETMELİ

3.2 WHEN mevcut reconciler `receipt.status = 1` + EDMT owner match + tx hash match koşullarını sağlayan bir `review_required` kaydı işliyorsa THEN `MARK_FINALIZED` kararı vermeye DEVAM ETMELİ; dropped resolution bu yolu etkilememeli

3.3 WHEN `--fix-dropped` flag'i kullanılmadan `npm run reconcile` veya `npm run reconcile -- --fix` çalıştırıldığında THEN dropped resolution mantığı çalışmamalı; mevcut reconcile davranışı değişmemeli

3.4 WHEN `txs` tablosunda `status = 'pending'` veya `status = 'included'` olan kayıtlar varsa THEN `TxMonitor.poll()` bu kayıtları normal lifecycle'ına göre işlemeye DEVAM ETMELİ; dropped resolution bu kayıtlara dokunmamalı

3.5 WHEN `block_results` tablosunda `status = 'successful_mint'` veya `status = 'finalized'` olan kayıtlar varsa THEN dropped resolution bu kayıtları değiştirmemeli

3.6 WHEN dropped resolution dry-run modunda çalıştırıldığında THEN DB'ye hiçbir yazma yapılmamalı; mevcut `review_required` statüsü korunmalı

3.7 WHEN kanıt yetersizse (latestNonce <= txNonce, veya getTransaction hâlâ sonuç döndürüyor) THEN sistem körlemesine `dropped` işaretlememeli; `review_required` olarak bırakmaya DEVAM ETMELİ

---

## Bug Condition (Pseudocode)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type TxRecord  (txs tablosundan bir satır, status = 'review_required')
  OUTPUT: boolean

  // Bug tetiklenir: tx review_required statüsünde VE zincirde dropped/replaced olmuş
  // (receipt yok, getTransaction yok, latestNonce ilerlemis)
  RETURN X.status = 'review_required'
         AND getTransactionReceipt(X.tx_hash) = null
         AND getTransaction(X.tx_hash) = null
         AND latestNonce(walletAddress) > X.nonce
END FUNCTION
```

```pascal
// Property: Fix Checking — dropped tx'ler güvenli şekilde çözüme kavuşturulmalı
FOR ALL X WHERE isBugCondition(X) DO
  result ← resolveDroppedTx'(X)
  ASSERT result.txStatus = 'dropped'
  ASSERT result.decision IN ('MARK_DROPPED_RETRYABLE', 'MARK_DROPPED_MINTED')
  ASSERT hasReviewRequiredTx() = false  // automint artık başlayabilmeli
END FOR
```

```pascal
// Property: Preservation Checking — kanıtsız dropped işaretleme yapılmamalı
FOR ALL X WHERE NOT isBugCondition(X) DO
  // getTransaction null değil (pending) → review_required kalmalı
  // latestNonce <= txNonce → review_required kalmalı
  ASSERT resolveDroppedTx'(X).txStatus = 'review_required'
         OR resolveDroppedTx'(X).decision = 'LEAVE_REVIEW_REQUIRED'
END FOR
```

```pascal
// Property: Preservation Checking — --fix-dropped olmadan dropped resolution çalışmamalı
FOR ALL X WHERE isBugCondition(X) AND fixDropped = false DO
  ASSERT reconcile(X, fixDropped=false).decision = 'LEAVE_REVIEW_REQUIRED'
  ASSERT X.status = 'review_required'  // değişmemeli
END FOR
```
