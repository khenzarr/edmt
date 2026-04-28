# Implementation Plan: Unattended Auto Mint

## Overview

Mevcut EDMT/eNAT Mint Bot'a `UNATTENDED_AUTO_MINT` modunu ekler. Uygulama sırası: config → types → ethClient → db → autoMintRunner → CLI → package.json → .env.example → tests → README/RUNBOOK.

## Tasks

- [x] 1. Config genişletmesi (`src/config.ts`)
  - `parseFloatEnv` yardımcı fonksiyonunu `parseIntEnv`'in hemen altına ekle
  - `config` objesine tüm `AUTO_MINT_*` alanlarını ekle (tasarım dokümanındaki sırayla):
    `unattendedAutoMint`, `autoMintMaxTxPerSession`, `autoMintMaxTxPerDay`,
    `autoMintMaxRuntimeMinutes`, `autoMintPollIntervalMs`, `autoMintConfirmEachTx`,
    `autoMintRequireHotWalletBalanceMaxEth`, `autoMintMinWalletBalanceEth`,
    `autoMintStopOnFirstError`, `autoMintStopOnReviewRequired`, `autoMintStopOnFeeRequired`,
    `autoMintOnlyNoFeeBlocks`, `autoMintAllowedStartBlock`, `autoMintAllowedStopBlock`,
    `autoMintCooldownAfterTxMs`, `autoMintEmergencyStopFile`, `autoMintSessionLockFile`
  - Geçersiz değerler için açıklayıcı hata fırlatıldığını doğrula
  - _Requirements: 11.1, 11.2_

- [x] 2. Types genişletmesi (`src/types.ts`)
  - `StopReason` union tipini ekle (tasarım dokümanındaki tüm değerlerle)
  - `AutoMintReport` interface'ini ekle (`sessionId`, `startedAt`, `endedAt`, `startBlock`,
    `endBlock?`, `blocksScanned`, `txSentThisSession`, `stopReason`, `txHashes`, `errors`)
  - _Requirements: 9.1, 9.2_

- [x] 3. EthClient genişletmesi (`src/ethClient.ts`)
  - `getWalletBalanceEth(address: string): Promise<number>` metodunu ekle
  - Mevcut `withRetry` wrapper'ını kullan
  - `provider.getBalance(address)` çağrısını yap, `Number(ethers.formatEther(balance))` ile ETH'e çevir
  - _Requirements: 5.4_

- [x] 4. DB genişletmesi (`src/db.ts`)
  - `getDailyTxCount(): number` fonksiyonunu ekle
  - Son 24 saatteki tx sayısını `submitted_at >= datetime('now', '-24 hours')` sorgusuyla hesapla
  - _Requirements: 4.4_

