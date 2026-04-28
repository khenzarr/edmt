# Unattended Auto Mint — Teknik Tasarım Dokümanı

## Overview

Bu doküman, mevcut EDMT/eNAT Mint Bot'a eklenen `UNATTENDED_AUTO_MINT` modunun teknik tasarımını tanımlar. Bu mod; kullanıcı müdahalesi olmadan sürekli döngüde mintable block arar, güvenlik limitleri dahilinde mint eder, finality izler ve kaldığı yerden devam eder.

Tasarım şu temel ilkelere dayanır:
- Mevcut `BlockScanner`, `MintExecutor`, `TxMonitor` ve `Checkpoint` modülleri **değiştirilmez**; yalnızca yeni `AutoMintRunner` modülü tarafından orkestre edilir.
- Gate 1–12 güvenlik kapıları **bypass edilmez**; `MintExecutor.execute()` doğrudan çağrılır.
- Tüm yeni konfigürasyon `AUTO_MINT_*` prefix'li env değişkenleri üzerinden `config.ts`'e eklenir.
- Lock file mekanizması ile aynı anda tek instance garantisi sağlanır.

---

## Architecture

### Genel Mimari

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLI (cli.ts)                           │
│   scan | mint | resume | status | pending | dry-run | automint  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ automint
              ┌─────────────▼──────────────┐
              │     AutoMintRunner          │
              │   (autoMintRunner.ts)       │
              │                             │
              │  ┌─────────────────────┐    │
              │  │  Lock File Manager  │    │
              │  └─────────────────────┘    │
              │  ┌─────────────────────┐    │
              │  │  Session Limits     │    │
              │  │  (tx/day, runtime)  │    │
              │  └─────────────────────┘    │
              │  ┌─────────────────────┐    │
              │  │  Balance Checker    │    │
              │  └─────────────────────┘    │
              └──┬──────────┬──────────┬────┘
                 │          │          │
    ┌────────────▼──┐  ┌────▼──────┐  ┌▼──────────────┐
    │ BlockScanner  │  │MintExecutor│  │  TxMonitor    │
    │decideBlock()  │  │execute()   │  │  poll()       │
    └───────────────┘  └───────────┘  └───────────────┘
                 │
    ┌────────────▼──────────────────────┐
    │    EthClient                      │
    │  getWalletBalanceEth() [NEW]       │
    └───────────────────────────────────┘
```

### Session Yaşam Döngüsü

```
runAutoMint() çağrıldı
  │
  ▼
[Ön Koşul Kontrolleri]
  ├─ UNATTENDED_AUTO_MINT=false → return {stopReason: "unattended_auto_mint_disabled"}
  ├─ ENABLE_LIVE_MINT=false     → return {stopReason: "live_mint_disabled"}
  └─ PRIVATE_KEY yok            → return {stopReason: "no_private_key"}
  │
  ▼
[Lock File Kontrolü]
  ├─ Lock var + PID çalışıyor   → return {stopReason: "lock_file_exists"}
  ├─ Lock var + PID ölü (stale) → lock sil, devam et
  └─ Lock yok                   → lock oluştur (PID + startedAt)
  │
  ▼
[Session Başlat]
  sessionId = crypto.randomUUID()
  startedAt = new Date().toISOString()
  │
  ▼
