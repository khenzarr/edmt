# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Review Required Reconciliation
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing case: a `review_required` tx with receipt.status=1, EDMT owner match, tx hash match, sufficient confirmations — `runAutoMint()` still returns `review_required_detected` on unfixed code
  - Test that `resolveReviewRequired` does NOT exist on unfixed code (import error) OR that `runAutoMint()` always returns `review_required_detected` regardless of receipt/EDMT state
  - Run test on UNFIXED code — expect FAILURE (this confirms the bug exists)
  - Document counterexamples found (e.g., "runAutoMint() returns review_required_detected even when receipt.status=1 and EDMT owner matches")
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Unresolvable Records Stay Review Required
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `runAutoMint()` returns `review_required_detected` when `review_required` tx exists and `AUTO_RECONCILE_REVIEW_REQUIRED=false` on unfixed code
  - Observe: `txs` with `status='pending'` or `status='included'` are NOT touched by any reconcile logic on unfixed code
  - Observe: `block_results` with `status='successful_mint'` or `status='finalized'` are NOT modified on unfixed code
  - Write property-based tests: for all non-bug-condition inputs (receipt missing, receipt.status=0, owner mismatch, tx hash mismatch, insufficient confirmations), `resolveReviewRequired` SHALL leave status as `review_required` and `hasReviewRequiredTx()` SHALL return true
  - Verify tests pass on UNFIXED code (baseline behavior confirmed)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Implement reconciler core and supporting infrastructure

  - [x] 3.1 Add reconcile log events to logger.ts
    - Add `RECONCILE_STARTED`, `RECONCILE_CANDIDATE_FOUND`, `RECONCILE_RECEIPT_MISSING`, `RECONCILE_RECEIPT_FAILED`, `RECONCILE_EDMT_VERIFIED`, `RECONCILE_OWNER_MISMATCH`, `RECONCILE_TX_HASH_MISMATCH`, `RECONCILE_FINALIZED`, `RECONCILE_LEFT_REVIEW_REQUIRED`, `RECONCILE_FINISHED` to `LogEvent`
    - _Requirements: 2.5_

  - [x] 3.2 Add reconcile config variables to config.ts
    - Add `autoReconcileReviewRequired: parseBoolEnv("AUTO_RECONCILE_REVIEW_REQUIRED", false)`
    - Add `reconcileRequireFinality: parseBoolEnv("RECONCILE_REQUIRE_FINALITY", true)`
    - Add `reconcileMinConfirmations: parseIntEnv("RECONCILE_MIN_CONFIRMATIONS", 64)`
    - _Requirements: 2.1, 2.3_

  - [x] 3.3 Add DB helpers to db.ts
    - Add `getReviewRequiredTxs()` — returns all `review_required` tx rows (id, block, tx_hash, reason, updated_at)
    - Add `updateTxStatusWithReason(txHash, status, reason)` — updates status and reason together
    - Add `getBlockResultByBlock(block)` — returns block_results row for a block
    - Add `reconcile_events` table creation in `createTables()` (audit trail)
    - Add `insertReconcileEvent(params)` — inserts a reconcile event record
    - _Requirements: 2.1, 2.2, 2.5_

  - [x] 3.4 Create src/reconciler.ts (new file)
    - Implement `ReconcileDecision` enum: `MARK_FINALIZED`, `MARK_FAILED`, `LEAVE_REVIEW_REQUIRED`
    - Implement `ReconcileResult` interface: `{ decision, reason, tx, dryRun }`
    - Implement `ReconcileReport` interface: `{ total, finalized, failed, leftReviewRequired, dryRun, results }`
    - Implement `resolveReviewRequired(tx, opts)`:
      - Fetch receipt via `getTransactionReceipt(tx.tx_hash)`
      - Receipt null → `LEAVE_REVIEW_REQUIRED` (reason: `receipt_missing`)
      - `receipt.status !== 1` → `LEAVE_REVIEW_REQUIRED` (reason: `receipt_failed`)
      - Call `getBlockStatus(tx.block)` for EDMT verification
      - EDMT API unavailable (status=unknown, edmtStatusConfirmed=false) → `LEAVE_REVIEW_REQUIRED` (reason: `edmt_api_unavailable`)
      - `minted_by !== walletAddress` → `LEAVE_REVIEW_REQUIRED` (reason: `owner_mismatch`)
      - `mint_tx_hash !== tx.tx_hash` → `LEAVE_REVIEW_REQUIRED` (reason: `tx_hash_mismatch`)
      - `RECONCILE_REQUIRE_FINALITY=true` and confirmations < `RECONCILE_MIN_CONFIRMATIONS` → `LEAVE_REVIEW_REQUIRED` (reason: `insufficient_confirmations`)
      - All checks pass → `MARK_FINALIZED`
    - Implement `applyDecision(tx, decision, opts)`:
      - dry-run: log only, no DB writes
      - fix mode: update `txs.status`, `block_results.status`, `last_successful_mint_block` (only if block > current checkpoint), `high_burn_candidates.status` (if exists), insert `reconcile_events` record
    - Implement `reconcileAll(opts)` — iterates all `review_required` txs, calls `resolveReviewRequired` + `applyDecision`, returns `ReconcileReport`
    - Safety rules enforced: no private key, no tx sent, dry-run default, checkpoint protection
    - _Bug_Condition: isBugCondition(tx) where tx.status='review_required' AND receipt.status=1 AND EDMT owner match AND tx hash match AND sufficient confirmations_
    - _Expected_Behavior: txs.status='finalized', block_results.status='successful_mint', last_successful_mint_block updated if block > current value_
    - _Preservation: receipt missing/failed, owner mismatch, tx hash mismatch, insufficient confirmations → LEAVE_REVIEW_REQUIRED_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.5, 3.6_

  - [x] 3.5 Add reconcile CLI command to cli.ts
    - Add `reconcile` command with options: `--dry-run` (default), `--fix`, `--block <N>`, `--tx <HASH>`
    - `--dry-run` (default): call `reconcileAll({ dryRun: true, fix: false })`
    - `--fix`: call `reconcileAll({ dryRun: false, fix: true })`
    - `--block <N>`: filter to single block
    - `--tx <HASH>`: filter to single tx hash
    - Print reconcile report to stdout
    - _Requirements: 2.1, 2.5_

  - [x] 3.6 Add reconcile script to package.json
    - Add `"reconcile": "node --loader ts-node/esm src/cli.ts reconcile"` to scripts
    - _Requirements: 2.1_

  - [x] 3.7 Update autoMintRunner.ts for auto-reconcile startup integration
    - In `runAutoMint()`, before the existing `hasReviewRequiredTx()` check in `checkPipelineStopConditions` and sequential mode:
    - Add startup reconcile block: if `config.autoReconcileReviewRequired && hasReviewRequiredTx()` → call `reconcileAll({ dryRun: false, fix: true })` → log report
    - After reconcile, existing `hasReviewRequiredTx()` check runs as before
    - If `AUTO_RECONCILE_REVIEW_REQUIRED=false` (default): existing behavior unchanged
    - _Bug_Condition: isBugCondition(tx) — automint blocked by review_required that is actually finalized_
    - _Preservation: AUTO_RECONCILE_REVIEW_REQUIRED=false → existing behavior unchanged_
    - _Requirements: 2.4, 3.5_

  - [x] 3.8 Update .env.example with new config variables
    - Add `AUTO_RECONCILE_REVIEW_REQUIRED=false` with comment
    - Add `RECONCILE_REQUIRE_FINALITY=true` with comment
    - Add `RECONCILE_MIN_CONFIRMATIONS=64` with comment
    - _Requirements: 2.1_

  - [x] 3.9 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Review Required Reconciliation
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms `resolveReviewRequired` exists and correctly returns `MARK_FINALIZED` for bug condition inputs
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.4_

  - [x] 3.10 Verify preservation tests still pass
    - **Property 2: Preservation** - Unresolvable Records Stay Review Required
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [ ] 4. Write reconciler unit tests (tests/reconciler.test.ts)
  - receipt missing → `review_required` kalır, reason: `receipt_missing`
  - receipt status=0 → `review_required` kalır, reason: `receipt_failed`
  - receipt status=1 + owner match + tx hash match + yeterli confirmation → `finalized` / `successful_mint`
  - owner mismatch → `review_required` kalır, reason: `owner_mismatch`
  - tx hash mismatch → `review_required` kalır, reason: `tx_hash_mismatch`
  - `RECONCILE_REQUIRE_FINALITY=true` + yetersiz confirmation → `review_required` kalır, reason: `insufficient_confirmations`
  - `RECONCILE_REQUIRE_FINALITY=false` + az confirmation → `finalized` / `successful_mint`
  - dry-run mode → DB değişmez, karar raporda gösterilir
  - fix mode → DB güncellenir
  - EDMT API erişilemiyor → `review_required` kalır, reason: `edmt_api_unavailable`
  - `last_successful_mint_block` zaten daha yüksek → checkpoint güncellenmez
  - `last_successful_mint_block` daha düşük → checkpoint güncellenir
  - block filter → yalnızca ilgili block işlenir
  - tx filter → yalnızca ilgili tx işlenir
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.6_

- [ ] 5. Write automint startup integration tests (tests/autoMintRunner.reconcile.test.ts)
  - `review_required` var + `AUTO_RECONCILE_REVIEW_REQUIRED=false` → automint başlamaz (`review_required_detected`)
  - `review_required` var + reconcile enabled + tüm kayıtlar temizlendi → automint başlar
  - `review_required` var + reconcile enabled + bazı kayıtlar temizlenemedi → automint başlamaz
  - dry-run mode → DB değişmez
  - fix mode → DB güncellenir
  - _Requirements: 2.4, 3.5_

- [ ] 6. Checkpoint — Ensure all tests pass
  - Run `npm test` — all tests must pass
  - Run `npm run build` — TypeScript compilation must succeed
  - Run `npm run lint` — no lint errors
  - Run `npm run format:check` — formatting must be correct
  - Ensure all tests pass, ask the user if questions arise.
