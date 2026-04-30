# Bugfix Requirements Document

## Introduction

`MintExecutor` içindeki Gate 9 (`duplicate_tx` gate), `getTxByBlock(block)` ile bir tx kaydı bulduğunda tx'in `status` değerine bakmaksızın her zaman mint işlemini engelliyor. Bu nedenle `txs.status = 'dropped'` olan bir tx kaydı varsa (force-drop sonrası terminal statüse geçirilmiş), block `retryable` yapılmış ve EDMT `mintable` döndürüyor olsa bile yeni mint denemesi `mint_gate_failed gate=duplicate_tx existingStatus=dropped` hatasıyla bloklanıyor.

Production örneği: Block 24987965, eski tx `0x3fc11effe8171e8dcd27dc88c64b8843b9e1bebecabc967bc241234fd060c131` force-drop ile `dropped` statüsüne alındı, block `retryable` yapıldı, EDMT `mintable` döndürüyor — ancak live run sırasında Gate 9 yeni mint denemesini engelliyor.

`dropped` ve `failed` statüsleri terminal/resolved statüslerdir; bu tx'ler artık aktif değildir. Duplicate guard yalnızca aktif statüsler (`pending`, `submitted`, `included`, `finalized`, `successful_mint`) için bloklamalıdır.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `getTxByBlock(block)` bir tx kaydı döndürdüğünde ve `existingTx.status = 'dropped'` olduğunda THEN sistem `mint_gate_failed gate=duplicate_tx existingStatus=dropped` logu yazarak mint işlemini engeller; dropped tx terminal statüste olmasına rağmen aktif duplicate gibi değerlendirilir

1.2 WHEN `getTxByBlock(block)` bir tx kaydı döndürdüğünde ve `existingTx.status = 'failed'` olduğunda THEN sistem mint işlemini engeller; failed tx terminal statüste olmasına rağmen aktif duplicate gibi değerlendirilir

1.3 WHEN block `retryable` statüsüne alınmış ve EDMT `mintable` döndürüyor olduğunda ve DB'de aynı block için `dropped` statüsünde bir tx kaydı bulunduğunda THEN sistem yeni mint denemesine izin vermez; force-drop + retryable akışı işlevsiz kalır

### Expected Behavior (Correct)

2.1 WHEN `getTxByBlock(block)` bir tx kaydı döndürdüğünde ve `existingTx.status = 'dropped'` olduğunda THEN sistem bu tx'i aktif duplicate olarak değerlendirmemeli ve mint işlemine izin vermeli

2.2 WHEN `getTxByBlock(block)` bir tx kaydı döndürdüğünde ve `existingTx.status = 'failed'` olduğunda THEN sistem bu tx'i aktif duplicate olarak değerlendirmemeli ve mint işlemine izin vermeli

2.3 WHEN `getTxByBlock(block)` bir tx kaydı döndürdüğünde ve `existingTx.status IN ('pending', 'submitted', 'included', 'finalized', 'successful_mint')` olduğunda THEN sistem `skipped_duplicate_tx` döndürerek mint işlemini engellemeye DEVAM ETMELİ

2.4 WHEN `getTxByBlock(block)` `undefined` döndürdüğünde (block için hiç tx kaydı yok) THEN sistem mint işlemine izin vermeli

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `existingTx.status = 'pending'` olduğunda THEN sistem `skipped_duplicate_tx` döndürerek mint işlemini engellemeye DEVAM ETMELİ

3.2 WHEN `existingTx.status = 'submitted'` olduğunda THEN sistem `skipped_duplicate_tx` döndürerek mint işlemini engellemeye DEVAM ETMELİ

3.3 WHEN `existingTx.status = 'included'` olduğunda THEN sistem `skipped_duplicate_tx` döndürerek mint işlemini engellemeye DEVAM ETMELİ

3.4 WHEN `existingTx.status = 'finalized'` olduğunda THEN sistem `skipped_duplicate_tx` döndürerek mint işlemini engellemeye DEVAM ETMELİ

3.5 WHEN `existingTx.status = 'successful_mint'` olduğunda THEN sistem `skipped_duplicate_tx` döndürerek mint işlemini engellemeye DEVAM ETMELİ

3.6 WHEN block için hiç tx kaydı yoksa THEN sistem mint işlemine izin vermeye DEVAM ETMELİ

3.7 WHEN pipeline mode aktifken `isBlockSubmittedOrBeyond(block)` `true` döndürdüğünde THEN pipeline duplicate prevention gate değişmemeli; bu gate ayrı çalışmaya DEVAM ETMELİ

---

## Bug Condition (Pseudocode)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type TxRecord  (txs tablosundan bir satır)
  OUTPUT: boolean

  // Bug tetiklenir: block için mevcut tx terminal statüste (dropped veya failed)
  // ancak Gate 9 bunu aktif duplicate gibi değerlendiriyor
  RETURN X.status IN ('dropped', 'failed')
END FUNCTION
```

```pascal
// Property: Fix Checking — terminal statüsteki tx'ler mint'i engellememelidir
FOR ALL X WHERE isBugCondition(X) DO
  result ← execute'(blockResult)   // getTxByBlock(block) = X döndürüyor
  ASSERT result.status != 'skipped_duplicate_tx'
  // Diğer gate'ler geçilirse mint devam etmeli
END FOR
```

```pascal
// Property: Preservation Checking — aktif statüsteki tx'ler hâlâ engellenmeli
FOR ALL X WHERE NOT isBugCondition(X)
             AND X.status IN ('pending', 'submitted', 'included', 'finalized', 'successful_mint') DO
  result ← execute'(blockResult)   // getTxByBlock(block) = X döndürüyor
  ASSERT result.status = 'skipped_duplicate_tx'
END FOR
```

```pascal
// Property: Preservation Checking — tx kaydı yoksa mint devam etmeli
FOR ALL blockResult WHERE getTxByBlock(blockResult.block) = undefined DO
  // Gate 9 geçilmeli; diğer gate'ler bağımsız çalışmaya devam etmeli
  ASSERT Gate9 does NOT block mint
END FOR
```
