# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Pending TX Force-Drop Candidate Seçimi
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases: `status IN ('pending', 'included', 'submitted')` + `forceDrop=true` + `txFilter=HASH` → `report.total = 0` (bug kanıtı)
  - Test file: `tests/reconciler.forceDrop.pendingTx.exploration.test.ts`
  - Mock `getReviewRequiredTxs()` to return empty list (tx is NOT review_required)
  - Mock `getStuckTxByHash()` as undefined/not-exported (function does not exist on unfixed code)
  - Test that `reconcileAll({ forceDrop: true, txFilter: HASH, fixDropped: true })` returns `report.total = 0` for a `pending` tx (from Bug Condition in design: `isBugCondition(X)` returns true)
  - Verify `getStuckTxByHash` function does NOT exist in `src/db.ts` on unfixed code (import attempt returns undefined)
  - Test the same for `status = 'included'` and `status = 'submitted'` — all three return `report.total = 0` on unfixed code
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists)
  - Document counterexamples found: e.g., `"reconcileAll({ forceDrop: true, txFilter: '0x3fc11effe...' }) returns report.total = 0 — pending tx never enters candidate list; getStuckTxByHash is undefined"`
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Force-Drop Olmadan Pending TX'lere Dokunulmamalı
  - **IMPORTANT**: Follow observation-first methodology
  - Test file: `tests/reconciler.forceDrop.pendingTx.preservation.test.ts`
  - Observe on UNFIXED code for non-buggy inputs (isBugCondition returns false):
    - Observe: `forceDrop=false` → `reconcileAll({ forceDrop: false })` returns `report.total = 0` for `pending`/`included`/`submitted` tx'ler (these are never in `getReviewRequiredTxs()`)
    - Observe: `forceDrop=true` but no `txFilter` → CLI guard exits with error before `reconcileAll` is called; no DB writes
    - Observe: `review_required` tx for same block → existing `resolveForceDropTx()` flow unchanged; `MARK_DROPPED_RETRYABLE` still returned when all 11 checks pass
    - Observe: dry-run mode with `forceDrop=true` + `txFilter` → `report.total = 0` (pending tx not in candidates), DB never written
    - Observe: `status = 'finalized'` or `'successful_mint'` tx → never touched by any reconcile path
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements in design:
    - For all `pending`/`included`/`submitted` tx'ler where `forceDrop=false`: `reconcileAll` returns `report.total = 0`
    - For `review_required` tx: existing `resolveForceDropTx()` path (11 safety checks) still works correctly — not broken by the fix
    - Dry-run mode: DB never written regardless of `forceDrop` flag
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_

