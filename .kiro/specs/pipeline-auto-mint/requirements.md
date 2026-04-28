# Requirements Document

## Introduction

EDMT/eNAT Mint Bot'a "Pipeline Auto Mint Mode" özelliği eklenmektedir. Mevcut durumda bot, her mint tx gönderiminden sonra 64 confirmation finality beklemekte (~14 dakika/mint) ve bu nedenle 8 saatlik bir session'da yalnızca ~36 tx gönderilebilmektedir. Pipeline modu, finality beklenmeksizin birden fazla tx'in eş zamanlı olarak "uçuşta" olmasına izin vererek throughput'u önemli ölçüde artırır. Güvenli varsayılan (false) korunur; tüm mevcut güvenlik kapıları (Gate 1–12) geçerliliğini sürdürür.

## Glossary

- **AutoMintRunner**: Gözetimsiz mint session'larını yöneten ana döngü bileşeni (`src/autoMintRunner.ts`).
- **TxMonitor**: Bekleyen tx'lerin durumunu izleyen ve finality doğrulaması yapan bileşen (`src/txMonitor.ts`).
- **MintExecutor**: Mint tx'lerini hazırlayan ve zincire gönderen bileşen (`src/mintExecutor.ts`).
- **Pipeline_Mode**: `AUTO_MINT_PIPELINE_MODE=true` ile etkinleştirilen, finality beklenmeksizin birden fazla tx'in eş zamanlı olarak uçuşta olabildiği çalışma modu.
- **Pending_Tx**: Zincire gönderilmiş ancak henüz receipt alınmamış (`status = 'pending'`) tx.
- **Included_Tx**: Receipt alınmış, zincire dahil edilmiş ancak henüz finality'e ulaşmamış (`status = 'included'`) tx.
- **Unfinalized_Tx**: `status IN ('pending', 'included')` olan, yani finality'e ulaşmamış tx.
- **Nonce_Anomaly**: Nonce gap, replacement veya dropped tx gibi nonce tutarsızlığı durumu.
- **Scan_Checkpoint**: `last_scanned_block` — tx submit edilen block için ilerleyebilen tarama noktası.
- **Mint_Checkpoint**: `last_successful_mint_block` — yalnızca finality + EDMT owner doğrulaması sonrası ilerleyen başarılı mint noktası.
- **Review_Required**: Manuel inceleme gerektiren, otomatik işlemin durması gereken hata durumu.
- **Tx_Spacing**: İki ardışık tx gönderimi arasında zorunlu bekleme süresi (`AUTO_MINT_TX_SPACING_MS`).
- **Monitor_Phase**: Her loop iterasyonunun başında `TxMonitor.poll()` çalıştırılan izleme aşaması.
- **Scan_Send_Phase**: Mintable block aranıp tx gönderildiği tarama/gönderim aşaması.

---

## Requirements

### Requirement 1: Pipeline Mode Konfigürasyonu

**User Story:** Bir operatör olarak, pipeline modunu bir environment variable ile kontrol etmek istiyorum; böylece mevcut güvenli davranışı bozmadan yeni modu isteğe bağlı olarak etkinleştirebilirim.

#### Acceptance Criteria

1. THE AutoMintRunner SHALL `AUTO_MINT_PIPELINE_MODE` environment variable'ını okuyarak pipeline modunu belirlesin; varsayılan değer `false` olsun.
2. THE AutoMintRunner SHALL `AUTO_MINT_MAX_PENDING_TXS` environment variable'ını okuyarak eş zamanlı pending tx üst sınırını belirlesin; varsayılan değer `3` olsun.
3. THE AutoMintRunner SHALL `AUTO_MINT_MAX_UNFINALIZED_TXS` environment variable'ını okuyarak eş zamanlı unfinalized tx üst sınırını belirlesin; varsayılan değer `10` olsun.
4. THE AutoMintRunner SHALL `AUTO_MINT_TX_SPACING_MS` environment variable'ını okuyarak ardışık tx'ler arasındaki minimum bekleme süresini belirlesin; varsayılan değer `30000` ms olsun.
5. THE AutoMintRunner SHALL `AUTO_MINT_STOP_ON_PENDING_TX_FAILURE=true` olduğunda herhangi bir tx `failed` durumuna geçtiğinde yeni tx gönderimini durdursun.
6. THE AutoMintRunner SHALL `AUTO_MINT_RECONCILE_INTERVAL_MS` environment variable'ını okuyarak TxMonitor reconcile aralığını belirlesin; varsayılan değer `12000` ms olsun.
7. THE AutoMintRunner SHALL `AUTO_MINT_REQUIRE_INCLUDED_BEFORE_NEXT_TX` environment variable'ını okuyarak bir sonraki tx'ten önce önceki tx'in `included` durumuna geçmesinin zorunlu olup olmadığını belirlesin; varsayılan değer `false` olsun.
8. WHERE `AUTO_MINT_PIPELINE_MODE=false`, THE AutoMintRunner SHALL mevcut davranışı (pending tx varken yeni tx göndermeme) aynen korusun.