- [x] 5. AutoMintRunner modülü (`src/autoMintRunner.ts`)
  - [x] 5.1 Lock file yönetimi ve ön koşul kontrolleri
    - `acquireLock()`, `releaseLock()`, `isProcessRunning(pid)` fonksiyonlarını yaz
    - `runAutoMint()` başında `unattendedAutoMint`, `enableLiveMint`, `hasPrivateKey()` kontrollerini yap
    - Lock dosyası oluştur (PID + startedAt JSON içeriğiyle); stale lock tespiti ve temizliğini uygula
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ]* 5.2 Property testi: Disabled flag early exit (Property 1)
    - **Property 1: unattendedAutoMint=false her zaman erken çıkış yapar**
    - **Validates: Requirements 1.1**

  - [ ]* 5.3 Property testi: Live mint disabled early exit (Property 2)
    - **Property 2: enableLiveMint=false her zaman erken çıkış yapar**
    - **Validates: Requirements 1.3**

  - [ ]* 5.4 Property testi: No private key early exit (Property 3)
    - **Property 3: PRIVATE_KEY yokken her zaman erken çıkış yapar**
    - **Validates: Requirements 1.4**

  - [ ]* 5.5 Property testi: Lock file created with current PID (Property 4)
    - **Property 4: Ön koşullar geçildiğinde lock dosyası PID ile oluşturulur**
    - **Validates: Requirements 2.1**

  - [ ]* 5.6 Property testi: Live lock prevents second instance (Property 5)
    - **Property 5: Çalışan PID'li lock dosyası varken ikinci instance başlamaz**
    - **Validates: Requirements 2.2**

  - [ ]* 5.7 Property testi: Lock file cleaned up on any exit (Property 6)
    - **Property 6: Her çıkış senaryosunda lock dosyası silinir**
    - **Validates: Requirements 2.4**

  - [x] 5.8 Emergency stop ve session limit kontrolleri
    - `isEmergencyStopRequested()` fonksiyonunu yaz (dosya varlığı kontrolü)
    - `checkSessionLimits(state)` fonksiyonunu yaz: `txSentThisSession`, `dailyTxCount`, `elapsed` kontrollerini uygula
    - `checkWalletBalance()` fonksiyonunu yaz: `getWalletBalanceEth()` çağrısı, min/max karşılaştırması
    - _Requirements: 3.1, 3.2, 3.4, 4.1, 4.2, 4.3, 4.5, 5.1, 5.2, 5.3, 5.5_

  - [ ]* 5.9 Property testi: Emergency stop halts session (Property 7)
    - **Property 7: Emergency stop dosyası tespit edildiğinde session durur**
    - **Validates: Requirements 3.1, 3.2**

  - [ ]* 5.10 Property testi: Session tx limit enforced (Property 8)
    - **Property 8: txSentThisSession >= maxTxPerSession olduğunda session durur**
    - **Validates: Requirements 4.1**

  - [ ]* 5.11 Property testi: Daily tx limit enforced (Property 9)
    - **Property 9: Son 24 saatteki tx sayısı >= maxTxPerDay olduğunda session durur**
    - **Validates: Requirements 4.2**

  - [ ]* 5.12 Property testi: Max runtime enforced (Property 10)
    - **Property 10: Geçen süre maxRuntimeMinutes'ı aştığında session durur**
    - **Validates: Requirements 4.3**

  - [ ]* 5.13 Property testi: Low wallet balance prevents tx (Property 11)
    - **Property 11: Balance < minWalletBalanceEth olduğunda tx gönderilmez**
    - **Validates: Requirements 5.2, 5.5**

  - [ ]* 5.14 Property testi: High wallet balance prevents tx (Property 12)
    - **Property 12: Balance > maxWalletBalanceEth olduğunda tx gönderilmez**
    - **Validates: Requirements 5.3**

  - [x] 5.15 Poll döngüsü — scan, fee filtreleme, allowedBlock kontrolleri
    - `decideBlock()` çağrısını yap; `beyond_current_head`, `not_eligible`, `minted`, `unknown`, `mintable` durumlarını işle
    - `feeRequired=true` + `onlyNoFeeBlocks=true` → skip; `stopOnFeeRequired=true` → session dur
    - `allowedStartBlock` / `allowedStopBlock` kontrollerini uygula
    - `allowMultiplePendingTx=false` + `hasPendingTx()=true` → skip
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 7.1, 7.6, 7.7, 7.8_

  - [ ]* 5.16 Property testi: Fee-required block skipped (Property 13)
    - **Property 13: feeRequired=true + onlyNoFeeBlocks=true → tx gönderilmez**
    - **Validates: Requirements 6.1**

  - [ ]* 5.17 Property testi: Fee-required block stops session (Property 14)
    - **Property 14: feeRequired=true + stopOnFeeRequired=true → session durur**
    - **Validates: Requirements 6.2**

  - [ ]* 5.18 Property testi: Pending tx blocks new tx (Property 17)
    - **Property 17: hasPendingTx()=true + allowMultiplePendingTx=false → tx gönderilmez**
    - **Validates: Requirements 7.6**

  - [ ]* 5.19 Property testi: Unknown block does not advance checkpoint (Property 18)
    - **Property 18: unknown status → checkpoint ilerlemez**
    - **Validates: Requirements 7.7**

  - [ ]* 5.20 Property testi: Minted block advances checkpoint (Property 19)
    - **Property 19: minted status → checkpoint block+1'e ilerler**
    - **Validates: Requirements 7.8**

  - [x] 5.21 MintExecutor entegrasyonu ve cooldown
    - `execute(blockResult)` çağrısını yap; `submitted` durumunda `txSentThisSession++`, `txHashes.push(hash)`
    - `autoMintConfirmEachTx=false` iken `REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX` config'ini `false` olarak override et
    - Tx sonrası `cooldownAfterTxMs` kadar bekle
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 12.1_

  - [ ]* 5.22 Property testi: Mintable no-fee block triggers execute() (Property 16)
    - **Property 16: Mintable + feeRequired=false + tüm limitler geçildi → execute() çağrılır**
    - **Validates: Requirements 7.2**

  - [x] 5.23 TxMonitor entegrasyonu ve review_required kontrolü
    - Her tx submit sonrası `poll()` çağrısını yap
    - `stopOnReviewRequired=true` + `review_required` durumu → session dur
    - `poll()` hatalarını logla, session'ı durdurma
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ]* 5.24 Property testi: Review-required tx stops session (Property 15)
    - **Property 15: review_required + stopOnReviewRequired=true → session durur**
    - **Validates: Requirements 6.3, 8.2**

  - [x] 5.25 AutoMintReport oluşturma, SIGINT/SIGTERM graceful shutdown
    - Session başında `sessionId = crypto.randomUUID()`, `startedAt`, `startBlock` kaydet
    - Session sonunda `endedAt`, `endBlock`, `blocksScanned` hesapla ve `AutoMintReport` döndür
    - `process.on('SIGINT')` ve `process.on('SIGTERM')` ile lock temizliği ve rapor döndürme
    - `stopOnFirstError=true` + error seviyesi hata → session dur
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 12.3, 12.4_

  - [ ]* 5.26 Property testi: AutoMintReport contains all required fields (Property 20)
    - **Property 20: Her session sonucunda AutoMintReport tüm zorunlu alanları içerir**
    - **Validates: Requirements 9.2, 9.3**

  - [ ]* 5.27 Property testi: Session IDs are unique (Property 21)
    - **Property 21: İki ayrı runAutoMint() çağrısı farklı sessionId döndürür**
    - **Validates: Requirements 9.5**

  - [ ]* 5.28 Property testi: First error stops session (Property 22)
    - **Property 22: stopOnFirstError=true + error → session durur**
    - **Validates: Requirements 12.4**

  - [ ]* 5.29 Property testi: Allowed stop block stops session (Property 24)
    - **Property 24: block > allowedStopBlock → session durur**
    - **Validates: Requirements 6.5**

