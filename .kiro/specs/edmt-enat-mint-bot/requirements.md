# Requirements Document

## Introduction

Bu proje, Ethereum mainnet üzerinde çalışan EDMT/eNAT protokolünün "Mint a Block" akışını otomatikleştiren, güvenli, testli ve resume edilebilir bir bot sistemidir. Bot; hedef block'ların durumunu tarar, mintable olanları calldata-only transaction ile mintler, her adımı SQLite veritabanında checkpoint olarak saklar ve kesintisiz devam edebilir. Gerçek işlem gönderimi çift güvenlik bayrağı (DRY_RUN=false ve ENABLE_LIVE_MINT=true) gerektirerek yanlışlıkla işlem gönderimini önler.

## Glossary

- **Bot**: EDMT/eNAT mint akışını otomatikleştiren bu Node.js/TypeScript uygulaması.
- **Block**: Ethereum mainnet'te bir blok numarası; mint işleminin hedefi.
- **Mint**: EDMT protokolü üzerinden bir block'u sahiplenmek için gönderilen calldata-only Ethereum transaction'ı.
- **Calldata**: Ethereum transaction'ının `data` alanına yazılan, UTF-8 JSON payload'ının hex-encoded hali.
- **Checkpoint**: Bot'un tarama ve mint ilerlemesini kalıcı olarak sakladığı SQLite kaydı.
- **BlockStatus**: Bir block'un mevcut durumu: `mintable`, `minted`, `beyond_current_head`, `not_eligible`, `unknown`.
- **BurnGwei**: `floor(baseFeePerGas(N) * gasUsed(N) / 1e9)` formülüyle hesaplanan, bir block'un yakılan gas ücretinin gwei cinsinden değeri.
- **CaptureFee**: Bazı block'lar için EDMT protokolünün talep ettiği, protocol-layer raw fragment balance'tan ödenen ek ücret (ETH değil).
- **DryRun**: Gerçek transaction göndermeden tüm akışı simüle eden çalışma modu.
- **EIP1559ActivationBlock**: Ethereum mainnet'te EIP-1559'un aktif olduğu ilk blok: 12965000.
- **EDMT_API**: `https://www.edmt.io/api/v1` base URL'ine sahip EDMT protokol indexer API'si.
- **RPC**: Ethereum mainnet JSON-RPC sağlayıcısı.
- **NonceManager**: Aynı anda birden fazla transaction gönderilmesini önlemek için nonce yönetimini sağlayan bileşen.
- **TxMonitor**: Gönderilen transaction'ların onay durumunu takip eden bileşen.
- **FeeQuoter**: Bir block için gerekli capture fee'yi hesaplayan bileşen.
- **CalldataBuilder**: Mint payload'ını oluşturan ve hex-encode eden bileşen.
- **BlockScanner**: Block durumlarını tarayarak mintable adayları bulan bileşen.
- **MintExecutor**: Mint transaction'ını hazırlayan ve gönderen bileşen.
- **Checkpoint_Manager**: SQLite üzerinde checkpoint okuma/yazma işlemlerini yöneten bileşen.

---

## Requirements

### Requirement 1: Güvenli Çalışma Modu

**User Story:** Bir bot operatörü olarak, yanlışlıkla gerçek transaction göndermemek için botun varsayılan olarak dry-run modunda çalışmasını istiyorum; böylece gerçek mint işlemi için bilinçli bir onay gereksin.

#### Acceptance Criteria

