# Nonce Anomaly Recovery Bugfix Design

## Overview

Pipeline modunda `nonce_anomaly_detected` tetiklendiğinde sistem `stopNewTx=true` yapıp monitor-only moda geçiyor, ancak tüm tx'ler finalize olduğunda session'ı hemen kapatıyor — nonce reconcile denemeden. Bu fix, `stopNewTx=true` + `hasPendingTx()=false` koşulu oluştuğunda session'ı kapatmak yerine nonce reconcile prosedürünü çalıştırır. Reconcile başarılıysa `stopNewTx=false` yapılır ve loop devam eder; yalnızca reconcile başarısız olursa session `nonce_anomaly_detected` ile kapatılır.

Etkilenen dosya: `src/autoMintRunner.ts` — pipeline loop içindeki `stopNewTx=true` exit path'i.

## Glossary

- **Bug_Condition (C)**: `nonceAnomalyDetected=true AND activeTxCount=0 AND failedCount=0 AND reviewRequiredCount=0 AND latestNonce==pendingNonce AND latestNonce >= maxFinalizedNonce+1` — session'ın kapatılmaması gereken recoverable durum
- **Property (P)**: Recoverable nonce anomaly durumunda session kapanmaz; `nonce_state_reconciled` loglanır, `stopNewTx=false` yapılır, loop devam eder
- **Preservation**: Unrecoverable anomaly (failed/review_required tx var, veya nonce mismatch devam ediyor) hâlâ session'ı kapatır; diğer tüm pipeline davranışları değişmez
- **nonceAnomalyDetected**: `state.stopReason === "nonce_anomaly_detected"` — pipeline loop'ta nonce anomaly nedeniyle `stopNewTx=true` set edilmiş durum
- **activeTxCount**: `getUnfinalizedTxCount()` — DB'de `status IN ('pending', 'included')` olan tx sayısı
- **failedCount**: `hasFailedTx()` — DB'de `status = 'failed'` olan tx var mı
- **reviewRequiredCount**: `hasReviewRequiredTx()` — DB'de `status = 'review_required'` olan tx var mı
- **latestNonce**: `getTransactionCount(address, "latest")` — on-chain confirmed nonce
- **pendingNonce**: `getPendingNonce(address)` — RPC pending nonce (`getTransactionCount(address, "pending")`)
- **maxFinalizedNonce**: DB'deki finalized tx'lerin max nonce değeri — `getMaxFinalizedNonce()` (yeni DB helper)
- **monitor-only mode**: `stopNewTx=true` iken yeni tx gönderilmez, TxMonitor.poll() çalışmaya devam eder
- **runAutoMint**: `src/autoMintRunner.ts` içindeki ana session fonksiyonu

## Bug Details

### Bug Condition

Bug, pipeline modunda nonce anomaly tespit edildikten sonra tüm tx'ler finalize olduğunda tetiklenir. `runAutoMint` pipeline loop'u, `stopNewTx=true` ve `!hasPendingTx()` koşulunu görünce nonce reconcile denemeden `state.stopReason` (yani `nonce_anomaly_detected`) ile session'ı kapatır.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type PipelineSessionState
  OUTPUT: boolean

  // Bug tetiklenir: nonce anomaly var, tüm tx'ler finalize olmuş,
  // reconcile koşulları sağlanmış, ama sistem session'ı kapatıyor
  RETURN X.nonceAnomalyDetected = true
     AND X.activeTxCount = 0
     AND X.failedCount = 0
     AND X.reviewRequiredCount = 0
     AND X.latestNonce = X.pendingNonce
     AND X.latestNonce >= X.maxFinalizedNonce + 1