---

### Requirement 2: Pipeline Mode — Loop Mimarisi

**User Story:** Bir operatör olarak, pipeline modunda AutoMintRunner'ın her loop iterasyonunda önce tx izlemesi yapmasını, ardından kapasite kontrolüne göre yeni tx göndermesini istiyorum; böylece finality beklenmeksizin sürekli tarama yapılabilsin.

#### Acceptance Criteria

1. WHEN `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL her loop iterasyonunun başında `TxMonitor.poll()` çağırsın (Monitor Phase).
2. WHEN `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL Monitor Phase tamamlandıktan sonra Scan/Send Phase'e geçsin.
3. WHEN `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL pending tx sayısı `AUTO_MINT_MAX_PENDING_TXS` değerinden küçük olduğunda ve unfinalized tx sayısı `AUTO_MINT_MAX_UNFINALIZED_TXS` değerinden küçük olduğunda yeni mintable block arayıp tx gönderebilsin.
4. WHEN `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL pending tx sayısı `AUTO_MINT_MAX_PENDING_TXS` değerine eşit veya büyük olduğunda yeni tx göndermeyip bir sonraki loop iterasyonuna geçsin.
5. WHEN `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL unfinalized tx sayısı `AUTO_MINT_MAX_UNFINALIZED_TXS` değerine eşit veya büyük olduğunda yeni tx göndermeyip bir sonraki loop iterasyonuna geçsin.
6. WHEN `AUTO_MINT_PIPELINE_MODE=false`, THE AutoMintRunner SHALL herhangi bir pending veya included tx mevcutsa yeni tx göndermeyip mevcut davranışı korusun.

---

### Requirement 3: Tx Spacing (Ardışık Tx Arası Bekleme)

**User Story:** Bir operatör olarak, ardışık tx'ler arasında minimum bir bekleme süresi olmasını istiyorum; böylece mempool'u aşırı yüklemeden ve nonce çakışmalarını önleyerek güvenli bir şekilde pipeline çalıştırabileyim.

#### Acceptance Criteria

1. THE AutoMintRunner SHALL son tx gönderiminden bu yana geçen süreyi takip etsin.
2. WHEN `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL son tx gönderiminden bu yana `AUTO_MINT_TX_SPACING_MS` ms geçmeden yeni tx göndermeyip bekleme logunu yazsın.
3. WHEN `AUTO_MINT_PIPELINE_MODE=true` ve tx spacing süresi dolmuşsa, THE AutoMintRunner SHALL kapasite kontrolünü geçen ilk mintable block için tx gönderimini gerçekleştirsin.
4. WHEN `AUTO_MINT_PIPELINE_MODE=false`, THE AutoMintRunner SHALL `AUTO_MINT_TX_SPACING_MS` değerini uygulamasın; mevcut `AUTO_MINT_COOLDOWN_AFTER_TX_MS` davranışını korusun.

---

### Requirement 4: Nonce Yönetimi

**User Story:** Bir operatör olarak, pipeline modunda birden fazla tx eş zamanlı uçuşta olduğunda nonce çakışmalarının önlenmesini istiyorum; böylece tx'lerin zincirde başarıyla işlenmesi garanti altına alınsın.

#### Acceptance Criteria

