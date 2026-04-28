# Implementation Plan: Pipeline Auto Mint Mode

## Overview

Mevcut `AutoMintRunner` döngüsünü, finality beklenmeksizin birden fazla tx'i eş zamanlı olarak "uçuşta" tutabilen pipeline moduna genişletir. Uygulama sırası: tip genişletmeleri → logger → config → db → ethClient → autoMintRunner refactoring → mintExecutor güncellemesi → .env.example → testler → dokümantasyon → final checkpoint.

## Tasks

- [x] 1. types.ts — Yeni StopReason değerleri ekle
  - `StopReason` union type'ına `"pending_tx_failure_detected"` ve `"nonce_anomaly_detected"` değerlerini ekle
  - `src/types.ts` dosyasını düzenle
  - _Requirements: 6.2, 6.3_

- [x] 2. logger.ts — Yeni PIPELINE_* LogEvent sabitleri ekle
  - `LogEvent` nesnesine şu sabitleri ekle: `PIPELINE_MODE_ENABLED`, `PIPELINE_TX_SPACING_WAIT`, `PIPELINE_PENDING_CAPACITY_AVAILABLE`, `PIPELINE_PENDING_CAPACITY_FULL`, `PIPELINE_TX_SUBMITTED`, `PIPELINE_MONITOR_POLL`, `PIPELINE_FINALIZED_RECONCILED`, `PIPELINE_NONCE_ANOMALY`, `PIPELINE_DUPLICATE_PREVENTED`
  - `src/logger.ts` dosyasını düzenle
  - _Requirements: 9.1–9.9_

- [x] 3. config.ts — 7 yeni pipeline alanı ekle
  - `config` nesnesine şu alanları ekle: `autoMintPipelineMode`, `autoMintMaxPendingTxs`, `autoMintMaxUnfinalizedTxs`, `autoMintTxSpacingMs`, `autoMintStopOnPendingTxFailure`, `autoMintReconcileIntervalMs`, `autoMintRequireIncludedBeforeNextTx`
  - Varsayılan değerler: `false`, `3`, `10`, `30000`, `true`, `12000`, `false`
  - `src/config.ts` dosyasını düzenle
  - _Requirements: 1.1–1.7_

  - [ ]* 3.1 Write property test for config integer parse round-trip
    - **Property 1: Config Integer Parse Round-Trip**
    - `AUTO_MINT_MAX_PENDING_TXS`, `AUTO_MINT_MAX_UNFINALIZED_TXS`, `AUTO_MINT_TX_SPACING_MS`, `AUTO_MINT_RECONCILE_INTERVAL_MS` için geçerli non-negative integer string → parse → orijinal değer eşitliği
    - `tests/config.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.6**

  - [ ]* 3.2 Write property test for config boolean parse round-trip
    - **Property 2: Config Boolean Parse Round-Trip**
    - `AUTO_MINT_PIPELINE_MODE`, `AUTO_MINT_STOP_ON_PENDING_TX_FAILURE`, `AUTO_MINT_REQUIRE_INCLUDED_BEFORE_NEXT_TX` için `"true"/"false"/"1"/"0"` → parse → doğru boolean değeri
    - `tests/config.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 1.1, 1.5, 1.7**

- [x] 4. db.ts — 3 yeni sorgu fonksiyonu ekle
  - `getPendingTxCount()`: `SELECT COUNT(*) FROM txs WHERE status = 'pending'` — pipeline kapasite kontrolü için
  - `getUnfinalizedTxCount()`: `SELECT COUNT(*) FROM txs WHERE status IN ('pending', 'included')` — pipeline kapasite kontrolü için
  - `isBlockSubmittedOrBeyond(block: number)`: `block_results` tablosunda o block için status ∈ {submitted, included, finalized, successful_mint, review_required, failed} kontrolü — duplicate prevention için
  - `src/db.ts` dosyasını düzenle
  - _Requirements: 2.3, 2.4, 5.3, 5.4_

  - [ ]* 4.1 Write unit tests for new db query functions
    - `getPendingTxCount()`, `getUnfinalizedTxCount()`, `isBlockSubmittedOrBeyond()` için in-memory SQLite ile unit testler yaz
    - Edge case'ler: boş tablo, mixed status'lar, boundary değerleri
    - `tests/db.test.ts` dosyasına ekle
    - _Requirements: 2.3, 2.4, 5.3, 5.4_

- [x] 5. ethClient.ts — getPendingNonce fonksiyonu ekle
  - `getPendingNonce(address: string): Promise<number>` fonksiyonunu ekle
  - `provider.getTransactionCount(address, "pending")` wrapper'ı; mevcut `withRetry` helper'ını kullan
  - `src/ethClient.ts` dosyasını düzenle
  - _Requirements: 4.1_