END FUNCTION
```

### Examples

- **Recoverable (bug tetiklenir)**: `txSentThisSession=2`, son tx finalized, `activeTxCount=0`, `failedCount=0`, `reviewRequiredCount=0`, `latestNonce=pendingNonce=5`, `maxFinalizedNonce=4` → session kapanmamalı, reconcile yapılmalı, loop devam etmeli
- **Unrecoverable — failed tx**: `activeTxCount=0`, `failedCount=1` → reconcile yapılmaz, session `nonce_anomaly_detected` ile kapanır
- **Unrecoverable — review_required**: `activeTxCount=0`, `reviewRequiredCount=1` → reconcile yapılmaz, session kapanır
- **Unrecoverable — nonce mismatch**: `latestNonce=4`, `pendingNonce=5` (latestNonce != pendingNonce) → reconcile başarısız, session kapanır
- **Unrecoverable — nonce gap**: `latestNonce=3`, `maxFinalizedNonce=4` (latestNonce < maxFinalizedNonce+1) → reconcile başarısız, session kapanır
- **Active txs (anomaly detection)**: `activeTxCount=2`, `currentNonce < lastSubmittedNonce+1` → `stopNewTx=true` set edilir, monitor-only moda geçilir (mevcut davranış korunur)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `activeTxCount > 0` iken nonce anomaly tespit edildiğinde `stopNewTx=true` yapılması ve yeni tx gönderilmemesi
- Reconcile başarısız olduğunda (koşullar sağlanmadığında) session'ın `nonce_anomaly_detected` ile kapatılması
- `activeTxCount=0` ve nonce lag tespit edildiğinde (anomaly flag olmadan) mevcut false-positive reconcile mantığının (`lastSubmittedNonce` reset) uygulanması
- Normal pipeline guard'ları: nonce check, tx spacing, capacity check, emergency stop, session limits
- `review_required` veya `failed` tx tespit edildiğinde pipeline stop condition'larının tetiklenmesi
- Lock file'ın session boyunca tutulması (monitor-only modda da release edilmemesi)

**Scope:**
Nonce anomaly recovery dışındaki tüm pipeline davranışları bu fix'ten etkilenmez. Özellikle:
- Mouse click / non-keyboard input analogu: normal tx gönderme akışı
- Emergency stop, session limit, wallet balance check'ler
- Sequential mode (pipeline=false) tamamen etkilenmez

## Hypothesized Root Cause

Mevcut kod incelendiğinde (`src/autoMintRunner.ts`, pipeline loop, `stopNewTx=true` branch):

```typescript
if (state.stopNewTx) {
  // Already flagged — keep monitoring but don't send new tx
  logger.info(..., `pipeline stopNewTx=true (${state.stopReason}) — monitoring only`);
  // If no more pending/included txs, we can exit
  if (!hasPendingTx()) {
    stopReason = state.stopReason;  // ← BUG: nonce_anomaly_detected ile direkt çıkış
    break;
  }
  await sleep(config.autoMintReconcileIntervalMs);
  continue;
}
```

**Root Cause**: `stopNewTx=true` ve `!hasPendingTx()` koşulu oluştuğunda, `state.stopReason` ne olursa olsun (nonce_anomaly_detected dahil) session direkt kapatılıyor. Nonce anomaly özelinde, tüm tx'ler finalize olduğunda reconcile yapılması gerekiyor — ancak bu logic hiç implement edilmemiş.

**Spesifik Eksiklik**: `stopReason === "nonce_anomaly_detected"` durumunda `!hasPendingTx()` koşulu oluştuğunda:
1. Nonce reconcile koşulları kontrol edilmiyor
2. `latestNonce`, `pendingNonce`, `maxFinalizedNonce`, `failedCount`, `reviewRequiredCount` sorgulanmıyor
3. Reconcile başarılıysa `stopNewTx=false` yapılmıyor

## Correctness Properties

Property 1: Bug Condition — Recoverable Nonce Anomaly Session'ı Kapatmaz

_For any_ pipeline session state where the bug condition holds (isBugCondition returns true) — yani nonce anomaly detected, activeTxCount=0, failedCount=0, reviewRequiredCount=0, latestNonce==pendingNonce, latestNonce >= maxFinalizedNonce+1 — the fixed `runAutoMint` pipeline loop SHALL NOT exit with `stopReason="nonce_anomaly_detected"`. Instead it SHALL log `nonce_state_reconciled`, set `stopNewTx=false`, and continue the scan/send loop.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — Unrecoverable Anomaly Hâlâ Session'ı Kapatır

_For any_ pipeline session state where the bug condition does NOT hold (isBugCondition returns false) AND `nonceAnomalyDetected=true` — yani reconcile koşullarından en az biri sağlanmıyor (failedCount>0 OR reviewRequiredCount>0 OR latestNonce!=pendingNonce OR latestNonce < maxFinalizedNonce+1) — the fixed `runAutoMint` SHALL produce the same result as the original: session closes with `stopReason="nonce_anomaly_detected"`, preserving all existing unrecoverable anomaly handling.

**Validates: Requirements 2.4, 3.1, 3.2**

## Fix Implementation

### Changes Required

**File**: `src/autoMintRunner.ts`

**Function**: `runAutoMint` — pipeline mode loop, `stopNewTx=true` branch

**Specific Changes**:

1. **`stopNewTx=true` + `!hasPendingTx()` exit path'ini güncelle**: `state.stopReason === "nonce_anomaly_detected"` durumunda direkt çıkmak yerine nonce reconcile prosedürünü çalıştır.

2. **Nonce reconcile prosedürü ekle**: `!hasPendingTx()` ve `state.stopReason === "nonce_anomaly_detected"` koşulunda:
   - `getUnfinalizedTxCount()` → `activeTxCount` (0 olmalı, zaten `!hasPendingTx()` ile doğrulandı)
   - `hasFailedTx()` → `failedCount`
   - `hasReviewRequiredTx()` → `reviewRequiredCount`
   - `getPendingNonce(walletAddress)` → `pendingNonce`
   - `getTransactionCount(walletAddress, "latest")` → `latestNonce` (yeni RPC çağrısı)
   - `getMaxFinalizedNonce()` → `maxFinalizedNonce` (yeni DB helper)

3. **Reconcile koşul kontrolü**:
   ```
   IF failedCount=0 AND reviewRequiredCount=0
      AND latestNonce == pendingNonce
      AND latestNonce >= maxFinalizedNonce + 1
   THEN
     log PIPELINE_NONCE_STATE_RECONCILED
     state.stopNewTx = false
     state.stopReason = "completed"  // reset
     lastSubmittedNonce = pendingNonce - 1  // align
     continue  // loop devam eder
   ELSE
     stopReason = "nonce_anomaly_detected"
     break  // session kapanır
   ```

4. **Yeni DB helper**: `src/db.ts`'e `getMaxFinalizedNonce(walletAddress?: string): number` ekle — `txs` tablosunda `status = 'finalized'` olan tx'lerin max nonce değerini döndürür. Wallet address filtresi opsiyonel (tek wallet kullanıldığından).

5. **Yeni RPC helper**: `src/ethClient.ts`'e `getLatestNonce(address: string): Promise<number>` ekle — `getTransactionCount(address, "latest")` wrapper'ı.

6. **LogEvent sabiti**: `src/logger.ts`'e `PIPELINE_NONCE_STATE_RECONCILED` zaten mevcut — kullanılacak.

### Pseudocode (Fix)

```
// stopNewTx=true branch içinde, !hasPendingTx() koşulunda:
IF state.stopReason === "nonce_anomaly_detected" THEN
  // Reconcile attempt
  TRY
    failedCount    ← hasFailedTx()
    reviewCount    ← hasReviewRequiredTx()
    pendingNonce   ← getPendingNonce(walletAddress)
    latestNonce    ← getLatestNonce(walletAddress)
    maxFinNonce    ← getMaxFinalizedNonce()

    IF NOT failedCount
       AND NOT reviewCount
       AND latestNonce = pendingNonce
       AND latestNonce >= maxFinNonce + 1
    THEN
      log PIPELINE_NONCE_STATE_RECONCILED {latestNonce, pendingNonce, maxFinNonce}
      state.stopNewTx ← false
      state.stopReason ← "completed"
      lastSubmittedNonce ← pendingNonce - 1
      CONTINUE  // loop devam eder
    ELSE
      log PIPELINE_NONCE_ANOMALY {reason: "reconcile_failed", failedCount, reviewCount, latestNonce, pendingNonce, maxFinNonce}
      stopReason ← "nonce_anomaly_detected"
      BREAK
  CATCH err
    log RPC_ERROR {err}
    stopReason ← "nonce_anomaly_detected"
    BREAK
