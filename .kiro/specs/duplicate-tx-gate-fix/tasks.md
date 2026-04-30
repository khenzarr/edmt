# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Terminal Statüsteki TX Mint'i Engelliyor
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases: `existingTx.status IN ('dropped', 'failed')` → `execute()` returns `skipped_duplicate_tx` (bug kanıtı)
  - Test file: `tests/mintExecutor.duplicateTxGate.exploration.test.ts`
  - Mock `getTxByBlock(block)` to return `{ tx_hash: '0x3fc11effe...', status: 'dropped', nonce: 42 }`
  - Test that `execute(mintableBlock)` returns `result.status !== 'skipped_duplicate_tx'` (from Bug Condition in design: `isBugCondition(X)` where `X.status IN ('dropped', 'failed')`)
  - Run test on UNFIXED code — `execute()` returns `skipped_duplicate_tx` (bug kanıtı)
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists)
  - Document counterexamples found: e.g., `"execute(mintableBlock) with existingTx.status='dropped' returns skipped_duplicate_tx — terminal tx treated as active duplicate"`
  - Also test `existingTx.status = 'failed'` — same bug, same counterexample pattern
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Aktif Statüsteki TX'ler Hâlâ Bloklanmalıdır
  - **IMPORTANT**: Follow observation-first methodology
  - Test file: `tests/mintExecutor.duplicateTxGate.preservation.test.ts`
  - Observe on UNFIXED code for non-buggy inputs (isBugCondition returns false):
    - Observe: `existingTx.status = 'pending'` → `execute()` returns `skipped_duplicate_tx` ✓
    - Observe: `existingTx.status = 'submitted'` → `execute()` returns `skipped_duplicate_tx` ✓
    - Observe: `existingTx.status = 'included'` → `execute()` returns `skipped_duplicate_tx` ✓
    - Observe: `existingTx.status = 'finalized'` → `execute()` returns `skipped_duplicate_tx` ✓
    - Observe: `existingTx.status = 'successful_mint'` → `execute()` returns `skipped_duplicate_tx` ✓
    - Observe: `getTxByBlock` returns `undefined` → Gate 9 geçilir, mint devam eder ✓
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements in design:
    - For all `ACTIVE_TX_STATUSES` (`pending`, `submitted`, `included`, `finalized`, `successful_mint`): `execute()` returns `skipped_duplicate_tx`
    - For `getTxByBlock` returning `undefined`: Gate 9 geçilir
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Fix for duplicate tx gate — terminal statüsteki tx'lerin mint'i engellemesi

  - [x] 3.1 Apply Gate 9 status filter in `src/mintExecutor.ts`
    - Locate Gate 9 in `execute()` function (~line 185): `const existingTx = getTxByBlock(block);`
    - Add `ACTIVE_TX_STATUSES` constant immediately before the `if (existingTx)` check:
      ```typescript
      const ACTIVE_TX_STATUSES = ['pending', 'submitted', 'included', 'finalized', 'successful_mint'];
      ```
    - Change `if (existingTx)` to `if (existingTx && ACTIVE_TX_STATUSES.includes(existingTx.status))`
    - Add comment after the closing brace: `// dropped/failed → fall through, allow new mint attempt`
    - No other files change — only `src/mintExecutor.ts`
    - _Bug_Condition: isBugCondition(X) where X.status IN ('dropped', 'failed') — getTxByBlock returns terminal tx, Gate 9 incorrectly blocks mint_
    - _Expected_Behavior: execute() passes Gate 9 when existingTx.status NOT IN ACTIVE_TX_STATUSES; mint continues to subsequent gates_
    - _Preservation: existingTx.status IN ACTIVE_TX_STATUSES → skipped_duplicate_tx still returned; getTxByBlock undefined → Gate 9 still passes_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Terminal Statüsteki TX Mint'i Engellememelidir
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1 (`tests/mintExecutor.duplicateTxGate.exploration.test.ts`)
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - Verify: `existingTx.status = 'dropped'` → `result.status !== 'skipped_duplicate_tx'`
    - Verify: `existingTx.status = 'failed'` → `result.status !== 'skipped_duplicate_tx'`
    - _Requirements: 2.1, 2.2_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Aktif Statüsteki TX'ler Hâlâ Bloklanmalıdır
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2 (`tests/mintExecutor.duplicateTxGate.preservation.test.ts`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Verify: `existingTx.status IN ('pending', 'submitted', 'included', 'finalized', 'successful_mint')` → `skipped_duplicate_tx` hâlâ döner
    - Verify: `getTxByBlock` `undefined` döndürdüğünde → Gate 9 hâlâ geçilir
    - Verify: existing `tests/mintExecutor.test.ts` Test 11 (duplicate tx prevention with `pending` status) still PASSES
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint — Ensure all tests pass
  - Run `npm test` — tüm testler geçmeli (exploration + preservation + mevcut testler)
  - Run `npm run build` — TypeScript derleme hatasız tamamlanmalı
  - Run `npm run lint` — lint hatasız tamamlanmalı
  - Run `npm run format:check` — format kontrolü geçmeli
  - Verify `tests/mintExecutor.duplicateTxGate.exploration.test.ts` PASSES (bug fixed)
  - Verify `tests/mintExecutor.duplicateTxGate.preservation.test.ts` PASSES (no regressions)
  - Verify existing `tests/mintExecutor.test.ts` still PASSES — özellikle Test 11 (`pending` statüslü tx için `skipped_duplicate_tx` döner)
  - Verify existing reconciler tests still PASS (force-drop flow unaffected)
  - Ensure all tests pass; ask the user if questions arise.