- [x] 6. Checkpoint — Tüm testlerin geçtiğini doğrula
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. CLI genişletmesi (`src/cli.ts`)
  - `automint` komutunu ekle: `initDb()`, `runAutoMint()`, raporu konsola yazdır, `closeDb()`
  - Mevcut komutları (`scan`, `mint`, `resume`, `status`, `pending`, `dry-run`, `monitor`) değiştirme
  - _Requirements: 10.1, 10.3, 10.4, 10.5_

- [x] 8. `package.json` script
  - `"automint": "node --loader ts-node/esm src/cli.ts automint"` satırını `scripts`'e ekle
  - _Requirements: 10.2_

- [x] 9. `.env.example` güncelleme
  - Tüm `AUTO_MINT_*` değişkenlerini varsayılan değerleri ve Türkçe/İngilizce açıklamalarıyla ekle
  - Mevcut değişkenleri değiştirme
  - _Requirements: 11.3_

- [x] 10. Test dosyası (`tests/autoMintRunner.test.ts`)
  - [x] 10.1 Unit testler: Requirements 13'teki 16 test case'i yaz
    - Test 1: `UNATTENDED_AUTO_MINT=false` → session başlamaz
    - Test 2: `DRY_RUN=true` → live tx gönderilmez
    - Test 3: `ENABLE_LIVE_MINT=false` → session başlamaz
    - Test 4: `PRIVATE_KEY` yok → session başlamaz
    - Test 5: Emergency stop dosyası → tx gönderilmez
    - Test 6: Live lock dosyası → ikinci instance başlamaz
    - Test 7: Mintable no-fee block → tx gönderilir
    - Test 8: `feeRequired=true` + `onlyNoFeeBlocks=true` → tx gönderilmez
    - Test 9: `unknown` block → checkpoint ilerlemez
    - Test 10: `minted` block → checkpoint ilerler
    - Test 11: `maxTxPerSession` aşıldı → session durur
    - Test 12: `maxTxPerDay` aşıldı → session durur
    - Test 13: Balance min altında → tx gönderilmez
    - Test 14: Balance max üstünde → tx gönderilmez
    - Test 15: `allowMultiplePendingTx=false` + pending tx → yeni tx gönderilmez
    - Test 16: `stopOnReviewRequired=true` + review_required → session durur
    - _Requirements: 13.1–13.16_

  - [ ]* 10.2 Property testleri: fast-check ile Property 1–24 arası property testleri yaz
    - Her property için minimum 100 iterasyon (`numRuns: 100`)
    - Tag formatı: `// Feature: unattended-auto-mint, Property {N}: {property_text}`
    - Tüm dış bağımlılıkları mock'la: `BlockScanner`, `MintExecutor`, `TxMonitor`, `EthClient`, `db`, `fs`
    - _Requirements: 13.1–13.16_

