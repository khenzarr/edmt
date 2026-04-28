# Implementation Plan: EDMT/eNAT Mint a Block Bot

## Overview

Node.js + TypeScript + ethers v6 + SQLite + pino + vitest stack üzerinde, Ethereum mainnet'te calldata-only EIP-1559 mint transaction'ları gönderen, resume edilebilir checkpoint sistemi olan bir bot. Implementasyon 12 fazda ilerler; her faz bir öncekinin üzerine inşa edilir.

## Tasks

- [x] 1. Proje iskeleti, konfigürasyon ve altyapı
  - `package.json`, `tsconfig.json`, `.env.example` dosyalarını oluştur; bağımlılıkları ekle (typescript, ethers@6, better-sqlite3, pino, vitest, dotenv, commander)
  - `src/types.ts` — `BlockStatus`, `BlockResult`, `TxRecord`, `CheckpointKey`, `BeyondHeadBehavior` tip ve enum tanımlarını yaz
  - `src/config.ts` — tüm env değişkenlerini oku, doğrula ve export et; `PRIVATE_KEY` log/hata çıktısına asla yazılmamalı; `DRY_RUN` varsayılanı `true`, `BEYOND_HEAD_BEHAVIOR` varsayılanı `wait`, `FINALITY_CONFIRMATIONS` varsayılanı `64`, `ALLOW_MULTIPLE_PENDING_TX` varsayılanı `false`
  - `src/logger.ts` — pino ile JSON structured logger; hassas alan maskeleme
  - _Requirements: 1.1, 1.4, 1.5, 12.1, 12.6_

- [x] 2. Veritabanı katmanı
  - `src/db.ts` — `better-sqlite3` ile SQLite bağlantısı; `checkpoints`, `block_results`, `txs`, `errors` tablolarını `CREATE TABLE IF NOT EXISTS` ile oluştur
  - Tablo şemaları: `checkpoints(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`, `block_results(block INTEGER PRIMARY KEY, status TEXT, burn_gwei TEXT, fee_required INTEGER, required_fee_gwei TEXT, owner TEXT, mint_tx TEXT, reason TEXT, updated_at TEXT)`, `txs(id INTEGER PRIMARY KEY AUTOINCREMENT, block INTEGER, tx_hash TEXT UNIQUE, status TEXT, nonce INTEGER, gas_info TEXT, submitted_at TEXT, updated_at TEXT)`, `errors(id INTEGER PRIMARY KEY AUTOINCREMENT, block INTEGER, stage TEXT, message TEXT, stack TEXT, created_at TEXT)`
  - DB hata durumunda `errors` tablosuna yaz, bot çalışmasını durdurma
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7_

- [x] 3. Checkpoint yöneticisi
  - `src/checkpoint.ts` — `initCheckpoint`, `getCheckpoint`, `setCheckpoint`, `advanceScannedBlock`, `setSubmittedBlock`, `setSuccessfulMintBlock` fonksiyonlarını yaz
  - `initCheckpoint`: `last_scanned_block` yoksa `START_BLOCK` ile başlat; varsa mevcut değeri koru
  - `advanceScannedBlock`: yalnızca `minted`, `not_eligible`, `successful_mint` durumlarında `block + 1` yaz
  - `unknown` / hata durumunda checkpoint ilerletme
  - [x]* 3.1 Checkpoint unit testleri yaz (`tests/checkpoint.test.ts`)
    - Test 7: `minted` durumu checkpoint'i `block + 1` ilerletir
    - Test 8: `unknown` API hatası checkpoint'i ilerletmez
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

- [x] 4. CalldataBuilder implementasyonu ve testleri
  - `src/calldataBuilder.ts` — `buildMintPayload(block: number, feeGwei?: bigint): string` ve `encodePayload(payload: string): string` fonksiyonlarını yaz
  - `fee` alanı yalnızca `feeGwei` tanımlı ve `> 0n` ise eklenmeli; decimal string olarak yazılmalı (bigint.toString())
  - `encodePayload`: UTF-8 → hex, `0x` prefix
  - [x]* 4.1 CalldataBuilder unit testleri yaz (`tests/calldataBuilder.test.ts`)
    - Test 1: `buildMintPayload(block, undefined)` — fee alanı yok, exact match
    - Test 2: `buildMintPayload(block, feeGwei)` — fee alanı var, exact match
    - Test 3: `encodePayload(buildMintPayload(block, feeGwei))` hex-decode → JSON.parse round-trip
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. EthClient implementasyonu
  - `src/ethClient.ts` — ethers v6 `JsonRpcProvider` ile bağlantı; `getCurrentBlockNumber`, `getBlock`, `getTransactionReceipt`, `getFeeData`, `sendTransaction` wrapper'larını yaz
  - `burnGwei` hesabı: `floor(baseFeePerGas(N) * gasUsed(N) / 1e9)` — bigint aritmetiği kullan
  - RPC çağrılarında `RPC_RETRY_LIMIT` kadar retry; tüm denemeler başarısız olursa hata fırlat
  - `PRIVATE_KEY` ile `Wallet` oluştur; key hiçbir log/hata çıktısına yazılmamalı
  - _Requirements: 1.4, 1.5, 10.1, 10.4_