ELSE
  // Diğer stopReason'lar için mevcut davranış
  stopReason ← state.stopReason
  BREAK
END IF
```

## Testing Strategy

### Validation Approach

İki aşamalı yaklaşım: önce bug'ı gösteren counterexample'lar üret (unfixed kod üzerinde), sonra fix'in doğruluğunu ve preservation'ı doğrula.

### Exploratory Bug Condition Checking

**Goal**: Unfixed kod üzerinde bug'ı gösteren counterexample'lar üret. Root cause analizini doğrula veya çürüt.

**Test Plan**: Pipeline loop'u mock'layarak `stopNewTx=true` + `!hasPendingTx()` koşulunu simüle et. Unfixed kod üzerinde session'ın `nonce_anomaly_detected` ile kapandığını gözlemle.

**Test Cases**:
1. **Recoverable Anomaly — Session Kapanır (unfixed)**: `nonceAnomalyDetected=true`, `activeTxCount=0`, `failedCount=0`, `reviewRequiredCount=0`, `latestNonce==pendingNonce`, `latestNonce >= maxFinalizedNonce+1` → unfixed kod `nonce_anomaly_detected` döner (will fail on fixed code)
2. **Monitor-Only Mode — Lock File Tutulur**: `stopNewTx=true`, pending tx var → lock file release edilmez
3. **Active Txs Finalize — Reconcile Tetiklenir**: Tx'ler finalize olduktan sonra reconcile prosedürü çalışır
4. **Failed Tx Varken Reconcile Yapılmaz**: `failedCount=1` → reconcile atlanır, session kapanır

**Expected Counterexamples**:
- Unfixed kod: recoverable anomaly durumunda `stopReason="nonce_anomaly_detected"` döner
- Root cause: `stopNewTx=true` + `!hasPendingTx()` path'inde reconcile logic yok

### Fix Checking

**Goal**: Bug condition sağlanan tüm input'lar için fixed fonksiyonun beklenen davranışı ürettiğini doğrula.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := runAutoMint_fixed(X)
  ASSERT result.stopReason ≠ "nonce_anomaly_detected"
  ASSERT result.sessionContinued = true
  ASSERT nonce_state_reconciled event logged
END FOR
```