- [x] 6. checkpoint.ts — "submitted" status desteği ekle
  - `advanceScannedBlock` fonksiyonunun `status` parametresine `"submitted"` değerini ekle
  - `ADVANCE_STATUSES` set'ine `"submitted"` ekle veya explicit `"submitted"` case'i handle et
  - `src/checkpoint.ts` dosyasını düzenle
  - _Requirements: 5.1_

- [x] 7. autoMintRunner.ts — Pipeline loop refactoring
  - `SessionState` interface'ine `lastTxSentAt: number`, `stopNewTx: boolean`, `stopReason: StopReason` alanlarını ekle
  - `checkPipelineCapacity(pendingCount, unfinalizedCount, maxPending, maxUnfinalized): "ok" | "pending_full" | "unfinalized_full"` yardımcı fonksiyonunu ekle
  - `checkPipelineStopConditions(state): Promise<StopReason | null>` yardımcı fonksiyonunu ekle
  - `AUTO_MINT_PIPELINE_MODE=true` olduğunda yeni pipeline loop'u uygula:
    - ① Pre-checks (emergency stop, session limits, balance)
    - ② Monitor Phase: `TxMonitor.poll()` çağır, `PIPELINE_MONITOR_POLL` log yaz
    - ③ Stop condition check (`review_required` / `failed` + flag)
    - ④ Capacity check: `getPendingTxCount()` ve `getUnfinalizedTxCount()` ile kapasite kontrolü
    - ⑤ Tx spacing check: `Date.now() - lastTxSentAt < autoMintTxSpacingMs` ise `PIPELINE_TX_SPACING_WAIT` log yaz, sleep, continue
    - ⑥ Scan/Send Phase: `decideBlock()` → `execute(blockResult, { mode: "automint", pipelineMode: true, expectedNonce })` → scan checkpoint ilerlet → `lastTxSentAt` güncelle
    - ⑦ `sleep(autoMintReconcileIntervalMs)`
  - Nonce anomaly tespiti: `getPendingNonce()` ile nonce kontrolü, anomaly durumunda `PIPELINE_NONCE_ANOMALY` log yaz, `stopNewTx=true`, `nonce_anomaly_detected` stop reason
  - Session başlangıcında `PIPELINE_MODE_ENABLED` log yaz
  - `AUTO_MINT_PIPELINE_MODE=false` olduğunda mevcut davranış korunur
  - `src/autoMintRunner.ts` dosyasını düzenle
  - _Requirements: 1.8, 2.1–2.6, 3.1–3.4, 4.3, 4.4, 6.1–6.4, 7.1, 7.2, 8.1–8.5, 9.1–9.8_

  - [ ]* 7.1 Write property test for pipeline capacity control invariant
    - **Property 3: Pipeline Kapasite Kontrolü İnvariantı**
    - `(pendingCount, unfinalizedCount, maxPending, maxUnfinalized)` kombinasyonları için `checkPipelineCapacity` fonksiyonunu test et
    - `pendingCount >= maxPending` VEYA `unfinalizedCount >= maxUnfinalized` → result !== "ok"
    - Her ikisi de sınırın altında → result === "ok"
    - `tests/autoMintRunner.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 2.3, 2.4, 2.5**

  - [ ]* 7.2 Write property test for tx spacing invariant
    - **Property 4: Tx Spacing İnvariantı**
    - `(lastTxSentAt, txSpacingMs)` çiftleri için spacing kontrolü mantığını test et
    - `Date.now() - lastTxSentAt < txSpacingMs` → tx gönderilmemeli
    - `Date.now() - lastTxSentAt >= txSpacingMs` → tx gönderimine izin verilmeli
    - `tests/autoMintRunner.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 3.2, 3.3**

  - [ ]* 7.3 Write property test for scan checkpoint advancement invariant
    - **Property 5: Scan Checkpoint İlerleme İnvariantı**
    - Pipeline modunda tx submit edilen her block N için `last_scanned_block` en az N+1'e ilerlemeli
    - `unknown` status'ta checkpoint ilerlememelidir
    - `tests/autoMintRunner.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 5.1, 5.5**

  - [ ]* 7.4 Write property test for error stop invariant
    - **Property 9: Hata Durdurma İnvariantı**
    - `stopNewTx=true` olduğunda (review_required, failed+flag, nonce anomaly) pipeline loop'un `execute()` çağırmaması
    - `tests/autoMintRunner.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [ ]* 7.5 Write property test for pipeline mode=false backward compatibility
    - **Property 10: Pipeline Mode=false Backward Compatibility İnvariantı**
    - `AUTO_MINT_PIPELINE_MODE=false` ve `hasPendingTx()=true` → `execute()` çağrılmamalı
    - `tests/autoMintRunner.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 1.8, 2.6**

  - [ ]* 7.6 Write property test for fee filtering scan continuity
    - **Property 11: Fee Filtering Scan Continuity İnvariantı**
    - `feeRequired=true` + `onlyNoFeeBlocks=true` → block atlanır, checkpoint ilerler, session durmuyor
    - `tests/autoMintRunner.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 7.1**

  - [ ]* 7.7 Write property test for session limit invariant in pipeline mode
    - **Property 12: Session Limit İnvariantı (Pipeline Mode)**
    - `txSentThisSession >= AUTO_MINT_MAX_TX_PER_SESSION` → session `session_tx_limit_reached` ile durur
    - `tests/autoMintRunner.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 8.1**

- [x] 8. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. mintExecutor.ts — Pipeline nonce + duplicate prevention güncellemesi
  - `execute()` fonksiyonunun `opts` parametresine `pipelineMode?: boolean` ve `expectedNonce?: number` ekle
  - Gate 10 (pending tx check): `opts.pipelineMode=true` olduğunda bypass et; nonce yönetimi pipeline'dan gelir
  - Gate 9 (duplicate prevention): `isBlockSubmittedOrBeyond(block)` kontrolü ekle; duplicate tespit edildiğinde `PIPELINE_DUPLICATE_PREVENTED` log yaz, `skipped_duplicate_tx` döndür
  - Pipeline modunda `expectedNonce` ile nonce doğrulaması yap; uyuşmazlıkta `PIPELINE_NONCE_ANOMALY` log yaz
  - `src/mintExecutor.ts` dosyasını düzenle
  - _Requirements: 4.1, 4.2, 5.3, 5.4, 9.9_

  - [ ]* 9.1 Write property test for duplicate tx prevention invariant
    - **Property 7: Duplicate Tx Önleme İnvariantı**
    - `block_results`'ta status ∈ {submitted, included, finalized, successful_mint, review_required, failed} olan block N için `execute()` → `skipped_duplicate_tx` döndürmeli, yeni tx gönderilmemeli
    - `tests/mintExecutor.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 5.3, 5.4**

  - [ ]* 9.2 Write property test for nonce uniqueness invariant
    - **Property 8: Nonce Uniqueness İnvariantı**
    - Pipeline modunda N ardışık tx için tüm nonce değerleri distinct olmalı
    - `tests/mintExecutor.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 4.1, 4.2**

  - [ ]* 9.3 Write property test for mint checkpoint finality invariant
    - **Property 6: Mint Checkpoint Finality İnvariantı**
    - `last_successful_mint_block` yalnızca finality (64+ conf) + EDMT owner match sonrası ilerlemeli
    - pending, included, failed, review_required durumlarında ilerlememelidir
    - `tests/mintExecutor.test.ts` veya `tests/txMonitor.test.ts` dosyasına ekle; `fc.assert(fc.property(...), { numRuns: 100 })`
    - **Validates: Requirements 5.2**

- [x] 10. .env.example — Yeni pipeline değişkenlerini ekle
  - Tüm yeni `AUTO_MINT_PIPELINE_*` değişkenlerini Türkçe açıklamalarıyla birlikte `.env.example` dosyasına ekle:
    - `AUTO_MINT_PIPELINE_MODE`, `AUTO_MINT_MAX_PENDING_TXS`, `AUTO_MINT_MAX_UNFINALIZED_TXS`, `AUTO_MINT_TX_SPACING_MS`, `AUTO_MINT_STOP_ON_PENDING_TX_FAILURE`, `AUTO_MINT_RECONCILE_INTERVAL_MS`, `AUTO_MINT_REQUIRE_INCLUDED_BEFORE_NEXT_TX`
  - `.env.example` dosyasını düzenle
  - _Requirements: 10.3_

- [x] 11. README ve RUNBOOK güncelleme
  - `README.md`'ye "Pipeline Auto Mint Mode" başlıklı bölüm ekle: tüm yeni config değişkenleri, varsayılan değerleri ve önerilen production profili
  - `RUNBOOK.md`'ye pipeline moduna özgü operasyonel prosedürler, izleme adımları ve sorun giderme rehberi ekle
  - _Requirements: 10.1, 10.2_

- [x] 12. Final checkpoint — npm test + build + lint + format:check
  - `npm test` (vitest --run) çalıştır, tüm testlerin geçtiğini doğrula
  - `npm run build` çalıştır, TypeScript derleme hatası olmadığını doğrula
  - `npm run lint` çalıştır, ESLint hatası olmadığını doğrula
  - `npm run format:check` çalıştır, Prettier uyumsuzluğu olmadığını doğrula
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- `*` ile işaretli sub-task'lar opsiyoneldir; MVP için atlanabilir
- Her task belirli requirement'lara referans verir (traceability)
- Property testler `fast-check` kütüphanesi ile yazılır: `import fc from "fast-check"`; minimum 100 iterasyon
- Pipeline mode=false olduğunda mevcut tüm davranışlar değişmeden korunur (Gate 1–12 bypass edilmez)
- `checkPipelineCapacity` ve `checkPipelineStopConditions` fonksiyonları test edilebilirlik için `autoMintRunner.ts`'den export edilmelidir