- [x] 11. README ve RUNBOOK güncelleme
  - [x] 11.1 README.md güncelleme
    - CLI komutları tablosuna `npm run automint` satırını ekle
    - "Unattended Auto Mint" bölümü ekle: aktivasyon koşulları, `AUTO_MINT_*` değişkenleri, emergency stop, lock file
    - Pre-Live Checklist'e `automint` için ilgili maddeleri ekle
    - _Requirements: 10.1, 10.2_

  - [x] 11.2 RUNBOOK.md güncelleme
    - "Unattended Auto Mint Prosedürü" bölümü ekle: başlatma, izleme, durdurma adımları
    - Emergency stop kullanımını (`touch STOP_AUTOMINT`) belgele
    - Lock file stale durumu ve temizliğini belgele
    - _Requirements: 10.1_

- [x] 12. Final checkpoint — npm test + build + lint + format:check
  - `npm test` çalıştır — tüm testler geçmeli (mevcut + yeni)
  - `npm run build` çalıştır — TypeScript derleme hatası olmamalı
  - `npm run lint` çalıştır — ESLint hatası olmamalı
  - `npm run format:check` çalıştır — Prettier uyumsuzluğu olmamalı
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- `*` ile işaretli sub-task'lar opsiyoneldir; MVP için atlanabilir
- Her task ilgili requirements'a referans verir
- Property testleri için `fast-check` kütüphanesi kullanılır (devDependency olarak eklenmesi gerekebilir)
- `autoMintConfirmEachTx=false` olduğunda `REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX` config değeri geçici olarak `false` yapılır; bu Gate 12'yi bypass etmez, sadece AutoMintRunner'ın kendi config override'ıdır
- `PRIVATE_KEY` hiçbir log, hata mesajı veya `AutoMintReport`'ta gösterilmez
- Mevcut test dosyaları (`blockScanner.test.ts`, `mintExecutor.test.ts`, vb.) değiştirilmez