1. WHEN `AUTO_MINT_PIPELINE_MODE=true`, THE MintExecutor SHALL her yeni tx için `provider.getTransactionCount(address, "pending")` çağrısıyla güncel nonce değerini alsın.
2. THE MintExecutor SHALL aynı nonce değerini iki farklı tx için kullanmasın; nonce çakışması tespit edildiğinde tx gönderimini atlayıp `nonce_conflict` logunu yazsın.
3. WHEN nonce gap, replacement veya dropped tx tespit edilirse, THE AutoMintRunner SHALL yeni tx gönderimini durdursun ve `pipeline_nonce_anomaly` log event'i yazsın.
4. WHEN nonce anomaly nedeniyle tx gönderimi durduğunda, THE AutoMintRunner SHALL `review_required` durumunu üretsin ve session'ı sonlandırsın.

---

### Requirement 5: Checkpoint Stratejisi

**User Story:** Bir operatör olarak, pipeline modunda scan checkpoint'inin tx submit sonrası ilerlemesini, mint checkpoint'inin ise yalnızca finality + owner doğrulaması sonrası ilerlemesini istiyorum; böylece duplicate tx riski olmadan tarama sürekliliği sağlansın.

#### Acceptance Criteria

1. WHEN `AUTO_MINT_PIPELINE_MODE=true` ve bir block için tx submit edildiğinde, THE AutoMintRunner SHALL `last_scanned_block` (scan checkpoint) değerini o block için ilerletsin.
2. THE TxMonitor SHALL bir tx finality'e ulaşıp EDMT owner doğrulaması başarılı olduğunda `last_successful_mint_block` (mint checkpoint) değerini ilerletsin.
3. THE AutoMintRunner SHALL tx submit edilen block'u `block_results` tablosunda `submitted` olarak işaretlesin; böylece aynı block için duplicate tx gönderimi önlensin.
4. WHEN bir block `block_results` tablosunda `submitted` veya daha ileri bir status ile kayıtlıysa, THE MintExecutor SHALL o block için yeni tx göndermeyip `pipeline_duplicate_prevented` log event'i yazsın.
5. WHEN `TxMonitor.poll()` bir tx'i `unknown` status ile karşılaştığında, THE AutoMintRunner SHALL scan checkpoint'ini ilerletmesin.

---

### Requirement 6: Hata Durumlarında Durdurma

**User Story:** Bir operatör olarak, review_required, tx failure veya nonce anomaly gibi kritik hata durumlarında pipeline'ın otomatik olarak durmasını istiyorum; böylece hatalı durumda tx gönderimi devam etmesin.

#### Acceptance Criteria

1. WHEN herhangi bir tx `review_required` durumuna geçtiğinde ve `AUTO_MINT_STOP_ON_REVIEW_REQUIRED=true` ise, THE AutoMintRunner SHALL yeni tx gönderimini durdursun ve session'ı `review_required_detected` stop reason ile sonlandırsın.
2. WHEN herhangi bir tx `failed` durumuna geçtiğinde ve `AUTO_MINT_STOP_ON_PENDING_TX_FAILURE=true` ise, THE AutoMintRunner SHALL yeni tx gönderimini durdursun ve session'ı `pending_tx_failure_detected` stop reason ile sonlandırsın.
3. WHEN nonce anomaly tespit edildiğinde, THE AutoMintRunner SHALL yeni tx gönderimini durdursun ve session'ı `nonce_anomaly_detected` stop reason ile sonlandırsın.
4. WHEN `AUTO_MINT_PIPELINE_MODE=true` ve `AUTO_MINT_STOP_ON_PENDING_TX_FAILURE=false` ise, THE AutoMintRunner SHALL failed tx'i atlayıp pipeline'ı sürdürsün.

---

### Requirement 7: Fee Filtering (Pipeline Modunda)

**User Story:** Bir operatör olarak, pipeline modunda da fee gerektiren block'ların `AUTO_MINT_ONLY_NO_FEE_BLOCKS=true` ayarına göre atlanmasını istiyorum; böylece session durmadan tarama devam etsin.

#### Acceptance Criteria

