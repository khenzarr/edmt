# Requirements Document

## Introduction

Bu özellik, mevcut EDMT/eNAT Mint Bot'a `UNATTENDED_AUTO_MINT` modunu ekler. Bu mod; kullanıcı müdahalesi olmadan otomatik olarak mintable block bulur, güvenlik limitleri dahilinde mintler, finality izler ve kaldığı yerden devam eder. Mevcut manuel mint akışı (`npm run mint`), dry-run davranışı ve tüm güvenlik kapıları (Gate 1–12) korunur; yeni mod yalnızca ek bayraklar açıkça tanımlandığında aktif olur.

## Glossary

- **AutoMintRunner**: `UNATTENDED_AUTO_MINT` modunu yöneten yeni modül (`src/autoMintRunner.ts`).
- **AutoMintReport**: Bir session'ın yaşam döngüsünü, gönderilen tx sayısını, durdurma nedenini ve hata özetini içeren döndürülen tip.
- **Session**: `runAutoMint()` çağrısından çıkışa kadar süren tek bir otomatik mint çalışması.
- **LockFile**: Aynı anda birden fazla AutoMintRunner instance'ının çalışmasını önleyen dosya (`automint.lock`).
- **EmergencyStopFile**: Varlığı halinde tüm tx gönderimini durduran dosya (`STOP_AUTOMINT`).
- **StaleLock**: PID'i artık çalışmayan bir process'e ait olan lock dosyası; güvenle silinebilir.
- **DailyTxCount**: `txs` tablosunda son 24 saatte gönderilen transaction sayısı.
- **AutoMintConfig**: `AUTO_MINT_*` prefix'li tüm yeni konfigürasyon değişkenlerinin toplamı.
- **WalletBalance**: Hot wallet'ın o anki ETH bakiyesi (gwei değil, ETH cinsinden).
- **Bot**: Mevcut EDMT/eNAT Mint Bot uygulaması.
- **MintExecutor**: Mevcut mint transaction hazırlama ve gönderme modülü.
- **BlockScanner**: Mevcut block tarama modülü.
- **TxMonitor**: Mevcut transaction finality izleme modülü.
- **Checkpoint_Manager**: Mevcut SQLite checkpoint okuma/yazma modülü.
- **EthClient**: Mevcut Ethereum RPC istemcisi.

---

## Requirements

### Requirement 1: Unattended Auto Mint Modu Aktivasyonu

**User Story:** Bir bot operatörü olarak, `UNATTENDED_AUTO_MINT=true` bayrağını açıkça ayarlamadan otomatik mint modunun başlamamasını istiyorum; böylece yanlışlıkla gözetimsiz çalışma başlamasın.

#### Acceptance Criteria

1. WHEN `UNATTENDED_AUTO_MINT=false` (veya tanımsız) iken `runAutoMint()` çağrıldığında, THE AutoMintRunner SHALL session başlatmadan `reason: "unattended_auto_mint_disabled"` ile erken çıkış yapmalı.
2. WHEN `DRY_RUN=true` iken `runAutoMint()` çağrıldığında, THE AutoMintRunner SHALL live tx göndermemeli; dry-run modunda scan yapabilir ancak `execute()` çağrısı gerçek tx üretmemeli.
3. WHEN `ENABLE_LIVE_MINT=false` iken `runAutoMint()` çağrıldığında, THE AutoMintRunner SHALL session başlatmadan `reason: "live_mint_disabled"` ile erken çıkış yapmalı.
4. IF `PRIVATE_KEY` ortam değişkeni tanımlı değilse, THEN THE AutoMintRunner SHALL session başlatmadan `reason: "no_private_key"` ile erken çıkış yapmalı.
5. THE AutoMintRunner SHALL yukarıdaki ön koşulların tamamı sağlandığında ve yalnızca o zaman session başlatmalı.

---

### Requirement 2: Lock File ile Tekil Instance Garantisi

**User Story:** Bir bot operatörü olarak, aynı anda birden fazla AutoMintRunner instance'ının çalışmamasını istiyorum; böylece nonce çakışması ve çift mint riski oluşmasın.

#### Acceptance Criteria