1. THE Bot SHALL varsayılan olarak `DRY_RUN=true` ile başlatılmalı; bu değer açıkça `false` olarak ayarlanmadıkça gerçek transaction gönderilmemeli.
2. WHEN `DRY_RUN=true` iken mint akışı tetiklendiğinde, THE MintExecutor SHALL transaction göndermeden payload, hedef block, fee tahmini ve gas tahminini structured log olarak kaydetmeli.
3. IF `DRY_RUN=false` olmasına rağmen `ENABLE_LIVE_MINT=true` değilse, THEN THE MintExecutor SHALL transaction göndermemeli ve "live mint disabled" uyarısını loglamalı.
4. IF `PRIVATE_KEY` ortam değişkeni tanımlı değilse, THEN THE Bot SHALL live mint modunu başlatmayı reddetmeli ve açıklayıcı hata mesajı üretmeli.
5. THE Bot SHALL `PRIVATE_KEY` değerini hiçbir log çıktısında, hata mesajında veya veritabanı kaydında göstermemeli.
6. WHEN live mint modu aktifken (`DRY_RUN=false` ve `ENABLE_LIVE_MINT=true`), THE Bot SHALL ilk transaction öncesinde `REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX=true` ise kullanıcıdan CLI onayı almalı.

---

### Requirement 2: Block Durum Tespiti

**User Story:** Bir bot operatörü olarak, her block'un mint edilebilir olup olmadığını doğru şekilde tespit etmesini istiyorum; böylece yalnızca uygun block'lar mintlensin.

#### Acceptance Criteria

1. WHEN `edmtClient.getBlockStatus(blockNumber)` çağrıldığında, THE EdmtClient SHALL `{ block, status, burnGwei?, owner?, mintTx?, feeRequired?, requiredFeeGwei?, reason? }` tipinde bir nesne döndürmeli.
2. WHEN hedef block numarası Ethereum mainnet'in mevcut head block numarasından büyükse, THE EdmtClient SHALL `status: "beyond_current_head"` döndürmeli.
3. WHEN hedef block numarası `EIP1559ActivationBlock` (12965000) değerinden küçükse, THE BlockScanner SHALL bu block'u `not_eligible` olarak işaretlemeli ve `reason: "pre_eip1559"` eklemeli.
4. WHEN hedef block için `burnGwei` değeri 1 gwei'den küçükse, THE BlockScanner SHALL bu block'u `not_eligible` olarak işaretlemeli ve `reason: "burn_lt_1"` eklemeli.
5. WHEN EDMT indexer'da hedef block için geçerli bir mint kaydı mevcutsa, THE EdmtClient SHALL `status: "minted"` ve mevcut `owner` ile `mintTx` bilgilerini döndürmeli.
6. WHEN hedef block mintable olduğunda, THE EdmtClient SHALL `status: "mintable"` döndürmeli.
7. IF EDMT API erişilemez durumdaysa ve fallback kontrolleri de başarısız olursa, THEN THE EdmtClient SHALL `status: "unknown"` ve açıklayıcı `reason` döndürmeli; live mint yapılmamalı.
8. THE EdmtClient SHALL önce resmi EDMT API endpoint'lerini denemeli; başarısız olursa Ethereum RPC üzerinden block varlığı ve burn hesabı yaparak fallback stratejisini uygulamalı.

---

### Requirement 3: Calldata Oluşturma

**User Story:** Bir bot operatörü olarak, EDMT protokolünün beklediği formatta hatasız calldata üretilmesini istiyorum; böylece mint transaction'ları protokol tarafından kabul edilsin.

#### Acceptance Criteria