### Preservation Checking

**Goal**: Bug condition sağlanmayan tüm input'lar için fixed fonksiyonun orijinal fonksiyonla aynı sonucu ürettiğini doğrula.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) AND X.nonceAnomalyDetected = true DO
  ASSERT runAutoMint_original(X).stopReason = runAutoMint_fixed(X).stopReason
  // session kapanır, davranış değişmez
END FOR
```

**Testing Approach**: Property-based testing preservation checking için önerilir çünkü:
- Farklı `failedCount`, `reviewRequiredCount`, `latestNonce`, `pendingNonce`, `maxFinalizedNonce` kombinasyonlarını otomatik üretir
- Manuel test'lerin kaçırabileceği edge case'leri yakalar
- Unrecoverable anomaly path'inin tüm kombinasyonlarda korunduğunu güçlü biçimde garanti eder

**Test Cases**:
1. **Unrecoverable — Failed Tx**: `failedCount=1` → session `nonce_anomaly_detected` ile kapanır (unfixed ile aynı)
2. **Unrecoverable — Review Required**: `reviewRequiredCount=1` → session kapanır
3. **Unrecoverable — Nonce Mismatch**: `latestNonce != pendingNonce` → session kapanır
4. **Unrecoverable — Nonce Gap**: `latestNonce < maxFinalizedNonce+1` → session kapanır
5. **Active Txs — Monitor-Only Devam**: `activeTxCount > 0` → `stopNewTx=true`, session kapanmaz (pending tx var)

### Unit Tests

- Recoverable nonce anomaly: session `nonce_anomaly_detected` ile kapanmaz, `nonce_state_reconciled` loglanır
- Active tx finalize olunca `nonce_state_reconciled` event'i tetiklenir
- Reconcile sonrası yeni tx gönderilebilir (`stopNewTx=false`)
- `failedCount > 0` varken reconcile yapılmaz, session kapanır
- `reviewRequiredCount > 0` varken reconcile yapılmaz, session kapanır
- `latestNonce != pendingNonce` → reconcile başarısız, session kapanır
- Unrecoverable mismatch → session `nonce_anomaly_detected` ile kapanır
- Lock file recoverable anomaly sırasında release edilmez

### Property-Based Tests

- Rastgele `{failedCount, reviewRequiredCount, latestNonce, pendingNonce, maxFinalizedNonce}` kombinasyonları üret: `isBugCondition=true` olanlar için session devam eder, `false` olanlar için session kapanır
- Reconcile koşullarının tüm kombinasyonlarında preservation doğrula
- `activeTxCount > 0` olan tüm state'lerde `stopNewTx=true` davranışının korunduğunu doğrula

### Integration Tests

- Full pipeline session: tx gönder → finalize bekle → nonce anomaly tetikle → reconcile → yeni tx gönder
- Monitor-only modda lock file'ın tutulduğunu doğrula
- Emergency stop'un monitor-only mod sırasında da çalıştığını doğrula
- Session limit'lerin monitor-only mod sırasında da uygulandığını doğrula