1. WHEN `runAutoMint()` çağrıldığında, THE AutoMintRunner SHALL `AUTO_MINT_SESSION_LOCK_FILE` yolunda bir lock dosyası oluşturmalı; dosya içeriği mevcut process'in PID'ini içermeli.
2. IF lock dosyası zaten mevcutsa ve içindeki PID hâlâ çalışıyorsa, THEN THE AutoMintRunner SHALL session başlatmadan `reason: "lock_file_exists"` ile erken çıkış yapmalı.
3. IF lock dosyası mevcutsa ancak içindeki PID artık çalışmıyorsa (stale lock), THEN THE AutoMintRunner SHALL eski lock dosyasını silmeli, yeni lock dosyasını oluşturmalı ve session'a devam etmeli.
4. WHEN session normal veya hata ile sonlandığında, THE AutoMintRunner SHALL lock dosyasını silmeli; process beklenmedik şekilde sonlanırsa lock dosyası diskte kalabilir (stale lock olarak sonraki başlatmada temizlenir).
5. THE AutoMintRunner SHALL lock dosyası oluşturma veya silme işlemlerini loglamalı.

---

### Requirement 3: Emergency Stop Mekanizması

**User Story:** Bir bot operatörü olarak, `STOP_AUTOMINT` dosyasını oluşturarak çalışan session'ı acil durdurmak istiyorum; böylece kod değişikliği veya process kill gerekmeden güvenli durdurma yapabileyim.

#### Acceptance Criteria

1. WHILE session aktifken, THE AutoMintRunner SHALL her poll döngüsünden önce `AUTO_MINT_EMERGENCY_STOP_FILE` dosyasının varlığını kontrol etmeli.
2. IF emergency stop dosyası mevcutsa, THEN THE AutoMintRunner SHALL o anki tx gönderimini tamamlamadan session'ı `reason: "emergency_stop_file_detected"` ile durdurmalı.
3. THE AutoMintRunner SHALL emergency stop dosyasını kendisi silmemeli; operatörün manuel olarak silmesi gerekir.
4. THE AutoMintRunner SHALL emergency stop tespitini `warn` seviyesinde loglamalı.

---

### Requirement 4: Session Limitleri

**User Story:** Bir bot operatörü olarak, tek bir session'da gönderilebilecek tx sayısını, günlük tx limitini ve maksimum çalışma süresini konfigüre etmek istiyorum; böylece beklenmedik aşırı harcama oluşmasın.

#### Acceptance Criteria

1. WHEN bir session'da gönderilen tx sayısı `AUTO_MINT_MAX_TX_PER_SESSION` değerine ulaştığında, THE AutoMintRunner SHALL `reason: "session_tx_limit_reached"` ile session'ı durdurmalı.
2. WHEN son 24 saatte `txs` tablosuna yazılan tx sayısı `AUTO_MINT_MAX_TX_PER_DAY` değerine ulaştığında, THE AutoMintRunner SHALL `reason: "daily_tx_limit_reached"` ile session'ı durdurmalı.
3. WHEN session başlangıcından itibaren geçen süre `AUTO_MINT_MAX_RUNTIME_MINUTES` dakikayı aştığında, THE AutoMintRunner SHALL `reason: "max_runtime_exceeded"` ile session'ı durdurmalı.
4. THE AutoMintRunner SHALL günlük tx sayısını `txs` tablosundaki `submitted_at` alanını kullanarak hesaplamalı; son 24 saatteki kayıtları saymalı.
5. THE AutoMintRunner SHALL session başlangıcında tüm limitleri loglamalı.

---

### Requirement 5: Wallet Balance Kontrolleri

**User Story:** Bir bot operatörü olarak, hot wallet bakiyesinin belirli bir aralıkta olduğunu doğrulamak istiyorum; böylece bakiye çok düşükse gas için yetersiz kalmasın, çok yüksekse risk oluşmasın.

#### Acceptance Criteria

1. WHEN her poll döngüsünde wallet balance kontrolü yapıldığında, THE AutoMintRunner SHALL `EthClient.getWalletBalanceEth(address)` ile güncel bakiyeyi almalı.
2. IF wallet balance `AUTO_MINT_MIN_WALLET_BALANCE_ETH` değerinin altındaysa, THEN THE AutoMintRunner SHALL o döngüde tx göndermemeli ve `reason: "skipped_wallet_balance_too_low"` loglamalı.
3. IF wallet balance `AUTO_MINT_REQUIRE_HOT_WALLET_BALANCE_MAX_ETH` değerinin üstündeyse, THEN THE AutoMintRunner SHALL o döngüde tx göndermemeli ve `reason: "skipped_wallet_balance_too_high"` loglamalı.
4. THE EthClient SHALL `getWalletBalanceEth(address: string): Promise<number>` metodunu sağlamalı; değer ETH cinsinden float olmalı.
5. THE AutoMintRunner SHALL balance kontrolü başarısız olduğunda (RPC hatası) tx göndermemeli ve hatayı loglamalı.