┌─[Poll Döngüsü]──────────────────────────────────────────────────┐
│                                                                  │
│  1. Emergency stop dosyası var mı?                               │
│     └─ Evet → stopReason: "emergency_stop_file_detected"        │
│                                                                  │
│  2. Session limitleri aşıldı mı?                                 │
│     ├─ txSentThisSession >= maxTxPerSession                      │
│     │    → stopReason: "session_tx_limit_reached"               │
│     ├─ dailyTxCount >= maxTxPerDay                               │
│     │    → stopReason: "daily_tx_limit_reached"                 │
│     └─ elapsed > maxRuntimeMinutes                               │
│          → stopReason: "max_runtime_exceeded"                   │
│                                                                  │
│  3. Wallet balance kontrolü                                      │
│     ├─ balance < minWalletBalanceEth → skip, log, bekle         │
│     └─ balance > maxWalletBalanceEth → skip, log, bekle         │
│                                                                  │
│  4. BlockScanner.decideBlock(currentBlock)                       │
│     ├─ beyond_current_head → bekle (pollIntervalMs)             │
│     ├─ not_eligible        → checkpoint+1, devam                │
│     ├─ minted              → checkpoint+1, devam                │
│     ├─ unknown             → checkpoint tutulur, hata logla     │
│     │    AUTO_MINT_STOP_ON_FIRST_ERROR=true → session dur       │
│     └─ mintable            → adım 5'e geç                       │
│                                                                  │
│  5. Fee/Block filtreleme                                         │
│     ├─ feeRequired=true + onlyNoFeeBlocks=true → skip           │
│     └─ feeRequired=true + stopOnFeeRequired=true → session dur  │
│                                                                  │
│  6. allowedStartBlock / allowedStopBlock kontrolleri             │
│     ├─ block < allowedStartBlock → skip                         │
│     └─ block > allowedStopBlock  → session dur                  │
│                                                                  │
│  7. MintExecutor.execute(blockResult)                            │
│     └─ submitted → txSentThisSession++, txHashes.push(hash)     │
│                                                                  │
│  8. TxMonitor.poll()                                             │
│     └─ review_required + stopOnReviewRequired=true → session dur│
│                                                                  │
│  9. Cooldown: sleep(cooldownAfterTxMs)                           │
│                                                                  │
│  10. sleep(pollIntervalMs) → döngü başına dön                   │
└──────────────────────────────────────────────────────────────────┘
  │
  ▼
[Session Sonlandır]
  lock dosyasını sil
  endedAt = new Date().toISOString()
  return AutoMintReport
```

---

## Components and Interfaces

### AutoMintRunner (`src/autoMintRunner.ts`)

Ana export:

```typescript
export async function runAutoMint(): Promise<AutoMintReport>
```

İç yardımcı fonksiyonlar:

```typescript
// Lock file yönetimi
function acquireLock(): "acquired" | "live_lock" | "stale_replaced"
function releaseLock(): void
function isProcessRunning(pid: number): boolean

// Limit kontrolleri
function getDailyTxCount(): number  // txs tablosundan son 24 saat
function checkSessionLimits(state: SessionState): StopReason | null

// Emergency stop
function isEmergencyStopRequested(): boolean

// Balance kontrolü
async function checkWalletBalance(): Promise<"ok" | "too_low" | "too_high" | "error">
```

### EthClient — Yeni Metod (`src/ethClient.ts`)

```typescript
export async function getWalletBalanceEth(address: string): Promise<number>
```

Mevcut `withRetry` wrapper'ı kullanır. `provider.getBalance(address)` çağrısını yapar, wei'den ETH'e çevirir (`Number(ethers.formatEther(balance))`).

### Config Genişletmesi (`src/config.ts`)

Yeni `AUTO_MINT_*` alanları `config` objesine eklenir:

```typescript
// Unattended Auto Mint
unattendedAutoMint: parseBoolEnv("UNATTENDED_AUTO_MINT", false),
autoMintMaxTxPerSession: parseIntEnv("AUTO_MINT_MAX_TX_PER_SESSION", 1),
autoMintMaxTxPerDay: parseIntEnv("AUTO_MINT_MAX_TX_PER_DAY", 3),
autoMintMaxRuntimeMinutes: parseIntEnv("AUTO_MINT_MAX_RUNTIME_MINUTES", 480),
autoMintPollIntervalMs: parseIntEnv("AUTO_MINT_POLL_INTERVAL_MS", 12000),
autoMintConfirmEachTx: parseBoolEnv("AUTO_MINT_CONFIRM_EACH_TX", false),
autoMintRequireHotWalletBalanceMaxEth: parseFloatEnv("AUTO_MINT_REQUIRE_HOT_WALLET_BALANCE_MAX_ETH", 0.05),
autoMintMinWalletBalanceEth: parseFloatEnv("AUTO_MINT_MIN_WALLET_BALANCE_ETH", 0.005),
autoMintStopOnFirstError: parseBoolEnv("AUTO_MINT_STOP_ON_FIRST_ERROR", true),
autoMintStopOnReviewRequired: parseBoolEnv("AUTO_MINT_STOP_ON_REVIEW_REQUIRED", true),
autoMintStopOnFeeRequired: parseBoolEnv("AUTO_MINT_STOP_ON_FEE_REQUIRED", true),
autoMintOnlyNoFeeBlocks: parseBoolEnv("AUTO_MINT_ONLY_NO_FEE_BLOCKS", true),
autoMintAllowedStartBlock: process.env["AUTO_MINT_ALLOWED_START_BLOCK"]
  ? parseIntEnv("AUTO_MINT_ALLOWED_START_BLOCK", 0) : undefined,