1. WHEN `AUTO_MINT_PIPELINE_MODE=true` ve `AUTO_MINT_ONLY_NO_FEE_BLOCKS=true` ve bir block `feeRequired=true` ise, THE AutoMintRunner SHALL o block'u atlayıp scan checkpoint'ini ilerletsin ve session'ı durdurmayıp taramaya devam etsin.
2. WHEN `AUTO_MINT_PIPELINE_MODE=true` ve `AUTO_MINT_STOP_ON_FEE_REQUIRED=true` ve bir block `feeRequired=true` ise, THE AutoMintRunner SHALL session'ı `fee_required_block_detected` stop reason ile sonlandırsın.

---

### Requirement 8: Mevcut Limitlerin Korunması

**User Story:** Bir operatör olarak, pipeline modu etkin olsa bile tüm mevcut session, günlük ve gas limitlerinin geçerliliğini korumasını istiyorum; böylece güvenlik garantileri bozulmasın.

#### Acceptance Criteria

1. WHILE `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL `AUTO_MINT_MAX_TX_PER_SESSION` limitini uygulasın; bu limite ulaşıldığında session'ı `session_tx_limit_reached` stop reason ile sonlandırsın.
2. WHILE `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL `AUTO_MINT_MAX_TX_PER_DAY` limitini uygulasın; bu limite ulaşıldığında session'ı `daily_tx_limit_reached` stop reason ile sonlandırsın.
3. WHILE `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL `AUTO_MINT_MAX_RUNTIME_MINUTES` limitini uygulasın; bu süre aşıldığında session'ı `max_runtime_exceeded` stop reason ile sonlandırsın.
4. WHILE `AUTO_MINT_PIPELINE_MODE=true`, THE MintExecutor SHALL `MAX_GAS_GWEI` ve `MAX_PRIORITY_FEE_GWEI` limitlerini uygulasın; gas limiti aşıldığında tx'i atlasın.
5. WHILE `AUTO_MINT_PIPELINE_MODE=true`, THE AutoMintRunner SHALL `AUTO_MINT_MIN_WALLET_BALANCE_ETH` ve `AUTO_MINT_REQUIRE_HOT_WALLET_BALANCE_MAX_ETH` kontrollerini her loop iterasyonunda uygulasın.

---

### Requirement 9: Log Event'leri

**User Story:** Bir operatör olarak, pipeline moduna özgü log event'lerinin yazılmasını istiyorum; böylece session davranışını izleyip sorunları hızlıca tespit edebileyim.

#### Acceptance Criteria

1. WHEN `AUTO_MINT_PIPELINE_MODE=true` ile session başladığında, THE AutoMintRunner SHALL `pipeline_mode_enabled` log event'ini yazsın.
2. WHEN tx spacing süresi dolmadığı için bekleme yapıldığında, THE AutoMintRunner SHALL `pipeline_tx_spacing_wait` log event'ini kalan süreyle birlikte yazsın.
3. WHEN pending kapasitesi müsait olduğunda, THE AutoMintRunner SHALL `pipeline_pending_capacity_available` log event'ini mevcut pending/unfinalized sayılarıyla birlikte yazsın.
4. WHEN pending veya unfinalized kapasite dolduğunda, THE AutoMintRunner SHALL `pipeline_pending_capacity_full` log event'ini yazsın.
5. WHEN pipeline modunda tx başarıyla submit edildiğinde, THE AutoMintRunner SHALL `pipeline_tx_submitted` log event'ini tx hash ve block numarasıyla birlikte yazsın.
6. WHEN Monitor Phase'de `TxMonitor.poll()` çağrıldığında, THE AutoMintRunner SHALL `pipeline_monitor_poll` log event'ini yazsın.
7. WHEN bir tx finalize edilip reconcile yapıldığında, THE TxMonitor SHALL `pipeline_finalized_reconciled` log event'ini yazsın.
8. WHEN nonce anomaly tespit edildiğinde, THE AutoMintRunner SHALL `pipeline_nonce_anomaly` log event'ini yazsın.
9. WHEN duplicate tx önlendiğinde, THE MintExecutor SHALL `pipeline_duplicate_prevented` log event'ini block numarasıyla birlikte yazsın.

---

### Requirement 10: Dokümantasyon Güncellemeleri

**User Story:** Bir operatör olarak, README ve RUNBOOK'ta Pipeline Auto Mint Mode için açıklayıcı bir bölüm olmasını istiyorum; böylece özelliği doğru şekilde yapılandırıp kullanabileyim.

#### Acceptance Criteria

1. THE README SHALL "Pipeline Auto Mint Mode" başlıklı bir bölüm içersin; bu bölüm tüm yeni config değişkenlerini, varsayılan değerlerini ve önerilen production profilini açıklasın.
2. THE RUNBOOK SHALL pipeline moduna özgü operasyonel prosedürleri, izleme adımlarını ve sorun giderme rehberini içersin.
3. THE `.env.example` SHALL tüm yeni `AUTO_MINT_PIPELINE_*` değişkenlerini Türkçe açıklamalarıyla birlikte içersin.

---

### Requirement 11: Testler

**User Story:** Bir geliştirici olarak, pipeline modunun tüm kritik davranışlarının otomatik testlerle doğrulanmasını istiyorum; böylece regresyon riski olmadan özelliği güvenle deploy edebileyim.

#### Acceptance Criteria

1. WHEN `AUTO_MINT_PIPELINE_MODE=false` ve pending tx mevcutsa, THE AutoMintRunner SHALL yeni tx göndermeyip mevcut davranışı korusun — bu davranış bir unit test ile doğrulanmalıdır.
2. WHEN `AUTO_MINT_PIPELINE_MODE=true` ve pending tx mevcutsa ancak pending count `AUTO_MINT_MAX_PENDING_TXS` değerinden küçükse, THE AutoMintRunner SHALL yeni tx gönderebilsin — bu davranış bir unit test ile doğrulanmalıdır.
3. WHEN `AUTO_MINT_PIPELINE_MODE=true` ve pending count `AUTO_MINT_MAX_PENDING_TXS` değerine eşit veya büyükse, THE AutoMintRunner SHALL yeni tx göndermeyip kapasiteyi beklesin — bu davranış bir unit test ile doğrulanmalıdır.
4. WHEN `AUTO_MINT_PIPELINE_MODE=true` ve unfinalized count `AUTO_MINT_MAX_UNFINALIZED_TXS` değerine eşit veya büyükse, THE AutoMintRunner SHALL yeni tx göndermeyip kapasiteyi beklesin — bu davranış bir unit test ile doğrulanmalıdır.
5. WHEN `AUTO_MINT_TX_SPACING_MS` süresi dolmadan yeni tx gönderilmeye çalışıldığında, THE AutoMintRunner SHALL tx göndermeyip spacing süresinin dolmasını beklesin — bu davranış bir unit test ile doğrulanmalıdır.
6. WHEN bir block `block_results` tablosunda `submitted` olarak işaretliyse, THE MintExecutor SHALL o block için yeni tx göndermeyip duplicate'i önlesin — bu davranış bir unit test ile doğrulanmalıdır.
7. WHEN bir tx `failed` durumuna geçtiğinde ve `AUTO_MINT_STOP_ON_PENDING_TX_FAILURE=true` ise, THE AutoMintRunner SHALL yeni tx gönderimini durdursun — bu davranış bir unit test ile doğrulanmalıdır.
8. WHEN `review_required` durumu tespit edildiğinde, THE AutoMintRunner SHALL yeni tx gönderimini durdursun — bu davranış bir unit test ile doğrulanmalıdır.
9. WHEN bir tx finalize edildiğinde, THE TxMonitor SHALL `last_successful_mint_block` checkpoint'ini güncellesin — bu davranış bir unit test ile doğrulanmalıdır.
10. WHEN pipeline modunda tx submit edildiğinde, THE AutoMintRunner SHALL scan checkpoint'ini (`last_scanned_block`) ilerletsin — bu davranış bir unit test ile doğrulanmalıdır.
11. WHEN `TxMonitor.poll()` bir tx'i `unknown` status ile karşılaştığında, THE AutoMintRunner SHALL scan checkpoint'ini ilerletmesin — bu davranış bir unit test ile doğrulanmalıdır.
12. WHEN `feeRequired=true` ve `AUTO_MINT_ONLY_NO_FEE_BLOCKS=true` ise, THE AutoMintRunner SHALL o block'u atlayıp session'ı durdurmayıp taramaya devam etsin — bu davranış bir unit test ile doğrulanmalıdır.