---

### Requirement 6: Fee ve Block Filtreleme

**User Story:** Bir bot operatörü olarak, fee gerektiren block'ları otomatik mint'ten hariç tutmak istiyorum; böylece beklenmedik fee ödemeleri oluşmasın.

#### Acceptance Criteria

1. WHEN `AUTO_MINT_ONLY_NO_FEE_BLOCKS=true` iken `feeRequired=true` olan bir block tespit edildiğinde, THE AutoMintRunner SHALL bu block için tx göndermemeli ve `reason: "skipped_fee_required_block"` loglamalı.
2. WHEN `AUTO_MINT_STOP_ON_FEE_REQUIRED=true` iken `feeRequired=true` olan bir block tespit edildiğinde, THE AutoMintRunner SHALL session'ı `reason: "fee_required_block_detected"` ile durdurmalı.
3. WHEN `AUTO_MINT_STOP_ON_REVIEW_REQUIRED=true` iken bir tx `review_required` durumuna geçtiğinde, THE AutoMintRunner SHALL session'ı `reason: "review_required_detected"` ile durdurmalı.
4. WHERE `AUTO_MINT_ALLOWED_START_BLOCK` tanımlıysa, THE AutoMintRunner SHALL bu değerden küçük block numaralarını atlamalı.
5. WHERE `AUTO_MINT_ALLOWED_STOP_BLOCK` tanımlıysa, THE AutoMintRunner SHALL bu değerden büyük block numaralarını atlamalı ve session'ı `reason: "allowed_stop_block_reached"` ile durdurmalı.

---

### Requirement 7: Scan ve Mint Döngüsü

**User Story:** Bir bot operatörü olarak, AutoMintRunner'ın mevcut BlockScanner ve MintExecutor'ı kullanarak sürekli döngüde mintable block aramasını ve bulduğunda mintlemesini istiyorum.

#### Acceptance Criteria

1. WHILE session aktifken, THE AutoMintRunner SHALL `AUTO_MINT_POLL_INTERVAL_MS` aralıklarla scan döngüsü çalıştırmalı.
2. WHEN mintable ve no-fee bir block bulunduğunda, THE AutoMintRunner SHALL mevcut `execute()` fonksiyonunu çağırarak tx göndermeli.
3. WHEN tx başarıyla submit edildiğinde, THE AutoMintRunner SHALL `AUTO_MINT_COOLDOWN_AFTER_TX_MS` kadar beklemelidir; bu süre içinde yeni tx gönderilmemeli.
4. WHEN `AUTO_MINT_CONFIRM_EACH_TX=false` iken tx gönderildiğinde, THE AutoMintRunner SHALL CLI onayı beklemeden otomatik olarak devam etmeli.
5. THE AutoMintRunner SHALL mevcut `MintExecutor`'ın tüm güvenlik kapılarını (Gate 1–12) atlatmamalı; bu kapılar her tx için çalışmaya devam etmeli.
6. WHEN `ALLOW_MULTIPLE_PENDING_TX=false` iken bekleyen bir tx mevcutsa, THE AutoMintRunner SHALL yeni tx göndermemeli ve `reason: "pending_tx_exists"` loglamalı.
7. WHEN bir block `unknown` status döndürdüğünde, THE AutoMintRunner SHALL checkpoint'i ilerletmemeli ve bir sonraki poll döngüsünde aynı block'u yeniden denemeli.
8. WHEN bir block `minted` status döndürdüğünde, THE AutoMintRunner SHALL checkpoint'i ilerletmeli ve bir sonraki block'a geçmeli.

---

### Requirement 8: TxMonitor Entegrasyonu

**User Story:** Bir bot operatörü olarak, AutoMintRunner'ın gönderilen tx'lerin finality durumunu izlemesini istiyorum; böylece session boyunca tx'lerin sonuçları takip edilsin.

#### Acceptance Criteria