autoMintAllowedStopBlock: process.env["AUTO_MINT_ALLOWED_STOP_BLOCK"]
  ? parseIntEnv("AUTO_MINT_ALLOWED_STOP_BLOCK", 0) : undefined,
autoMintCooldownAfterTxMs: parseIntEnv("AUTO_MINT_COOLDOWN_AFTER_TX_MS", 60000),
autoMintEmergencyStopFile: optionalEnv("AUTO_MINT_EMERGENCY_STOP_FILE", "./STOP_AUTOMINT"),
autoMintSessionLockFile: optionalEnv("AUTO_MINT_SESSION_LOCK_FILE", "./automint.lock"),
```

`parseFloatEnv` yardımcı fonksiyonu `config.ts`'e eklenir:

```typescript
function parseFloatEnv(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const parsed = parseFloat(val.trim());
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid float for ${name}: "${val}"`);
  }
  return parsed;
}
```

### CLI Genişletmesi (`src/cli.ts`)

Yeni `automint` komutu eklenir:

```typescript
program
  .command("automint")
  .description("Run unattended auto mint session")
  .action(async () => {
    initDb();
    const report = await runAutoMint();
    console.log("\n=== Auto Mint Session Report ===");
    console.log(JSON.stringify(report, null, 2));
    closeDb();
  });
```

### `package.json` Script

```json
"automint": "node --loader ts-node/esm src/cli.ts automint"
```

---

## Data Models

### AutoMintReport

```typescript
export type StopReason =
  | "unattended_auto_mint_disabled"
  | "live_mint_disabled"
  | "no_private_key"
  | "lock_file_exists"
  | "session_tx_limit_reached"
  | "daily_tx_limit_reached"
  | "max_runtime_exceeded"
  | "emergency_stop_file_detected"
  | "fee_required_block_detected"
  | "review_required_detected"
  | "allowed_stop_block_reached"
  | "first_error_stop"
  | "wallet_balance_low"
  | "wallet_balance_high"
  | "completed";

export interface AutoMintReport {
  sessionId: string;          // crypto.randomUUID()
  startedAt: string;          // ISO 8601
  endedAt: string;            // ISO 8601
  startBlock: number;         // checkpoint at session start
  endBlock?: number;          // last scanned block
  blocksScanned: number;      // total blocks processed this session
  txSentThisSession: number;  // tx submitted this session
  stopReason: StopReason;
  txHashes: string[];         // all tx hashes submitted this session
  errors: string[];           // error messages collected during session
}
```

### Lock File Format

```json
{
  "pid": 12345,
  "startedAt": "2024-01-15T10:30:00.000Z"
}
```

Dosya yolu: `config.autoMintSessionLockFile` (default: `./automint.lock`)

### SessionState (iç tip)

```typescript
interface SessionState {
  sessionId: string;
  startedAt: Date;
  startBlock: number;
  currentBlock: number;
  blocksScanned: number;
  txSentThisSession: number;
  txHashes: string[];
  errors: string[];
}
```

### Günlük Tx Sayısı Sorgusu

`txs` tablosundaki `submitted_at` alanı kullanılır:

```sql
SELECT COUNT(*) as cnt
FROM txs
WHERE submitted_at >= datetime('now', '-24 hours')
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Disabled flag early exit

*For any* call to `runAutoMint()` where `unattendedAutoMint=false`, the function SHALL return immediately with `stopReason="unattended_auto_mint_disabled"` without creating a lock file or starting a session.

**Validates: Requirements 1.1**

### Property 2: Live mint disabled early exit

*For any* call to `runAutoMint()` where `enableLiveMint=false`, the function SHALL return immediately with `stopReason="live_mint_disabled"` without creating a lock file or starting a session.

**Validates: Requirements 1.3**

### Property 3: No private key early exit

*For any* call to `runAutoMint()` where no `PRIVATE_KEY` is configured, the function SHALL return immediately with `stopReason="no_private_key"` without creating a lock file or starting a session.

**Validates: Requirements 1.4**

### Property 4: Lock file created with current PID

*For any* session that successfully passes all precondition checks, a lock file SHALL be created at `autoMintSessionLockFile` containing the current process PID before any scanning begins.

**Validates: Requirements 2.1**

### Property 5: Live lock prevents second instance

*For any* call to `runAutoMint()` where a lock file exists containing a PID of a currently running process, the function SHALL return immediately with `stopReason="lock_file_exists"` without starting a session.

**Validates: Requirements 2.2**

### Property 6: Lock file cleaned up on any exit

*For any* session outcome (normal completion, error, or any stop reason), the lock file SHALL be deleted before `runAutoMint()` returns.

**Validates: Requirements 2.4**

### Property 7: Emergency stop halts session

*For any* active session where the emergency stop file (`autoMintEmergencyStopFile`) is detected at the start of a poll cycle, the session SHALL stop with `stopReason="emergency_stop_file_detected"` without sending any further transactions.

**Validates: Requirements 3.1, 3.2**

### Property 8: Session tx limit enforced

*For any* session where `txSentThisSession >= autoMintMaxTxPerSession`, the session SHALL stop with `stopReason="session_tx_limit_reached"` before attempting to send another transaction.

**Validates: Requirements 4.1**

### Property 9: Daily tx limit enforced

*For any* session where the count of transactions in the `txs` table with `submitted_at` in the last 24 hours is `>= autoMintMaxTxPerDay`, the session SHALL stop with `stopReason="daily_tx_limit_reached"`.

**Validates: Requirements 4.2**

### Property 10: Max runtime enforced

*For any* session where the elapsed time since `startedAt` exceeds `autoMintMaxRuntimeMinutes` minutes, the session SHALL stop with `stopReason="max_runtime_exceeded"`.

**Validates: Requirements 4.3**

### Property 11: Low wallet balance prevents tx

*For any* poll cycle where `getWalletBalanceEth(address)` returns a value less than `autoMintMinWalletBalanceEth`, no transaction SHALL be sent in that cycle.

**Validates: Requirements 5.2, 5.5**

### Property 12: High wallet balance prevents tx

*For any* poll cycle where `getWalletBalanceEth(address)` returns a value greater than `autoMintRequireHotWalletBalanceMaxEth`, no transaction SHALL be sent in that cycle.

**Validates: Requirements 5.3**

### Property 13: Fee-required block skipped when onlyNoFeeBlocks=true

*For any* block where `feeRequired=true` and `autoMintOnlyNoFeeBlocks=true`, no transaction SHALL be sent for that block.

**Validates: Requirements 6.1**

### Property 14: Fee-required block stops session when stopOnFeeRequired=true

*For any* block where `feeRequired=true` and `autoMintStopOnFeeRequired=true`, the session SHALL stop with `stopReason="fee_required_block_detected"`.

**Validates: Requirements 6.2**

### Property 15: Review-required tx stops session when stopOnReviewRequired=true

*For any* session where a transaction reaches `review_required` status and `autoMintStopOnReviewRequired=true`, the session SHALL stop with `stopReason="review_required_detected"`.

**Validates: Requirements 6.3, 8.2**

### Property 16: Mintable no-fee block triggers execute()

*For any* mintable block where `feeRequired=false` (or undefined) and all session limits and balance checks pass, `MintExecutor.execute()` SHALL be called with that block's result.

**Validates: Requirements 7.2**

### Property 17: Pending tx blocks new tx when allowMultiplePendingTx=false

*For any* poll cycle where `hasPendingTx()` returns true and `allowMultiplePendingTx=false`, no new transaction SHALL be sent in that cycle.

**Validates: Requirements 7.6**

### Property 18: Unknown block does not advance checkpoint

*For any* block returning `status="unknown"`, the `last_scanned_block` checkpoint value SHALL remain unchanged after that poll cycle.

**Validates: Requirements 7.7**

### Property 19: Minted block advances checkpoint

*For any* block returning `status="minted"`, the `last_scanned_block` checkpoint SHALL advance to `block + 1`.

**Validates: Requirements 7.8**

### Property 20: AutoMintReport contains all required fields

*For any* session outcome, the returned `AutoMintReport` SHALL contain non-null values for `sessionId`, `startedAt`, `endedAt`, `startBlock`, `blocksScanned`, `txSentThisSession`, `stopReason`, `txHashes`, and `errors`.

**Validates: Requirements 9.2, 9.3**

### Property 21: Session IDs are unique

*For any* two separate calls to `runAutoMint()`, the `sessionId` values in the returned reports SHALL be different.

**Validates: Requirements 9.5**

### Property 22: First error stops session when stopOnFirstError=true

*For any* session where an error-level event occurs and `autoMintStopOnFirstError=true`, the session SHALL stop with `stopReason="first_error_stop"`.

**Validates: Requirements 12.4**

### Property 23: Invalid config throws at startup

*For any* `AUTO_MINT_*` environment variable set to an invalid value (e.g., non-numeric for numeric fields, non-boolean for boolean fields), the config loader SHALL throw a descriptive error before `runAutoMint()` is called.

**Validates: Requirements 11.2**

### Property 24: Allowed stop block stops session

*For any* session where `autoMintAllowedStopBlock` is defined and the current block exceeds it, the session SHALL stop with `stopReason="allowed_stop_block_reached"`.

**Validates: Requirements 6.5**

---

## Error Handling

### Hata Kategorileri ve Davranışlar

| Hata Türü | Davranış | stopOnFirstError=true |
|-----------|----------|----------------------|
| `getWalletBalanceEth` RPC hatası | Tx gönderme, log warn, döngü devam | Hayır (warn seviyesi) |
| `decideBlock` API hatası (unknown) | Checkpoint tutulur, log warn | Evet (error seviyesi ise) |
| `execute()` hatası | errors[] dizisine ekle, log error | Evet |
| `TxMonitor.poll()` hatası | Log warn, session devam | Hayır |
| Lock file yazma hatası | Log error, session başlamaz | — |
| Config parse hatası | Startup'ta throw, process exit | — |

### Hata Toplama

`AutoMintReport.errors` dizisi, session boyunca karşılaşılan tüm hata mesajlarını toplar. PRIVATE_KEY hiçbir zaman bu diziye veya herhangi bir log çıktısına dahil edilmez.

### Graceful Shutdown

`process.on('SIGINT')` ve `process.on('SIGTERM')` sinyalleri yakalanır; lock dosyası temizlenir ve mevcut rapor döndürülür. Beklenmedik process sonlanmalarında (SIGKILL, crash) lock dosyası diskte kalır ve bir sonraki başlatmada stale lock olarak temizlenir.

---

## Testing Strategy

### Dual Testing Yaklaşımı

- **Unit testler**: Spesifik örnekler, edge case'ler ve hata koşulları
- **Property testler**: Tüm girdiler için geçerli evrensel özellikler

### Property-Based Testing

Property-based testing için **fast-check** kütüphanesi kullanılır (TypeScript ekosistemiyle uyumlu, vitest ile entegre çalışır).

Her property testi minimum **100 iterasyon** çalıştırılır.

Tag formatı: `// Feature: unattended-auto-mint, Property {N}: {property_text}`

### Test Dosyası

`tests/autoMintRunner.test.ts`

Tüm dış bağımlılıklar mock'lanır:
- `BlockScanner.decideBlock` → `vi.mock`
- `MintExecutor.execute` → `vi.mock`
- `TxMonitor.poll` → `vi.mock`
- `EthClient.getWalletBalanceEth` → `vi.mock`
- `db.hasPendingTx`, `db.getPendingTxs` → `vi.mock`
- `fs.existsSync`, `fs.writeFileSync`, `fs.unlinkSync` → `vi.mock` (lock/emergency stop dosyaları için)
- `config` → `vi.mock` veya test başında override

### Property Test Örnekleri

```typescript
// Property 1: Disabled flag early exit
it("Property 1: unattendedAutoMint=false always returns early", async () => {
  // Feature: unattended-auto-mint, Property 1: disabled flag early exit
  await fc.assert(
    fc.asyncProperty(fc.record({ someOtherConfig: fc.anything() }), async () => {
      mockConfig({ unattendedAutoMint: false });
      const report = await runAutoMint();
      expect(report.stopReason).toBe("unattended_auto_mint_disabled");
      expect(report.txSentThisSession).toBe(0);
    }),
    { numRuns: 100 }
  );
});

// Property 8: Session tx limit enforced
it("Property 8: session tx limit always enforced", async () => {
  // Feature: unattended-auto-mint, Property 8: session tx limit enforced
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (limit) => {
      mockConfig({ autoMintMaxTxPerSession: limit });
      mockDecideBlock("mintable");
      mockExecute("submitted");
      const report = await runAutoMint();
      expect(report.txSentThisSession).toBeLessThanOrEqual(limit);
      expect(report.stopReason).toBe("session_tx_limit_reached");
    }),
    { numRuns: 100 }
  );
});
```

### Unit Test Kapsamı

Requirements 13'teki tüm 16 test case'i karşılayan unit testler yazılır:

1. `UNATTENDED_AUTO_MINT=false` → session başlamaz
2. `DRY_RUN=true` → live tx gönderilmez
3. `ENABLE_LIVE_MINT=false` → session başlamaz
4. `PRIVATE_KEY` yok → session başlamaz
5. Emergency stop dosyası → tx gönderilmez
6. Live lock dosyası → ikinci instance başlamaz
7. Mintable no-fee block → tx gönderilir
8. `feeRequired=true` + `onlyNoFeeBlocks=true` → tx gönderilmez
9. `unknown` block → checkpoint ilerlemez
10. `minted` block → checkpoint ilerler
11. `maxTxPerSession` aşıldı → session durur
12. `maxTxPerDay` aşıldı → session durur
13. Balance min altında → tx gönderilmez
14. Balance max üstünde → tx gönderilmez
15. `allowMultiplePendingTx=false` + pending tx → yeni tx gönderilmez
16. `stopOnReviewRequired=true` + review_required → session durur

### Mevcut Testlerin Korunması

Mevcut test dosyaları (`blockScanner.test.ts`, `mintExecutor.test.ts`, vb.) değiştirilmez. `ethClient.ts`'e eklenen `getWalletBalanceEth` metodu için `tests/ethClient.test.ts` (yeni) veya mevcut test dosyasına ek test eklenir.