1. WHEN `buildMintPayload(block, undefined)` çağrıldığında, THE CalldataBuilder SHALL `data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"<N>"}` formatında, gereksiz whitespace içermeyen bir string döndürmeli.
2. WHEN `buildMintPayload(block, feeGwei)` çağrıldığında ve `feeGwei` tanımlıysa, THE CalldataBuilder SHALL `data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"<N>","fee":"<FEE_DECIMAL_STRING>"}` formatında bir string döndürmeli.
3. THE CalldataBuilder SHALL `fee` alanını yalnızca `feeGwei` parametresi tanımlı ve sıfırdan büyük olduğunda payload'a eklemeli; aksi halde `fee` alanı payload'da bulunmamalı.
4. WHEN `encodePayload(payload)` çağrıldığında, THE CalldataBuilder SHALL payload string'ini UTF-8 olarak hex-encode etmeli ve `0x` prefix'i ile döndürmeli.
5. THE CalldataBuilder SHALL `fee` değerini ondalık string olarak (bigint'in string temsili) payload'a yazmalı; bilimsel notasyon veya float kullanmamalı.
6. FOR ALL geçerli `(block, feeGwei?)` çiftleri için, `encodePayload(buildMintPayload(block, feeGwei))` işleminin hex-decode edilip JSON.parse edilmesi orijinal payload ile eşdeğer bir nesne üretmeli (round-trip özelliği).

---

### Requirement 4: Block Tarama ve Aday Seçimi

**User Story:** Bir bot operatörü olarak, botun belirlenen aralıkta block'ları sistematik olarak taramasını ve mintable adayları bulmasını istiyorum.

#### Acceptance Criteria

1. THE BlockScanner SHALL `START_BLOCK` ile `STOP_BLOCK` (tanımlıysa) arasındaki block'ları `SCAN_DIRECTION` konfigürasyonuna göre (`ascending` veya `descending`) taramalı.
2. WHEN `scanBatch()` çağrıldığında, THE BlockScanner SHALL en fazla `MAX_BLOCKS_PER_RUN` kadar block'u tek seferde işlemeli.
3. WHEN `getNextCandidate()` çağrıldığında, THE BlockScanner SHALL checkpoint'ten kaldığı yerden devam etmeli; tarama başlangıcına dönmemeli.
4. WHEN bir block `beyond_current_head` durumundaysa, THE BlockScanner SHALL `POLL_INTERVAL_MS` kadar bekleyip aynı block'u yeniden denemeli veya konfigürasyona göre sıradaki block'a geçmeli.
5. WHEN bir block `minted` durumundaysa, THE BlockScanner SHALL bu block'u atlamalı ve bir sonraki block'a geçmeli.
6. WHEN bir block `not_eligible` durumundaysa, THE BlockScanner SHALL bu block'u atlamalı ve bir sonraki block'a geçmeli.
7. THE BlockScanner SHALL API çağrılarında `API_RETRY_LIMIT` kadar yeniden deneme yapmalı; tüm denemeler başarısız olursa block'u `unknown` olarak işaretlemeli.

---

### Requirement 5: Checkpoint ve Resume Yeteneği

**User Story:** Bir bot operatörü olarak, botun herhangi bir kesintiden sonra kaldığı yerden devam edebilmesini istiyorum; böylece tarama başa dönmesin ve aynı block iki kez mintlenmesin.

#### Acceptance Criteria

1. THE Checkpoint_Manager SHALL `last_scanned_block` değerini başlangıçta `START_BLOCK` olarak SQLite `checkpoints` tablosuna yazmalı; eğer kayıt zaten mevcutsa mevcut değeri korumalı.
2. WHEN bir block `minted`, `not_eligible` veya `successful_mint` durumuna geçtiğinde, THE Checkpoint_Manager SHALL `last_scanned_block` değerini `block + 1` olarak güncellemeli.
3. WHEN bir block `beyond_current_head` durumundaysa, THE Checkpoint_Manager SHALL checkpoint'i ilerletmemeli; bot aynı block'u yeniden denemeli.
4. WHEN bir block `unknown` veya hata durumundaysa, THE Checkpoint_Manager SHALL checkpoint'i ilerletmemeli ve hatayı `errors` tablosuna yazmalı.
5. WHEN mint transaction başarıyla submit edildiğinde, THE Checkpoint_Manager SHALL `last_submitted_block` değerini ilgili block numarasıyla kaydetmeli.
6. WHEN mint transaction finality onayı alındığında, THE Checkpoint_Manager SHALL `last_successful_mint_block` değerini ilgili block numarasıyla kaydetmeli.
7. THE Bot SHALL `npm run resume` komutuyla başlatıldığında `last_scanned_block` checkpoint'inden itibaren taramaya devam etmeli.
8. WHILE bot çalışırken her kesin durum kararından sonra, THE Checkpoint_Manager SHALL checkpoint'i kalıcı olarak SQLite'a yazmalı; bellek içi durum yeterli sayılmamalı.

---

### Requirement 6: Mint Transaction Gönderimi

**User Story:** Bir bot operatörü olarak, mint transaction'larının EDMT protokol kurallarına uygun şekilde gönderilmesini istiyorum; böylece işlemler protokol tarafından geçerli sayılsın.

#### Acceptance Criteria

1. WHEN live mint modu aktifken mintable bir block tespit edildiğinde, THE MintExecutor SHALL `to = wallet.address`, `from = wallet.address`, `value = 0`, `data = hex-encoded calldata` içeren bir EIP-1559 transaction oluşturmalı.
2. THE MintExecutor SHALL `maxFeePerGas` değerini `MAX_GAS_GWEI` konfigürasyon limitini aşmayacak şekilde ayarlamalı.
3. THE MintExecutor SHALL `maxPriorityFeePerGas` değerini `MAX_PRIORITY_FEE_GWEI` konfigürasyon limitini aşmayacak şekilde ayarlamalı.
4. IF aynı block için `txs` tablosunda daha önce submit edilmiş bir transaction kaydı mevcutsa, THEN THE MintExecutor SHALL yeni transaction göndermemeli ve "duplicate tx prevented" loglamalı.
5. WHEN transaction gönderildiğinde, THE MintExecutor SHALL tx hash'ini, nonce'u ve gas bilgisini `txs` tablosuna yazmalı.
6. THE MintExecutor SHALL tek bir bot çalışmasında en fazla `MAX_TX_PER_RUN` kadar transaction göndermeli; bu limite ulaşıldığında taramayı durdurmalı.
7. WHEN capture fee gerekli olduğunda, THE MintExecutor SHALL `requiredFeeGwei` değerini `MAX_CAPTURE_FEE_GWEI` ile karşılaştırmalı; fee limiti aşılıyorsa mint yapmamalı ve "fee exceeds max" loglamalı.
8. IF capture fee quote alınamıyorsa, THEN THE MintExecutor SHALL live mint yapmayı reddetmeli ve "fee quote unavailable" hatasını loglamalı.

---

### Requirement 7: Transaction İzleme ve Finality

**User Story:** Bir bot operatörü olarak, gönderilen transaction'ların onay durumunu takip etmesini istiyorum; böylece başarılı ve başarısız mintler doğru şekilde kaydedilsin.

#### Acceptance Criteria

1. THE TxMonitor SHALL `txs` tablosundaki `status = "pending"` olan tüm transaction'ları periyodik olarak kontrol etmeli.
2. WHEN bir transaction receipt'inin `status === 1` olduğu tespit edildiğinde, THE TxMonitor SHALL ilgili `txs` kaydını `"included"` olarak güncellemeli.
3. WHEN bir transaction receipt'inin `status !== 1` olduğu tespit edildiğinde, THE TxMonitor SHALL ilgili `txs` kaydını `"failed"` olarak güncellemeli.
4. WHEN bir transaction `"included"` durumuna geçtiğinde, THE TxMonitor SHALL EDMT indexer'da ilgili block'un `owner` adresinin gönderen wallet adresiyle eşleşip eşleşmediğini doğrulamalı.
5. WHEN finality için gerekli onay sayısına ulaşıldığında, THE TxMonitor SHALL EDMT indexer'da son bir doğrulama daha yapmalı.
6. IF indexer doğrulaması başarısız olursa veya `owner` adresi eşleşmiyorsa, THEN THE TxMonitor SHALL ilgili block'u `"review_required"` olarak işaretlemeli ve uyarı loglamalı.
7. IF chain reorganizasyonu tespit edilirse, THEN THE TxMonitor SHALL etkilenen transaction'ları `"review_required"` olarak işaretlemeli ve uyarı loglamalı.

---

### Requirement 8: Veritabanı ve Kalıcı Depolama

**User Story:** Bir bot operatörü olarak, tüm tarama sonuçlarının, transaction'ların ve hataların kalıcı olarak saklanmasını istiyorum; böylece geçmişe dönük analiz ve hata ayıklama yapabileyim.

#### Acceptance Criteria

1. THE Bot SHALL başlangıçta SQLite veritabanını `SQLITE_PATH` konfigürasyonundaki yolda oluşturmalı; tablolar mevcut değilse otomatik olarak oluşturulmalı.
2. THE Bot SHALL `checkpoints(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)` tablosunu oluşturmalı ve yönetmeli.
3. THE Bot SHALL `block_results(block INTEGER PRIMARY KEY, status TEXT, burn_gwei TEXT, fee_required INTEGER, required_fee_gwei TEXT, owner TEXT, mint_tx TEXT, reason TEXT, updated_at TEXT)` tablosunu oluşturmalı ve yönetmeli.
4. THE Bot SHALL `txs(id INTEGER PRIMARY KEY AUTOINCREMENT, block INTEGER, tx_hash TEXT UNIQUE, status TEXT, nonce INTEGER, gas_info TEXT, submitted_at TEXT, updated_at TEXT)` tablosunu oluşturmalı ve yönetmeli.
5. THE Bot SHALL `errors(id INTEGER PRIMARY KEY AUTOINCREMENT, block INTEGER, stage TEXT, message TEXT, stack TEXT, created_at TEXT)` tablosunu oluşturmalı ve yönetmeli.
6. WHEN bir block'un durumu kesinleştiğinde, THE Bot SHALL sonucu `block_results` tablosuna yazmalı veya güncellemeli.
7. THE Bot SHALL veritabanı işlemlerinde hata oluştuğunda işlemi `errors` tablosuna kaydetmeli ve bot çalışmasını durdurmadan devam etmeli.

---

### Requirement 9: Capture Fee Yönetimi

**User Story:** Bir bot operatörü olarak, capture fee gerektiren block'lar için doğru fee değerinin hesaplanmasını ve uygulanmasını istiyorum; böylece overpayment yapılmasın ve fee gerektirmeyen block'lara gereksiz fee eklenmesi.

#### Acceptance Criteria

1. WHEN `feeQuoter.getRequiredFee(blockNumber)` çağrıldığında, THE FeeQuoter SHALL önce EDMT API fee quote endpoint'ini denemelidir; endpoint mevcut değilse `undefined` döndürmeli.
2. WHEN hedef block için capture fee gerekmiyorsa, THE FeeQuoter SHALL `undefined` döndürmeli ve calldata'ya `fee` alanı eklenmemeli.
3. WHEN hedef block için capture fee gerekiyorsa, THE FeeQuoter SHALL tam `requiredFeeGwei` değerini döndürmeli; overpayment refund edilmediğinden birebir değer kullanılmalı.
4. IF `requiredFeeGwei` değeri `MAX_CAPTURE_FEE_GWEI` konfigürasyon limitini aşıyorsa, THEN THE MintExecutor SHALL mint işlemini iptal etmeli ve "fee exceeds max" loglamalı.
5. IF fee quote alınamıyorsa ve block fee gerektiriyorsa, THEN THE MintExecutor SHALL live mint yapmayı reddetmeli.

---

### Requirement 10: Gas Yönetimi

**User Story:** Bir bot operatörü olarak, gas fiyatlarının konfigürasyon limitlerini aşmamasını istiyorum; böylece beklenmedik yüksek gas maliyetleri oluşmasın.

#### Acceptance Criteria

1. WHEN EIP-1559 transaction oluşturulduğunda, THE MintExecutor SHALL `provider.getFeeData()` ile güncel gas fiyatlarını almalı.
2. IF `maxFeePerGas` değeri `MAX_GAS_GWEI * 1e9` değerini aşıyorsa, THEN THE MintExecutor SHALL transaction göndermemeli ve "gas price exceeds limit" loglamalı.
3. IF `maxPriorityFeePerGas` değeri `MAX_PRIORITY_FEE_GWEI * 1e9` değerini aşıyorsa, THEN THE MintExecutor SHALL `maxPriorityFeePerGas` değerini `MAX_PRIORITY_FEE_GWEI * 1e9` ile sınırlandırmalı.
4. THE MintExecutor SHALL RPC çağrılarında `RPC_RETRY_LIMIT` kadar yeniden deneme yapmalı; tüm denemeler başarısız olursa işlemi iptal etmeli.

---

### Requirement 11: CLI Arayüzü

**User Story:** Bir bot operatörü olarak, botu komut satırından kolayca yönetebilmek istiyorum; böylece tarama, mint, durum sorgulama ve resume işlemlerini ayrı komutlarla çalıştırabileyim.

#### Acceptance Criteria

1. THE CLI SHALL `npm run scan -- --limit <N>` komutuyla en fazla `N` block taramalı ve sonuçları loglamalı.
2. THE CLI SHALL `npm run mint -- --block <N>` komutuyla belirtilen block'u mint etmeyi denemeli.
3. THE CLI SHALL `npm run resume` komutuyla checkpoint'ten kaldığı yerden tarama ve mint akışını sürdürmeli.
4. THE CLI SHALL `npm run status` komutuyla son checkpoint durumunu, toplam taranan block sayısını ve başarılı mint sayısını göstermeli.
5. THE CLI SHALL `npm run pending` komutuyla `txs` tablosundaki `status = "pending"` transaction'ları listelemeli.
6. THE CLI SHALL `npm run dry-run -- --from <START> --limit <N>` komutuyla belirtilen aralıkta dry-run modunda tarama yapmalı; gerçek transaction göndermemeli.
7. THE CLI SHALL geçersiz veya eksik parametre girildiğinde açıklayıcı hata mesajı ve kullanım kılavuzu göstermeli.

---

### Requirement 12: Loglama ve Gözlemlenebilirlik

**User Story:** Bir bot operatörü olarak, botun tüm önemli olayları yapılandırılmış log formatında kaydetmesini istiyorum; böylece sorunları hızlıca tespit edebileyim.

#### Acceptance Criteria

1. THE Bot SHALL pino veya eşdeğer bir structured logger kullanmalı; tüm loglar JSON formatında olmalı.
2. THE Bot SHALL her block tarama kararını (status, burnGwei, reason) log seviyesi `info` ile kaydetmeli.
3. THE Bot SHALL her transaction gönderimini (block, txHash, gasInfo) log seviyesi `info` ile kaydetmeli.
4. THE Bot SHALL API ve RPC hatalarını log seviyesi `warn` ile kaydetmeli; retry sayısını da belirtmeli.
5. THE Bot SHALL kritik hataları (live mint engeli, DB hatası) log seviyesi `error` ile kaydetmeli.
6. THE Bot SHALL `PRIVATE_KEY`, seed phrase veya benzeri hassas bilgileri hiçbir log satırında göstermemeli.

---

### Requirement 13: EDMT API Entegrasyonu ve Fallback

**User Story:** Bir bot operatörü olarak, EDMT API erişilemez olduğunda botun güvenli fallback stratejisiyle çalışmaya devam etmesini istiyorum; böylece API kesintileri live mint'i engellesin ama taramayı durdurmasın.

#### Acceptance Criteria

1. THE EdmtClient SHALL block durumu için önce EDMT API endpoint'lerini denemeli; başarısız olursa Ethereum RPC üzerinden block varlığı ve burn değeri hesabıyla fallback yapmalı.
2. WHEN EDMT API erişilemez durumdaysa ve block-specific status endpoint'i bulunamazsa, THE EdmtClient SHALL live mint'i engellemeli ve `status: "unknown"` döndürmeli.
3. THE EdmtClient SHALL `/api/v1/mints/recent` endpoint'ini yalnızca yardımcı bilgi için kullanmalı; bu endpoint'in yokluğu veya eksik tarihsel veri içermesi live mint kararını etkilememeli.
4. THE EdmtClient SHALL API ve RPC çağrılarını modüler endpoint konfigürasyonu üzerinden yapmalı; endpoint URL'leri kod içinde sabit yazılmamalı, konfigürasyondan okunmalı.
5. IF EDMT API'den block-specific status alınamıyorsa ve RPC fallback da yetersizse, THEN THE EdmtClient SHALL açık hata mesajıyla `status: "unknown"` döndürmeli ve bu durumu `errors` tablosuna yazmalı.