1. WHEN bir tx submit edildikten sonra, THE AutoMintRunner SHALL mevcut `TxMonitor.poll()` fonksiyonunu çağırarak pending tx'lerin durumunu güncellemeli.
2. WHEN `AUTO_MINT_STOP_ON_REVIEW_REQUIRED=true` iken `TxMonitor` bir tx'i `review_required` olarak işaretlediğinde, THE AutoMintRunner SHALL session'ı durdurmalı.
3. THE AutoMintRunner SHALL `TxMonitor.poll()` hatalarını loglamalı ancak bu hatalar nedeniyle session'ı durdurmamali; scan döngüsü devam etmeli.

---

### Requirement 9: AutoMintReport ve Session Lifecycle

**User Story:** Bir bot operatörü olarak, session sonunda ne olduğunu özetleyen yapılandırılmış bir rapor almak istiyorum; böylece session'ın neden durduğunu ve kaç tx gönderildiğini anlayabileyim.

#### Acceptance Criteria

1. THE AutoMintRunner SHALL `runAutoMint(): Promise<AutoMintReport>` imzasıyla export edilmeli.
2. THE AutoMintReport SHALL en az şu alanları içermeli: `sessionId`, `startedAt`, `endedAt`, `txSentCount`, `txSentThisSession`, `stopReason`, `blocksScanned`, `errors`.
3. WHEN session herhangi bir nedenle sonlandığında, THE AutoMintRunner SHALL lock dosyasını temizlemeli ve `AutoMintReport` döndürmeli.
4. THE AutoMintRunner SHALL session başlangıcında ve sonunda `info` seviyesinde log yazmalı; `stopReason` her zaman loglanmalı.
5. THE AutoMintRunner SHALL `sessionId` olarak UUID veya timestamp tabanlı benzersiz bir değer kullanmalı.

---

### Requirement 10: CLI Entegrasyonu

**User Story:** Bir bot operatörü olarak, `npm run automint` komutuyla AutoMintRunner'ı başlatmak istiyorum; böylece mevcut komutlarla tutarlı bir CLI deneyimi olsun.

#### Acceptance Criteria

1. THE CLI SHALL `automint` komutunu desteklemeli; bu komut `runAutoMint()` fonksiyonunu çağırmalı.
2. THE CLI SHALL `npm run automint` script'ini `package.json`'a eklemeli.
3. WHEN `automint` komutu çalıştırıldığında, THE CLI SHALL session sonunda `AutoMintReport`'u konsola yazdırmalı.
4. WHEN `automint` komutu çalıştırıldığında, THE CLI SHALL mevcut `initDb()` ve `closeDb()` akışını kullanmalı.
5. THE CLI SHALL mevcut `scan`, `mint`, `resume`, `dry-run`, `monitor` komutlarını değiştirmemeli.

---

### Requirement 11: Konfigürasyon Genişletmesi

**User Story:** Bir bot operatörü olarak, tüm `AUTO_MINT_*` değişkenlerinin `config.ts`'de tip-güvenli olarak tanımlanmasını istiyorum; böylece yanlış konfigürasyon erken yakalanabilsin.

#### Acceptance Criteria

1. THE Config SHALL aşağıdaki yeni alanları içermeli (varsayılan değerleriyle):
   - `unattendedAutoMint: boolean` (default: `false`)
   - `autoMintMaxTxPerSession: number` (default: `1`)
   - `autoMintMaxTxPerDay: number` (default: `3`)
   - `autoMintMaxRuntimeMinutes: number` (default: `480`)
   - `autoMintPollIntervalMs: number` (default: `12000`)
   - `autoMintConfirmEachTx: boolean` (default: `false`)
   - `autoMintRequireHotWalletBalanceMaxEth: number` (default: `0.05`)
   - `autoMintMinWalletBalanceEth: number` (default: `0.005`)
   - `autoMintStopOnFirstError: boolean` (default: `true`)
   - `autoMintStopOnReviewRequired: boolean` (default: `true`)
   - `autoMintStopOnFeeRequired: boolean` (default: `true`)
   - `autoMintOnlyNoFeeBlocks: boolean` (default: `true`)
   - `autoMintAllowedStartBlock: number | undefined` (default: `undefined`)
   - `autoMintAllowedStopBlock: number | undefined` (default: `undefined`)
   - `autoMintCooldownAfterTxMs: number` (default: `60000`)
   - `autoMintEmergencyStopFile: string` (default: `"./STOP_AUTOMINT"`)
   - `autoMintSessionLockFile: string` (default: `"./automint.lock"`)
