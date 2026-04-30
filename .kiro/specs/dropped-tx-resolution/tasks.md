# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Dropped TX Tespit Edilemiyor
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing case: `receipt=null`, `getTransaction=null`, `latestNonce=15 > txNonce=12` — dropped tx tespit edilemiyor
  - Test file: `tests/reconciler.droppedTx.exploration.test.ts`
  - Test that `resolveReviewRequired()` returns `LEAVE_REVIEW_REQUIRED / receipt_missing` for a tx where `getTransactionReceipt=null`, `getTransaction=null`, `latestNonce > txNonce` (from Bug Condition in design: `isBugCondition(X)` returns true)
  - Verify `resolveDroppedTx` function does NOT exist on unfixed code (import attempt fails or returns undefined)
  - Verify `ReconcileDecision.MARK_DROPPED_RETRYABLE` does NOT exist on unfixed code
  - Verify `ReconcileOpts.fixDropped` field does NOT exist on unfixed code
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists)
  - Document counterexamples found: e.g., "unfixed code returns `receipt_missing` instead of `MARK_DROPPED_RETRYABLE`; `resolveDroppedTx` is undefined"
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Kanıtsız Dropped İşareti Yapılmamalı
  - **IMPORTANT**: Follow observation-first methodology
  - Test file: `tests/reconciler.droppedTx.preservation.test.ts`
  - Observe on UNFIXED code for non-buggy inputs (isBugCondition returns false):
    - Observe: `getTransaction` NOT null (tx pending) → `resolveReviewRequired` returns `LEAVE_REVIEW_REQUIRED` on unfixed code
    - Observe: `latestNonce <= txNonce` → `resolveReviewRequired` returns `LEAVE_REVIEW_REQUIRED` on unfixed code
    - Observe: `fixDropped=false` → dropped resolution does NOT run, `receipt_missing` decision unchanged
    - Observe: existing `MARK_FINALIZED` path (receipt.status=1 + owner match + tx hash match) → still returns `MARK_FINALIZED`
    - Observe: dry-run mode → DB never written
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements in design:
    - For all inputs where `getTransaction` is NOT null: `resolveDroppedTx` (when it exists) returns `LEAVE_REVIEW_REQUIRED` with reason `tx_still_pending`
    - For all inputs where `latestNonce <= txNonce`: returns `LEAVE_REVIEW_REQUIRED` with reason `nonce_not_advanced`
    - For all inputs where `fixDropped=false`: `reconcileAll` does NOT call dropped resolution, `receipt_missing` decision unchanged
    - Mevcut `MARK_FINALIZED` yolu (receipt=1 + owner match + tx hash match) etkilenmemeli
    - Dry-run modunda DB'ye hiçbir yazma yapılmamalı
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 3. Fix for dropped/replaced tx resolution

  - [x] 3.1 Add `dropped` to `TxStatus` and `retryable` to `BlockLifecycleStatus` in `src/types.ts`
    - Add `'dropped'` to `TxStatus` union type
    - Add `'retryable'` to `BlockLifecycleStatus` union type
    - _Bug_Condition: isBugCondition(X) where X.status = 'review_required' AND getTransactionReceipt = null AND getTransaction = null AND latestNonce > X.nonce_
    - _Expected_Behavior: txs.status = 'dropped', block_results.status = 'retryable' (if EDMT mintable) or 'minted' (if EDMT minted)_
    - _Preservation: TxStatus ve BlockLifecycleStatus değişiklikleri mevcut statüleri etkilememeli_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.2 Add `getTransaction()` helper to `src/ethClient.ts`
    - Implement `getTransaction(txHash: string): Promise<ethers.TransactionResponse | null>` using `withRetry`
    - Use `getProvider().getTransaction(txHash)` internally
    - _Bug_Condition: getTransaction(X.tx_hash) = null is required for dropped detection_
    - _Expected_Behavior: Returns null when tx is dropped/replaced, returns TransactionResponse when tx is pending_
    - _Preservation: Mevcut ethClient fonksiyonları etkilenmemeli_
    - _Requirements: 2.1, 2.4, 3.1_

  - [x] 3.3 Add new `LogEvent` constants to `src/logger.ts`
    - Add `RECONCILE_DROPPED_DETECTED: "reconcile_dropped_detected"`
    - Add `RECONCILE_DROPPED_RETRYABLE: "reconcile_dropped_retryable"`
    - Add `RECONCILE_DROPPED_MINTED: "reconcile_dropped_minted"`
    - Add `RECONCILE_TX_STILL_PENDING: "reconcile_tx_still_pending"`
    - Add `RECONCILE_NONCE_NOT_ADVANCED: "reconcile_nonce_not_advanced"`
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.4 Update `isBlockSubmittedOrBeyond()` in `src/db.ts` to exclude `retryable`
    - Remove `'retryable'` from `beyondStatuses` set (or ensure it is not included)
    - `retryable` block'lar yeni mint denemesine açık olmalı — `isBlockSubmittedOrBeyond` false dönmeli
    - _Bug_Condition: dropped tx sonrası block retryable yapılmalı ve tekrar mint denemesine açık olmalı_
    - _Expected_Behavior: isBlockSubmittedOrBeyond('retryable') = false_
    - _Preservation: 'submitted', 'included', 'finalized', 'successful_mint', 'review_required', 'failed' statüleri için davranış değişmemeli_
    - _Requirements: 2.2, 3.5_

  - [x] 3.5 Add `resolveDroppedTx()` function and new decision constants to `src/reconciler.ts`
    - Add `MARK_DROPPED_RETRYABLE` and `MARK_DROPPED_MINTED` to `ReconcileDecision` constant
    - Add `fixDropped?: boolean` field to `ReconcileOpts` interface
    - Add `dropped` and `retryable` counts to `ReconcileReport` interface
    - Implement `resolveDroppedTx(tx, opts)` function with the following flow:
      1. `getTransactionReceipt(tx.tx_hash)` — null değil ise dropped değil, mevcut akışa bırak
      2. `getTransaction(tx.tx_hash)` — null değil ise `LEAVE_REVIEW_REQUIRED` (reason: `tx_still_pending`)
      3. `getLatestNonce(walletAddress)` — `latestNonce <= tx.nonce` ise `LEAVE_REVIEW_REQUIRED` (reason: `nonce_not_advanced`)
      4. Tüm kontroller geçti — tx dropped kanıtlandı
      5. `getBlockStatus(tx.block)` çağır (EDMT API)
      6. EDMT status `mintable` → `MARK_DROPPED_RETRYABLE`
      7. EDMT status `minted` → `MARK_DROPPED_MINTED`
      8. EDMT status `unknown` / API erişilemez → `LEAVE_REVIEW_REQUIRED` (reason: `edmt_api_unavailable`)
    - Update `applyDecision()` for new decisions:
      - `MARK_DROPPED_RETRYABLE`: `txs.status = 'dropped'`, `block_results.status = 'retryable'`, reconcile_event insert
      - `MARK_DROPPED_MINTED`: `txs.status = 'dropped'`, `block_results.status = 'minted'`, reconcile_event insert
    - Update `reconcileAll()`: `opts.fixDropped = true` ise her `review_required` kayıt için önce `resolveReviewRequired()` çalıştır; `LEAVE_REVIEW_REQUIRED / receipt_missing` kararı gelirse `resolveDroppedTx()` çalıştır
    - _Bug_Condition: isBugCondition(X) where X.status = 'review_required' AND getTransactionReceipt = null AND getTransaction = null AND latestNonce(wallet) > X.nonce_
    - _Expected_Behavior: resolveDroppedTx(X).txStatus = 'dropped', decision IN ('MARK_DROPPED_RETRYABLE', 'MARK_DROPPED_MINTED'), hasReviewRequiredTx() = false_
    - _Preservation: getTransaction NOT null → LEAVE_REVIEW_REQUIRED; latestNonce <= txNonce → LEAVE_REVIEW_REQUIRED; fixDropped=false → dropped resolution çalışmamalı; MARK_FINALIZED yolu etkilenmemeli_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.7_

  - [x] 3.6 Add `--fix-dropped` flag to `reconcile` command in `src/cli.ts`
    - Add `.option("--fix-dropped", "Attempt dropped/replaced tx resolution for receipt_missing records")` to reconcile command
    - Parse `fixDropped` from opts and pass to `reconcileAll({ ..., fixDropped: opts.fixDropped })`
    - Update CLI output to report `dropped` and `retryable` decisions
    - Add `dropped` and `retryable` counts to console output
    - _Bug_Condition: --fix-dropped flag olmadan dropped resolution çalışmamalı_
    - _Expected_Behavior: npm run reconcile -- --fix-dropped çalıştırıldığında dropped resolution aktif olmalı_
    - _Preservation: --fix-dropped olmadan mevcut reconcile davranışı değişmemeli_
    - _Requirements: 2.1, 2.5, 2.6, 3.3_

  - [x] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Dropped TX Çözüme Kavuşturulmalı
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1 (`tests/reconciler.droppedTx.exploration.test.ts`)
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - Verify: `resolveDroppedTx` exists and is exported from reconciler
    - Verify: `ReconcileDecision.MARK_DROPPED_RETRYABLE` and `MARK_DROPPED_MINTED` exist
    - Verify: for `isBugCondition(X)` inputs, decision is `MARK_DROPPED_RETRYABLE` or `MARK_DROPPED_MINTED`
    - Verify: `hasReviewRequiredTx()` returns false after resolution
    - _Requirements: 2.1, 2.2, 2.3, 2.8_

  - [x] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Kanıtsız Dropped İşareti Yapılmamalı
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2 (`tests/reconciler.droppedTx.preservation.test.ts`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Verify: `getTransaction` NOT null → `LEAVE_REVIEW_REQUIRED` (tx_still_pending)
    - Verify: `latestNonce <= txNonce` → `LEAVE_REVIEW_REQUIRED` (nonce_not_advanced)
    - Verify: `fixDropped=false` → dropped resolution çalışmıyor, `receipt_missing` kararı değişmiyor
    - Verify: mevcut `MARK_FINALIZED` yolu (receipt=1 + owner match + tx hash match) hâlâ çalışıyor
    - Verify: dry-run modunda DB'ye hiçbir yazma yapılmıyor
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint — Ensure all tests pass
  - Run `npm test` — tüm testler geçmeli (exploration + preservation + mevcut testler)
  - Run `npm run build` — TypeScript derleme hatasız tamamlanmalı
  - Run `npm run lint` — lint hataları olmamalı
  - Run `npm run format:check` — format kontrolü geçmeli
  - Verify `tests/reconciler.droppedTx.exploration.test.ts` PASSES (bug fixed)
  - Verify `tests/reconciler.droppedTx.preservation.test.ts` PASSES (no regressions)
  - Verify existing `tests/reconciler.exploration.test.ts` still PASSES
  - Verify existing `tests/reconciler.preservation.test.ts` still PASSES
  - Ensure all tests pass; ask the user if questions arise.