- [x] 7. EdmtClient ve fallback stratejisi
  - `src/edmtClient.ts` — `getBlockStatus(blockNumber): Promise<BlockResult>` implementasyonu
  - Önce EDMT API block-specific endpoint; başarısız olursa RPC fallback (block varlığı + burn hesabı)
  - Her iki kaynak da başarısız → `status: "unknown"`, `errors` tablosuna yaz
  - `beyond_current_head`, `not_eligible` (pre_eip1559, burn_lt_1), `minted`, `mintable`, `unknown` durumlarını doğru döndür
  - Endpoint URL'leri config'den oku; kod içinde sabit URL yazma
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 13.1, 13.2, 13.3, 13.4, 13.5_

- [x] 8. BlockScanner implementasyonu ve testleri
  - `src/blockScanner.ts` — `getNextCandidate`, `scanBatch` fonksiyonlarını yaz
  - `SCAN_DIRECTION` (ascending/descending), `MAX_BLOCKS_PER_RUN`, `POLL_INTERVAL_MS`, `API_RETRY_LIMIT` config değerlerini kullan
  - `beyond_current_head` → `BEYOND_HEAD_BEHAVIOR` enum'a göre wait/skip/stop
  - `minted` / `not_eligible` → checkpoint+1, sıradaki block
  - `unknown` → checkpoint ilerletme, hata logla
  - [x]* 8.1 BlockScanner unit testleri yaz (`tests/blockScanner.test.ts`)
    - Test 4: `block > currentHead` → `beyond_current_head` döner
    - Test 5: `block < 12965000` → `not_eligible`, `reason: "pre_eip1559"`
    - Test 6: `burnGwei < 1` → `not_eligible`, `reason: "burn_lt_1"`
    - _Requirements: 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - _Requirements: 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [x] 9. FeeQuoter implementasyonu ve testleri
  - `src/feeQuoter.ts` — `getRequiredFee(blockNumber): Promise<bigint | undefined>` implementasyonu
  - Fee gerekmiyorsa `undefined` döndür; fee gerekiyorsa tam `requiredFeeGwei` değerini döndür
  - EDMT API fee quote endpoint yoksa `undefined` döndür
  - [x]* 9.1 FeeQuoter unit testleri yaz (`tests/feeQuoter.test.ts`)
    - Test 12: `requiredFeeGwei > MAX_CAPTURE_FEE_GWEI` → mint iptal, "fee exceeds max" log
    - Test 13: `maxFeePerGas > MAX_GAS_GWEI * 1e9` → tx gönderilmez, "gas price exceeds limit" log
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 10. MintExecutor — dry-run modu
  - `src/mintExecutor.ts` — `execute(block, blockResult): Promise<MintResult>` implementasyonu
  - `DRY_RUN=true` → payload, block, fee tahmini, gas tahminini structured log yaz; `sendTransaction` çağırma
  - `DRY_RUN=false` ama `ENABLE_LIVE_MINT=true` değilse → "live mint disabled" uyarısı logla, tx gönderme
  - `PRIVATE_KEY` yoksa live mint'i reddet, açıklayıcı hata mesajı üret
  - [x]* 10.1 MintExecutor dry-run unit testleri yaz
    - Test 9: `DRY_RUN=true` → `sendTransaction` çağrılmaz
    - Test 10: `ENABLE_LIVE_MINT=false` → `sendTransaction` çağrılmaz
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 11. MintExecutor — live mint güvenlik kapıları
  - Live mint gate'lerini sırayla uygula: DRY_RUN=false, ENABLE_LIVE_MINT=true, PRIVATE_KEY mevcut, block-specific EDMT status kesin, fee quote alındı (gerekiyorsa), requiredFeeGwei ≤ MAX_CAPTURE_FEE_GWEI, gas limitleri içinde, duplicate tx yok, ALLOW_MULTIPLE_PENDING_TX=false ise pending tx yok, MAX_TX_PER_RUN aşılmadı
  - EIP-1559 tx oluştur: `to = wallet.address`, `from = wallet.address`, `value = 0`, `data = hex calldata`
  - `maxFeePerGas` ≤ `MAX_GAS_GWEI * 1e9`; `maxPriorityFeePerGas` ≤ `MAX_PRIORITY_FEE_GWEI * 1e9`
  - Tx gönderilince `txs` tablosuna `status=pending` yaz; `last_submitted_block` checkpoint'ini güncelle
  - `REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX=true` ise ilk tx öncesi CLI onayı al
  - [x]* 11.1 Live mint gate unit testleri yaz
    - Test 11: aynı block için `txs` kaydı varsa duplicate tx engellenir
    - Test 12: `requiredFeeGwei > MAX_CAPTURE_FEE_GWEI` → mint iptal
    - Test 13: `maxFeePerGas > MAX_GAS_GWEI * 1e9` → tx gönderilmez
    - Test 14: `ALLOW_MULTIPLE_PENDING_TX=false` ve pending tx varsa → tx gönderilmez
    - _Requirements: 1.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 10.1, 10.2, 10.3_
  - _Requirements: 1.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 10.1, 10.2, 10.3_