- [x] 3. Fix for pending/included/submitted TX force-drop candidate seçimi

  - [x] 3.1 Add `getStuckTxByHash()` function to `src/db.ts`
    - Implement `getStuckTxByHash(txHash: string)` function that queries `txs` table with `WHERE tx_hash = ? AND status IN ('pending', 'included', 'submitted') LIMIT 1`
    - Return type: `{ id: number; block: number; tx_hash: string; status: string; reason: string | null; updated_at: string; nonce: number } | undefined`
    - Returns `undefined` if tx not found or status is not in `('pending', 'included', 'submitted')`
    - Must NOT return `review_required`, `finalized`, `dropped`, or `successful_mint` records
    - Add JSDoc comment: "Get a single tx by hash for pending/included/submitted statuses. Used by force-drop resolution to find stuck txs. Returns undefined if not found."
    - _Bug_Condition: isBugCondition(X) where X.status IN ('pending', 'included', 'submitted') AND opts.forceDrop = true AND opts.txFilter = X.tx_hash_
    - _Expected_Behavior: getStuckTxByHash(txHash) returns the tx record so reconcileAll can add it to candidates_
    - _Preservation: getReviewRequiredTxs() unchanged; finalized/dropped/successful_mint records never returned_
    - _Requirements: 2.1, 2.2, 3.4, 3.6_

  - [x] 3.2 Extend `reconcileAll()` candidate selection in `src/reconciler.ts`
    - Import `getStuckTxByHash` from `./db.js` at the top of the file
    - After applying `blockFilter` and `txFilter` to `getReviewRequiredTxs()` results, add the following logic:
      ```
      // NEW: force-drop için pending/included/submitted tx de ekle
      if (opts.forceDrop && opts.txFilter) {
        const stuckTx = getStuckTxByHash(opts.txFilter);
        if (stuckTx && !txs.some(t => t.tx_hash.toLowerCase() === stuckTx.tx_hash.toLowerCase())) {
          txs.push(stuckTx);
        }
      }
      ```
    - Update `report.total = txs.length` AFTER the stuck tx injection (already set after filter, ensure it reflects the updated list)
    - Duplicate guard: only add `stuckTx` if not already in `txs` (prevents double-processing when tx is both `review_required` and matched by hash)
    - _Bug_Condition: opts.forceDrop = true AND opts.txFilter = X.tx_hash AND X.status IN ('pending', 'included', 'submitted') → txs list was empty before fix_
    - _Expected_Behavior: txs list contains the stuck tx; report.total >= 1; resolveForceDropTx() is called_
    - _Preservation: opts.forceDrop = false → getStuckTxByHash never called; review_required flow unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 3.4, 3.5_

  - [x] 3.3 Extend `resolveForceDropTx()` status guard in `src/reconciler.ts`
    - Locate the existing status guard in `resolveForceDropTx()`:
      ```typescript
      // Check 1: tx must be review_required (caller guarantees this, but verify)
      if (tx.status !== "review_required") {
      ```
    - Replace with an expanded guard that accepts `pending`, `included`, and `submitted` as well:
      ```typescript
      // Check 1: tx must be in a force-drop eligible status
      const FORCE_DROP_ELIGIBLE_STATUSES = ['review_required', 'pending', 'included', 'submitted'];
      if (!FORCE_DROP_ELIGIBLE_STATUSES.includes(tx.status)) {
      ```
    - Update the log message and reason string to reflect the new check:
      - Log: `"tx status is ${tx.status}, not eligible for force-drop"`
      - Reason: `"force_drop_not_eligible_status"` (replaces `"force_drop_not_review_required"`)
    - All other 10 safety checks (receipt null, getTransaction null, nonce checks, EDMT checks, DB conflict checks) remain unchanged
    - _Bug_Condition: tx.status = 'pending' → old guard returned LEAVE_REVIEW_REQUIRED / force_drop_not_review_required even when candidate was correctly selected_
    - _Expected_Behavior: pending/included/submitted tx passes status guard and proceeds to all 11 safety checks_
    - _Preservation: finalized/dropped/successful_mint statuses still rejected; all 11 safety checks still enforced_
    - _Requirements: 2.1, 2.2, 2.3, 3.5, 3.6_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Pending TX Force-Drop Candidate Seçimi
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1 (`tests/reconciler.forceDrop.pendingTx.exploration.test.ts`)
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - Verify: `getStuckTxByHash` exists and is exported from `src/db.ts`
    - Verify: for `isBugCondition(X)` inputs (`status IN ('pending', 'included', 'submitted')`, `forceDrop=true`, `txFilter=HASH`), `report.total >= 1`
    - Verify: `resolveForceDropTx()` is called and returns a decision (not the implicit "0 candidates" non-result)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Force-Drop Olmadan Pending TX'lere Dokunulmamalı
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2 (`tests/reconciler.forceDrop.pendingTx.preservation.test.ts`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Verify: `forceDrop=false` → `pending`/`included`/`submitted` tx'ler seçilmiyor, `report.total = 0`
    - Verify: existing `review_required` force-drop flow (`tests/reconciler.forceDrop.test.ts`) still passes — all 14 tests unchanged
    - Verify: dry-run modunda DB'ye hiçbir yazma yapılmıyor
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint — Ensure all tests pass
  - Run `npm test` — tüm testler geçmeli (exploration + preservation + mevcut testler)
  - Run `npm run build` — TypeScript derleme hatasız tamamlanmalı
  - Verify `tests/reconciler.forceDrop.pendingTx.exploration.test.ts` PASSES (bug fixed)
  - Verify `tests/reconciler.forceDrop.pendingTx.preservation.test.ts` PASSES (no regressions)
  - Verify existing `tests/reconciler.forceDrop.test.ts` still PASSES (all 14 tests — review_required flow unchanged)
  - Verify existing `tests/reconciler.droppedTx.exploration.test.ts` still PASSES
  - Verify existing `tests/reconciler.droppedTx.preservation.test.ts` still PASSES
  - Verify existing `tests/reconciler.exploration.test.ts` still PASSES
  - Verify existing `tests/reconciler.preservation.test.ts` still PASSES
  - Ensure all tests pass; ask the user if questions arise.
