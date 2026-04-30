# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Recoverable Nonce Anomaly Session'ı Kapatmaz
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing case: `nonceAnomalyDetected=true`, `activeTxCount=0`, `failedCount=0`, `reviewRequiredCount=0`, `latestNonce==pendingNonce`, `latestNonce >= maxFinalizedNonce+1`
  - Create `tests/autoMintRunner.nonceAnomaly.exploration.test.ts`
  - Mock pipeline loop state: `state.stopNewTx=true`, `state.stopReason="nonce_anomaly_detected"`, `hasPendingTx()=false`, `hasFailedTx()=false`, `hasReviewRequiredTx()=false`, `getUnfinalizedTxCount()=0`, `getPendingNonce()=5`, `getLatestNonce()=5`, `getMaxFinalizedNonce()=4`
  - Bug condition from design: `isBugCondition(X)` where `X.nonceAnomalyDetected=true AND X.activeTxCount=0 AND X.failedCount=0 AND X.reviewRequiredCount=0 AND X.latestNonce==X.pendingNonce AND X.latestNonce >= X.maxFinalizedNonce+1`
  - Assert that `runAutoMint()` returns `stopReason="nonce_anomaly_detected"` on UNFIXED code (this is the bug — it should NOT close the session)
  - Run test on UNFIXED code: `npm test -- --run tests/autoMintRunner.nonceAnomaly.exploration.test.ts`
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists)
  - Document counterexamples found: `runAutoMint()` with recoverable nonce anomaly state returns `stopReason="nonce_anomaly_detected"` instead of continuing
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Unrecoverable Nonce Anomaly Hâlâ Session'ı Kapatır
  - **IMPORTANT**: Follow observation-first methodology
  - Create `tests/autoMintRunner.nonceAnomaly.preservation.test.ts`
  - Observe on UNFIXED code: when `failedCount=1` (or `reviewRequiredCount=1`, or `latestNonce!=pendingNonce`, or `latestNonce < maxFinalizedNonce+1`), `runAutoMint()` returns `stopReason="nonce_anomaly_detected"`
  - Write property-based tests covering all unrecoverable combinations from Preservation Requirements in design:
    - `failedCount > 0` → session closes with `nonce_anomaly_detected`
    - `reviewRequiredCount > 0` → session closes with `nonce_anomaly_detected`
    - `latestNonce != pendingNonce` (e.g. latestNonce=4, pendingNonce=5) → session closes
    - `latestNonce < maxFinalizedNonce+1` (e.g. latestNonce=3, maxFinalizedNonce=4) → session closes
    - `activeTxCount > 0` when anomaly first detected → `stopNewTx=true` set, session does NOT close immediately (pending tx still exists)
  - Property-based test: for all `{failedCount, reviewRequiredCount, latestNonce, pendingNonce, maxFinalizedNonce}` where `isBugCondition=false AND nonceAnomalyDetected=true`, session closes with `nonce_anomaly_detected`
  - Verify tests PASS on UNFIXED code: `npm test -- --run tests/autoMintRunner.nonceAnomaly.preservation.test.ts`
  - **EXPECTED OUTCOME**: Tests PASS (confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Fix for nonce anomaly recovery — recoverable anomaly should not close session

  - [x] 3.1 Add `getMaxFinalizedNonce()` helper to `src/db.ts`
    - Add new exported function `getMaxFinalizedNonce(): number`
    - Query: `SELECT MAX(nonce) FROM txs WHERE status = 'finalized'`
    - Return `0` (or `-1`) when no finalized txs exist (safe default — `latestNonce >= 0+1` will still pass for nonce=1+)
    - Place after existing pipeline mode helpers section
    - _Bug_Condition: `getMaxFinalizedNonce()` is needed to evaluate `latestNonce >= maxFinalizedNonce+1` in reconcile check_
    - _Requirements: 2.2_

  - [x] 3.2 Add `getLatestNonce()` helper to `src/ethClient.ts`
    - Add new exported async function `getLatestNonce(address: string): Promise<number>`
    - Implementation: `withRetry(() => getProvider().getTransactionCount(address, "latest"), \`getLatestNonce(\${address.slice(0,10)}...)\`)`
    - Place after existing `getPendingNonce` function
    - _Bug_Condition: `getLatestNonce()` provides on-chain confirmed nonce for reconcile check (`latestNonce==pendingNonce`)_
    - _Requirements: 2.2_

  - [x] 3.3 Update `stopNewTx=true` exit path in `src/autoMintRunner.ts` pipeline loop
    - Locate the `if (state.stopNewTx)` branch in the pipeline mode loop (around line 620–640)
    - Current code: when `!hasPendingTx()`, immediately sets `stopReason = state.stopReason` and `break`
    - Replace with: when `!hasPendingTx()` AND `state.stopReason === "nonce_anomaly_detected"`, attempt nonce reconcile before exiting
    - Reconcile procedure (from design pseudocode):
      ```
      const failedCount    = hasFailedTx()
      const reviewCount    = hasReviewRequiredTx()
      const pendingNonce   = await getPendingNonce(walletAddress)
      const latestNonce    = await getLatestNonce(walletAddress)
      const maxFinNonce    = getMaxFinalizedNonce()

      if (!failedCount && !reviewCount && latestNonce === pendingNonce && latestNonce >= maxFinNonce + 1) {
        log PIPELINE_NONCE_STATE_RECONCILED {latestNonce, pendingNonce, maxFinNonce}
        state.stopNewTx = false
        state.stopReason = "completed"
        lastSubmittedNonce = pendingNonce - 1
        continue  // loop continues
      } else {
        log PIPELINE_NONCE_ANOMALY {reason: "reconcile_failed", failedCount, reviewCount, latestNonce, pendingNonce, maxFinNonce}
        stopReason = "nonce_anomaly_detected"
        break
      }
      ```
    - Wrap reconcile RPC calls in try/catch: on error, log `RPC_ERROR` and `break` with `stopReason = "nonce_anomaly_detected"`
    - For other `state.stopReason` values (non-anomaly), preserve existing behavior: `stopReason = state.stopReason; break`
    - Add `getLatestNonce` to imports from `./ethClient.js`
    - Add `getMaxFinalizedNonce` to imports from `./db.js`
    - _Bug_Condition: `isBugCondition(X)` where `X.nonceAnomalyDetected=true AND X.activeTxCount=0 AND X.failedCount=0 AND X.reviewRequiredCount=0 AND X.latestNonce==X.pendingNonce AND X.latestNonce >= X.maxFinalizedNonce+1`_
    - _Expected_Behavior: `result.stopReason ≠ "nonce_anomaly_detected"`, `nonce_state_reconciled` logged, `stopNewTx=false`, loop continues_
    - _Preservation: All unrecoverable anomaly paths (failedCount>0, reviewRequiredCount>0, latestNonce!=pendingNonce, latestNonce < maxFinalizedNonce+1) still close session with `nonce_anomaly_detected`_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Recoverable Nonce Anomaly Session'ı Kapatmaz
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run: `npm test -- --run tests/autoMintRunner.nonceAnomaly.exploration.test.ts`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed — session does NOT close with `nonce_anomaly_detected` when reconcile conditions are met)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Unrecoverable Nonce Anomaly Hâlâ Session'ı Kapatır
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run: `npm test -- --run tests/autoMintRunner.nonceAnomaly.preservation.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions — unrecoverable anomaly paths still close session)
    - Confirm all preservation cases still pass after fix

- [x] 4. Checkpoint — Ensure all tests pass
  - Run full test suite: `npm test`
  - Run build: `npm run build`
  - Run lint: `npm run lint`
  - Run format check: `npm run format:check`
  - Ensure all tests pass, ask the user if questions arise.
