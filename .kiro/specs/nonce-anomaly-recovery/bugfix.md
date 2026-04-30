# Bugfix Requirements Document

## Introduction

Pipeline modunda başarılı mint işlemlerinin ardından `nonce_anomaly_detected` stop reason ile session kapanıyor. Bu durum, tüm tx'ler finalize olduktan sonra RPC pending nonce'unun geçici olarak geride kalmasından kaynaklanıyor olabilir; ancak mevcut kod bu durumu "gerçek anomaly" olarak değerlendirip session'ı hemen kapatıyor.

Düzeltme: `nonce_anomaly_detected` tetiklendiğinde session hemen kapatılmamalı. Bunun yerine sistem monitor-only moda geçmeli, tüm aktif tx'ler finalize olana kadar izlemeli ve ardından nonce reconcile yapmalıdır. Reconcile başarılıysa session devam etmeli; yalnızca reconcile başarısız olursa session kapatılmalıdır.

Etkilenen session örneği:
- Session ID: `35c8184f-4a25-43d6-9663-8e82e4f5e220`
- `txSentThisSession=2`, `errors=[]`, son tx finalized, owner doğrulandı
- `checkpoint advanced to 24973827`
- `stopReason=nonce_anomaly_detected` — bu durumda session kapanmamalıydı

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN pipeline modunda nonce anomaly tespit edildiğinde (currentNonce < lastSubmittedNonce + 1 ve activeTxCount > 0) THEN sistem `stopNewTx=true` ve `stopReason=nonce_anomaly_detected` set ederek session'ı kapatır

1.2 WHEN `stopNewTx=true` iken tüm pending/included tx'ler finalize olduğunda THEN sistem `state.stopReason` (yani `nonce_anomaly_detected`) ile session'ı kapatır, nonce reconcile denemez

1.3 WHEN nonce anomaly sonrası session kapandığında THEN lock file release edilir ve operatörün manuel restart yapması gerekir

1.4 WHEN reconcile koşulları sağlanmış olsa bile (activeTxCount=0, failedCount=0, reviewRequiredCount=0, latestNonce==pendingNonce, latestNonce >= maxFinalizedNonce+1) THEN sistem bunu tespit etmez ve session'ı yeniden başlatmaz

### Expected Behavior (Correct)

2.1 WHEN pipeline modunda nonce anomaly tespit edildiğinde THEN sistem `stopNewTx=true` yapmalı, `stopReason=nonce_anomaly_detected` set etmeli, ancak session'ı hemen kapatmamalı; monitor-only moda geçmeli

2.2 WHEN monitor-only modda tüm pending/included tx'ler (activeTxCount=0) finalize olduğunda THEN sistem nonce reconcile prosedürünü başlatmalı: latest nonce, pending nonce, DB max finalized nonce, failed count ve review_required count değerlerini sorgulamalı

2.3 WHEN reconcile koşullarının tamamı sağlandığında (activeTxCount=0 VE failedCount=0 VE reviewRequiredCount=0 VE latestNonce==pendingNonce VE latestNonce >= maxFinalizedNonce+1) THEN sistem `nonce_state_reconciled` event'ini loglamalı, `stopNewTx=false` yapmalı ve scan/send loop'a devam etmeli

2.4 WHEN reconcile koşullarından herhangi biri sağlanmadığında (failedCount>0 VEYA reviewRequiredCount>0 VEYA latestNonce!=pendingNonce VEYA latestNonce < maxFinalizedNonce+1) THEN sistem session'ı `nonce_anomaly_detected` ile kapatmalı

2.5 WHEN monitor-only modda yeni tx gönderilmediğinde THEN lock file release edilmemeli; session aktif kalmaya devam etmeli

### Unchanged Behavior (Regression Prevention)

3.1 WHEN activeTxCount > 0 iken nonce anomaly tespit edildiğinde THEN sistem SHALL CONTINUE TO `stopNewTx=true` yaparak yeni tx göndermeyi durdurmaya devam etmeli

3.2 WHEN reconcile başarısız olduğunda (koşullar sağlanmadığında) THEN sistem SHALL CONTINUE TO session'ı `nonce_anomaly_detected` ile kapatmaya devam etmeli

3.3 WHEN activeTxCount=0 ve nonce lag tespit edildiğinde (lastSubmittedNonce undefined değil, currentNonce < lastSubmittedNonce+1) THEN sistem SHALL CONTINUE TO mevcut false-positive reconcile mantığını (lastSubmittedNonce reset) uygulamaya devam etmeli

3.4 WHEN pipeline modunda normal koşullarda çalışırken THEN sistem SHALL CONTINUE TO nonce check, tx spacing, capacity check ve diğer pipeline guard'ları uygulamaya devam etmeli

3.5 WHEN emergency stop file tespit edildiğinde THEN sistem SHALL CONTINUE TO session'ı `emergency_stop_file_detected` ile kapatmaya devam etmeli

3.6 WHEN session limit (maxTxPerSession, maxTxPerDay, maxRuntime) aşıldığında THEN sistem SHALL CONTINUE TO session'ı ilgili stop reason ile kapatmaya devam etmeli

3.7 WHEN review_required veya failed tx tespit edildiğinde (pipeline stop conditions) THEN sistem SHALL CONTINUE TO bu koşulları stop trigger olarak değerlendirmeye devam etmeli; bu koşullar reconcile'ı da engellemelidir

---

## Bug Condition (Pseudocode)

**Bug Condition Function:**
```pascal
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

**Fix Checking Property:**
```pascal
// Property: Recoverable nonce anomaly session'ı kapatmaz
FOR ALL X WHERE isBugCondition(X) DO
  result ← runPipelineLoop'(X)
  ASSERT result.stopReason ≠ "nonce_anomaly_detected"
  ASSERT result.sessionContinued = true
  ASSERT result.nonceStateReconciled = true
END FOR
```

**Preservation Property:**
```pascal
// Property: Unrecoverable anomaly hâlâ session'ı kapatır
FOR ALL X WHERE NOT isBugCondition(X) AND X.nonceAnomalyDetected = true DO
  ASSERT F(X) = F'(X)  // session kapanır, davranış değişmez
END FOR
```
