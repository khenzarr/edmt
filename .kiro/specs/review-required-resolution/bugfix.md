# Bugfix Requirements Document

## Introduction

Automint oturumu, veritabanında `review_required` statüsünde kayıt bulunduğunda başlamayı reddediyor. Bu kayıtlar; geçici EDMT API erişim sorunları, owner mismatch veya uzun süre bekleyen tx gibi nedenlerle oluşuyor. Ancak bu kayıtların bir kısmı aslında zincirde başarıyla finalize edilmiş durumda — sadece doğrulama adımı tamamlanmamış. Bu bugfix, `review_required` kayıtlarını çok adımlı doğrulama süreci ile inceleyip gerçekten finalize edilmiş olanları `finalized` / `successful_mint` statüsüne geçirerek automint'in yeniden başlamasını sağlar.

Etkilenen tablolar:
- `txs.status = 'review_required'`
- `block_results.status = 'review_required'`

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `txs` tablosunda `status = 'review_required'` olan en az bir kayıt varsa THEN sistem `hasReviewRequiredTx()` kontrolünden `true` döndürür ve automint oturumu `review_required_detected` stop reason ile başlamaz

1.2 WHEN `block_results` tablosunda `status = 'review_required'` olan bir kayıt, zincirde `receipt.status = 1` ile finalize edilmiş olsa bile THEN sistem bu kaydı doğrulamadan `review_required` olarak bırakır ve automint'i engellemeye devam eder

1.3 WHEN bir `review_required` kaydının tx hash'i mevcut olup receipt alınabilir durumda olsa THEN sistem receipt kontrolü yapmadan kaydı olduğu gibi bırakır

1.4 WHEN EDMT API'den alınan block status `minted_by` alanı bizim wallet adresimizle eşleşse ve `mint_tx_hash` aynı olsa THEN sistem bu doğrulamayı otomatik olarak gerçekleştirmez; kayıt `review_required` olarak kalır

1.5 WHEN `review_required` kayıtları temizlenmeden `npm run automint` çalıştırılmaya çalışıldığında THEN sistem her seferinde `review_required_detected` ile durur ve mint işlemi hiç başlamaz

### Expected Behavior (Correct)

2.1 WHEN bir `review_required` tx kaydı için tx hash mevcutsa THEN sistem `getTransactionReceipt(txHash)` çağırarak `receipt.status = 1` olup olmadığını kontrol etmeli ve başarılı receipt varsa doğrulama adımlarına devam etmeli

2.2 WHEN receipt.status = 1 doğrulandıktan sonra EDMT API'den `getBlockStatus(block)` çağrıldığında `minted_by` bizim wallet adresimizle eşleşiyor ve `mint_tx_hash` aynıysa THEN sistem `txs.status = 'finalized'`, `block_results.status = 'successful_mint'` olarak güncellenmeli ve `last_successful_mint_block` checkpoint'i gerekirse güncellenmeli

2.3 WHEN doğrulama başarısız olursa (receipt yok, receipt.status ≠ 1, owner mismatch, EDMT API erişilemiyor) THEN sistem kaydı `review_required` olarak bırakmalı ve başarısızlık sebebini raporlamalı; automint başlatılmamalı

2.4 WHEN tüm `review_required` kayıtlar başarıyla doğrulanıp temizlendikten sonra THEN sistem `hasReviewRequiredTx()` kontrolünden `false` döndürmeli ve automint oturumu normal şekilde başlayabilmeli

2.5 WHEN doğrulama süreci tamamlandığında THEN sistem her kayıt için doğrulama sonucunu (başarılı/başarısız ve sebebi) raporlamalı

### Unchanged Behavior (Regression Prevention)

3.1 WHEN bir tx kaydı `review_required` statüsüne geçirildiğinde ve receipt.status ≠ 1 ise THEN sistem bu kaydı `review_required` olarak bırakmaya DEVAM ETMELİ ve automint'i engellemeye DEVAM ETMELİ

3.2 WHEN EDMT API'den alınan `minted_by` alanı bizim wallet adresimizden farklı bir adres döndürüyorsa THEN sistem owner mismatch nedeniyle kaydı `review_required` olarak bırakmaya DEVAM ETMELİ

3.3 WHEN `txs` tablosunda `status = 'pending'` veya `status = 'included'` olan kayıtlar varsa THEN `TxMonitor.poll()` bu kayıtları normal lifecycle'ına göre işlemeye DEVAM ETMELİ; doğrulama süreci bu kayıtlara dokunmamalı

3.4 WHEN `block_results` tablosunda `status = 'successful_mint'` veya `status = 'finalized'` olan kayıtlar varsa THEN doğrulama süreci bu kayıtları değiştirmemeli ve olduğu gibi bırakmalı

3.5 WHEN automint oturumu çalışırken `autoMintStopOnReviewRequired = true` konfigürasyonu aktifse THEN yeni oluşan `review_required` kayıtları hâlâ automint'i durdurmalı; bu davranış değişmemeli

3.6 WHEN `finalized` veya `successful_mint` statüsüne geçirilen bir kayıt için `last_successful_mint_block` checkpoint'i zaten daha yüksek bir değere sahipse THEN checkpoint güncellenmemeli, mevcut değer korunmalı

---

## Bug Condition (Pseudocode)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type TxRecord
  OUTPUT: boolean

  // Bug tetiklenir: tx review_required statüsünde VE zincirde başarıyla finalize edilmiş
  RETURN X.status = 'review_required'
         AND receipt(X.tx_hash).status = 1
         AND edmt_api(X.block).minted_by = walletAddress
         AND edmt_api(X.block).mint_tx_hash = X.tx_hash
END FUNCTION
```

```pascal
// Property: Fix Checking — review_required kayıtlar doğrulanıp temizlenmeli
FOR ALL X WHERE isBugCondition(X) DO
  result ← resolveReviewRequired'(X)
  ASSERT result.txStatus = 'finalized'
  ASSERT result.blockStatus = 'successful_mint'
  ASSERT hasReviewRequiredTx() = false  // automint artık başlayabilmeli
END FOR
```

```pascal
// Property: Preservation Checking — doğrulanamayan kayıtlar değişmemeli
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT resolveReviewRequired'(X).txStatus = 'review_required'
  ASSERT hasReviewRequiredTx() = true   // automint hâlâ engellenmeli
END FOR
```