2. IF herhangi bir `AUTO_MINT_*` değişkeni geçersiz bir değer içeriyorsa, THEN THE Config SHALL başlangıçta açıklayıcı hata fırlatmalı.
3. THE `.env.example` dosyası tüm yeni `AUTO_MINT_*` değişkenlerini varsayılan değerleri ve açıklamalarıyla içermeli.

---

### Requirement 12: Güvenlik Kapılarının Korunması

**User Story:** Bir bot operatörü olarak, `UNATTENDED_AUTO_MINT` modunun mevcut güvenlik kapılarını (Gate 1–12) gevşetmemesini istiyorum; böylece otomatik mod manuel modla aynı güvenlik seviyesinde çalışsın.

#### Acceptance Criteria

1. THE AutoMintRunner SHALL `MintExecutor.execute()` fonksiyonunu doğrudan çağırmalı; Gate 1–12 kontrollerini bypass etmemeli veya kopyalamamalı.
2. WHEN `EDMT_API` doğrulaması (`edmtStatusConfirmed=false`) başarısız olduğunda, THE AutoMintRunner SHALL live tx göndermemeli; bu kural `UNATTENDED_AUTO_MINT=true` olduğunda da geçerli olmalı.
3. THE AutoMintRunner SHALL `PRIVATE_KEY` değerini hiçbir log çıktısında, hata mesajında veya `AutoMintReport`'ta göstermemeli.
4. WHEN `AUTO_MINT_STOP_ON_FIRST_ERROR=true` iken herhangi bir `error` seviyesinde hata oluştuğunda, THE AutoMintRunner SHALL session'ı `reason: "first_error_stop"` ile durdurmalı.
5. THE AutoMintRunner SHALL mevcut `DRY_RUN`, `ENABLE_LIVE_MINT` ve `PRIVATE_KEY` kontrollerini `runAutoMint()` başlangıcında tekrar doğrulamalı; bu kontroller `config.ts`'deki değerlere dayanmalı.

---

### Requirement 13: Test Kapsamı

**User Story:** Bir bot operatörü olarak, `autoMintRunner.ts` modülünün kritik davranışlarının otomatik testlerle doğrulanmasını istiyorum; böylece regresyon riski minimize edilsin.

#### Acceptance Criteria

1. THE Test Suite SHALL `UNATTENDED_AUTO_MINT=false` iken `runAutoMint()`'in session başlatmadığını doğrulamalı.
2. THE Test Suite SHALL `DRY_RUN=true` iken live tx gönderilmediğini doğrulamalı.
3. THE Test Suite SHALL `ENABLE_LIVE_MINT=false` iken session başlamadığını doğrulamalı.
4. THE Test Suite SHALL `PRIVATE_KEY` yokken session başlamadığını doğrulamalı.
5. THE Test Suite SHALL emergency stop dosyası mevcutken tx gönderilmediğini doğrulamalı.
6. THE Test Suite SHALL lock dosyası mevcutken ve PID hâlâ çalışıyorken ikinci instance'ın başlamadığını doğrulamalı.
7. THE Test Suite SHALL mintable no-fee block görüldüğünde tx gönderildiğini doğrulamalı.
8. THE Test Suite SHALL `feeRequired=true` block ve `AUTO_MINT_ONLY_NO_FEE_BLOCKS=true` iken tx gönderilmediğini doğrulamalı.
9. THE Test Suite SHALL `unknown` status'lü block için checkpoint'in ilerlemediğini doğrulamalı.
10. THE Test Suite SHALL `minted` status'lü block için checkpoint'in ilerlediğini doğrulamalı.
11. THE Test Suite SHALL `AUTO_MINT_MAX_TX_PER_SESSION` aşıldığında session'ın durduğunu doğrulamalı.
12. THE Test Suite SHALL `AUTO_MINT_MAX_TX_PER_DAY` aşıldığında session'ın durduğunu doğrulamalı.
13. THE Test Suite SHALL wallet balance min altındayken tx gönderilmediğini doğrulamalı.
14. THE Test Suite SHALL wallet balance max üstündeyken tx gönderilmediğini doğrulamalı.
15. THE Test Suite SHALL `ALLOW_MULTIPLE_PENDING_TX=false` iken pending tx varsa yeni tx gönderilmediğini doğrulamalı.
16. THE Test Suite SHALL `AUTO_MINT_STOP_ON_REVIEW_REQUIRED=true` iken review_required durumu tespit edildiğinde session'ın durduğunu doğrulamalı.