- [x] 12. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. TxMonitor implementasyonu
  - `src/txMonitor.ts` — `poll(): Promise<void>` implementasyonu
  - `txs` tablosundaki `status = "pending"` tx'leri periyodik kontrol et
  - `receipt.status === 1` → `"included"` güncelle; EDMT indexer'da `owner` doğrula
  - `receipt.status !== 1` → `"failed"` güncelle, `errors` tablosuna yaz
  - `owner` eşleşmiyorsa → `"review_required"` işaretle, uyarı logla
  - `FINALITY_CONFIRMATIONS` (64) onay sonrası son EDMT indexer doğrulaması; başarılıysa `last_successful_mint_block` checkpoint'ini güncelle
  - Chain reorg tespitinde etkilenen tx'leri `"review_required"` yap
  - [x]* 13.1 TxMonitor unit testleri yaz
    - Test 15: başarılı mint → checkpoint `block + 1` ilerler
    - Test 16: `FINALITY_CONFIRMATIONS` onayı sonrası `successful_mint` durumu
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 5.5, 5.6_
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 5.5, 5.6_

- [x] 14. CLI implementasyonu
  - `src/cli.ts` — `commander` ile `scan`, `mint`, `resume`, `status`, `pending`, `dry-run` komutlarını yaz
  - `scan --limit <N>`: en fazla N block tara, sonuçları logla
  - `mint --block <N>`: belirtilen block'u mint etmeyi dene
  - `resume`: `last_scanned_block` checkpoint'inden devam et
  - `status`: son checkpoint, toplam taranan block, başarılı mint sayısını göster
  - `pending`: `txs` tablosundaki pending tx'leri listele
  - `dry-run --from <START> --limit <N>`: dry-run modunda tara, tx gönderme
  - Geçersiz/eksik parametre → açıklayıcı hata + kullanım kılavuzu
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

- [x] 15. Loglama entegrasyonu ve güvenlik denetimi
  - Tüm modüllerde pino logger'ı entegre et; her block kararını `info`, API/RPC hatalarını `warn`, kritik hataları `error` seviyesinde logla
  - `PRIVATE_KEY` ve hassas alanların hiçbir log satırında görünmediğini doğrula; pino `redact` konfigürasyonu ekle
  - `block_results` tablosuna her kesin durum kararını yaz
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 8.6_

- [x] 16. Tam test suite ve final checkpoint
  - [x]* 16.1 Tüm test dosyalarını gözden geçir, eksik coverage'ı tamamla
    - 16 test senaryosunun tamamının karşılandığını doğrula
    - _Requirements: 3.1–3.6, 2.2–2.4, 5.2–5.4, 1.1–1.3, 6.4, 6.7, 10.2, 7.5_
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. README ve operasyon kılavuzu
  - `README.md` — kurulum, `.env` konfigürasyonu, komut referansı, dry-run → live mint geçiş adımları, güvenlik notları
  - `.env.example` — tüm config değişkenlerini açıklamalı şekilde listele; `PRIVATE_KEY` için placeholder kullan
  - _Requirements: 1.1, 1.6, 11.1–11.7_

## Notes

- `*` ile işaretli sub-task'lar opsiyoneldir; MVP için atlanabilir
- Her task önceki task'ların çıktısına bağımlıdır; sırayla ilerle
- `PRIVATE_KEY` hiçbir zaman log, hata mesajı veya DB kaydına yazılmamalı
- Live mint için çift güvenlik bayrağı zorunlu: `DRY_RUN=false` VE `ENABLE_LIVE_MINT=true`
- Checkpoint her kesin durum kararından sonra SQLite'a kalıcı olarak yazılmalı
