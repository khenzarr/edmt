# EDMT/eNAT Mint a Block Bot

Ethereum mainnet üzerinde EDMT/eNAT protokolünün "Mint a Block" akışını otomatikleştiren, güvenli, testli ve resume edilebilir bot.

---

## ⚠️ Güvenlik Uyarıları

> **ANA CÜZDANINIZI KULLANMAYIN.**
> Bu bot için ayrı bir hot wallet oluşturun. Ana cüzdanınızı veya büyük bakiyeli bir cüzdanı asla kullanmayın.

- `PRIVATE_KEY` hiçbir zaman loglanmaz, DB'ye yazılmaz veya hata mesajlarında gösterilmez.
- Bot varsayılan olarak **dry-run** modunda çalışır — gerçek tx göndermez.
- Gerçek mint için **iki ayrı flag** gerekir: `DRY_RUN=false` VE `ENABLE_LIVE_MINT=true`.
- Capture fee **ETH veya ERC-20 değildir** — EDMT protokol katmanındaki raw fragment balance'tan ödenir.
- Overpayment **refund edilmez** — fee quote birebir kullanılır.
- EDMT block-specific API doğrulaması olmadan live mint yapılmaz.

---

## Proje Amacı

Bot şu akışı otomatikleştirir:

1. Hedef block'ların durumunu tarar (mintable / minted / beyond_current_head / not_eligible)
2. Mintable block bulunca calldata-only EIP-1559 transaction gönderir
3. Her adımı SQLite'a checkpoint olarak yazar
4. Kesintiden sonra kaldığı yerden devam eder — başa dönmez
5. TxMonitor ile finality takibi yapar ve EDMT indexer'da owner doğrular

---

## Kurulum

```bash
# 1. Bağımlılıkları yükle
npm install

# 2. .env dosyasını oluştur
cp .env.example .env

# 3. .env dosyasını düzenle (en az RPC_URL gerekli)
```

---

## .env Konfigürasyonu

```env
# Zorunlu
RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY

# Live mint için gerekli (dry-run'da boş bırakılabilir)
PRIVATE_KEY=0xYOUR_HOT_WALLET_PRIVATE_KEY

# Güvenlik bayrakları — ikisi de true olmalı live mint için
DRY_RUN=true           # varsayılan: true (güvenli)
ENABLE_LIVE_MINT=false # varsayılan: false (güvenli)

# Tarama aralığı
START_BLOCK=12965000   # EIP-1559 aktivasyon bloğu
STOP_BLOCK=            # boş = sınırsız

# Davranış
SCAN_DIRECTION=ascending
BEYOND_HEAD_BEHAVIOR=wait   # wait | skip | stop
ALLOW_MULTIPLE_PENDING_TX=false
FINALITY_CONFIRMATIONS=64

# Limitler
MAX_GAS_GWEI=80
MAX_PRIORITY_FEE_GWEI=3
MAX_CAPTURE_FEE_GWEI=1000000000
MAX_TX_PER_RUN=1
```

---

## Dry-Run Çalıştırma

Gerçek tx göndermeden block taraması yapar:

```bash
# Son 50 bloğu dry-run ile tara
npm run dry-run -- --from 12965000 --limit 50

# Checkpoint'ten devam et (dry-run modunda)
npm run scan -- --limit 100

# Belirli bir bloğu kontrol et
npm run mint -- --block 18765432
```

Dry-run modunda:
- `sendTransaction` **asla çağrılmaz**
- Payload, gas tahmini ve fee bilgisi loglanır
- Checkpoint güncellenir (tarama ilerler)
- DB'ye tx kaydı yazılmaz

---

## Live Mint'i Güvenli Şekilde Açma

Live mint'i açmadan önce şu kontrolleri yapın:

### 1. Dry-run ile test edin
```bash
npm run dry-run -- --from 18000000 --limit 10
```
Logları inceleyin — block durumları, fee bilgisi ve gas tahmini doğru görünüyor mu?

### 2. Wallet bakiyesini kontrol edin
- Wallet'ta gas için yeterli ETH olduğundan emin olun
- Capture fee gerektiren bloklar için fragment balance'ınızı kontrol edin

### 3. Gas limitlerini ayarlayın
```env
MAX_GAS_GWEI=80          # Ağ durumuna göre ayarlayın
MAX_PRIORITY_FEE_GWEI=3
```

### 4. Live mint'i açın
```env
DRY_RUN=false
ENABLE_LIVE_MINT=true
REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX=true  # İlk tx için onay ister
```

### 5. Resume ile başlatın
```bash
npm run resume
```

---

## CLI Komutları

| Komut | Açıklama |
|-------|----------|
| `npm run scan -- --limit <N>` | En fazla N block tara |
| `npm run mint -- --block <N>` | Belirli bir bloğu mint et |
| `npm run resume` | Checkpoint'ten devam et |
| `npm run status` | Checkpoint ve istatistikleri göster |
| `npm run pending` | Bekleyen tx'leri listele |
| `npm run dry-run -- --from <N> --limit <N>` | Dry-run tarama |
| `npm run monitor` | Pending tx'leri finality için izle |
| `npm run automint` | Gözetimsiz otomatik mint session başlat |
| `npm test` | Tüm testleri çalıştır |

---

## Unattended Auto Mint Recommended Profile

Bot'u gözetimsiz (unattended) modda çalıştırmak için önerilen production ayarları.

### Aktivasyon Koşulları

Aşağıdaki **üç flag'in tamamı** ayarlanmalıdır:

```env
UNATTENDED_AUTO_MINT=true
DRY_RUN=false
ENABLE_LIVE_MINT=true
```

### Önerilen Production Ayarları

```env
# Limit yok — bot no-fee block buldukça mint eder
AUTO_MINT_MAX_TX_PER_SESSION=999
AUTO_MINT_MAX_TX_PER_DAY=999

# 8 saatlik maksimum session süresi
AUTO_MINT_MAX_RUNTIME_MINUTES=480

# ~1 Ethereum block süresi
AUTO_MINT_POLL_INTERVAL_MS=12000

# Tam otomatik — CLI onayı bekleme
AUTO_MINT_CONFIRM_EACH_TX=false

# Wallet bakiye aralığı (0.01 ETH bakiye bu aralığa uygundur)
AUTO_MINT_MIN_WALLET_BALANCE_ETH=0.001
AUTO_MINT_REQUIRE_HOT_WALLET_BALANCE_MAX_ETH=0.02

# Yalnızca no-fee block'ları mint et
AUTO_MINT_ONLY_NO_FEE_BLOCKS=true

# Fee-required block görülürse atla, session durmasın
AUTO_MINT_STOP_ON_FEE_REQUIRED=false

# Hata görülürse atla, session durmasın
AUTO_MINT_STOP_ON_FIRST_ERROR=false

# Review required görülürse session dursun (güvenli)
AUTO_MINT_STOP_ON_REVIEW_REQUIRED=true

# Tx sonrası 1 dakika cooldown
AUTO_MINT_COOLDOWN_AFTER_TX_MS=60000

# Aynı anda tek pending tx
ALLOW_MULTIPLE_PENDING_TX=false
```

### Tüm AUTO_MINT_* Değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `UNATTENDED_AUTO_MINT` | `false` | Unattended modu aktif et |
| `AUTO_MINT_MAX_TX_PER_SESSION` | `1` | Session başına maksimum tx sayısı |
| `AUTO_MINT_MAX_TX_PER_DAY` | `3` | Günlük maksimum tx sayısı (son 24 saat) |
| `AUTO_MINT_MAX_RUNTIME_MINUTES` | `480` | Maksimum session süresi (dakika) |
| `AUTO_MINT_POLL_INTERVAL_MS` | `12000` | Block tarama aralığı (ms) |
| `AUTO_MINT_CONFIRM_EACH_TX` | `false` | Her tx için CLI onayı iste |
| `AUTO_MINT_MIN_WALLET_BALANCE_ETH` | `0.005` | Hot wallet minimum bakiye (ETH) |
| `AUTO_MINT_REQUIRE_HOT_WALLET_BALANCE_MAX_ETH` | `0.05` | Hot wallet maksimum bakiye (ETH) |
| `AUTO_MINT_STOP_ON_FIRST_ERROR` | `true` | İlk hata görüldüğünde session'ı durdur |
| `AUTO_MINT_STOP_ON_REVIEW_REQUIRED` | `true` | Review required durumunda session'ı durdur |
| `AUTO_MINT_STOP_ON_FEE_REQUIRED` | `true` | Fee gerektiren block görüldüğünde session'ı durdur |
| `AUTO_MINT_ONLY_NO_FEE_BLOCKS` | `true` | Yalnızca fee gerektirmeyen block'ları mint et |
| `AUTO_MINT_ALLOWED_START_BLOCK` | _(boş)_ | İzin verilen başlangıç block numarası |
| `AUTO_MINT_ALLOWED_STOP_BLOCK` | _(boş)_ | İzin verilen bitiş block numarası; aşılırsa session durur |
| `AUTO_MINT_COOLDOWN_AFTER_TX_MS` | `60000` | Tx sonrası bekleme süresi (ms) |
| `AUTO_MINT_EMERGENCY_STOP_FILE` | `./STOP_AUTOMINT` | Emergency stop dosyası yolu |
| `AUTO_MINT_SESSION_LOCK_FILE` | `./automint.lock` | Session lock dosyası yolu |

### Wallet Bakiye Güvenlik Aralığı

| Bakiye | Bot Davranışı |
|--------|--------------|
| < 0.001 ETH | `wallet_balance_low` — tx gönderilmez, döngü devam eder |
| 0.001–0.02 ETH | Normal çalışma (0.01 ETH bu aralığa uygundur) |
| > 0.02 ETH | `wallet_balance_high` — session durur |

### Emergency Stop

Çalışan session'ı durdurmak için:

```bash
touch STOP_AUTOMINT
```

Bot bir sonraki poll döngüsünde dosyayı tespit eder ve session'ı güvenli şekilde sonlandırır. Dosyayı manuel olarak silmeniz gerekir — bot silmez.

### Lock File

Bot çalışırken `./automint.lock` dosyası oluşturulur. Aynı anda ikinci bir instance başlatılamaz. Bot beklenmedik şekilde kapanırsa lock dosyası diskte kalabilir; bir sonraki başlatmada stale lock olarak otomatik temizlenir.

### Session Raporu

Session sonunda konsola JSON formatında rapor yazdırılır:

```json
{
  "sessionId": "uuid",
  "startedAt": "2026-04-27T22:00:00.000Z",
  "endedAt": "2026-04-28T06:00:00.000Z",
  "startBlock": 24973101,
  "endBlock": 24980000,
  "blocksScanned": 6899,
  "txSentThisSession": 3,
  "stopReason": "max_runtime_exceeded",
  "txHashes": ["0x..."],
  "errors": []
}
```

---

## Checkpoint Mantığı

Bot her kesin durum kararından sonra SQLite'a checkpoint yazar:

| Durum | Checkpoint Davranışı |
|-------|---------------------|
| `minted` | `last_scanned_block = block + 1` |
| `not_eligible` | `last_scanned_block = block + 1` |
| `successful_mint` | `last_scanned_block = block + 1` |
| `beyond_current_head` | Checkpoint ilerlemez (BEYOND_HEAD_BEHAVIOR'a göre) |
| `unknown` / hata | Checkpoint ilerlemez, errors tablosuna yazılır |

Checkpoint anahtarları:
- `last_scanned_block` — tarama pozisyonu
- `last_submitted_block` — son gönderilen tx'in bloğu
- `last_successful_mint_block` — finality onaylı son başarılı mint
- `last_finalized_tx` — son finalize tx hash

---

## EDMT API Keşif Notları

Bot şu stratejiyi uygular:

1. **EDMT API block-specific endpoint** (`/api/v1/blocks/:N`) — birincil kaynak
2. **RPC fallback** — block varlığı ve burn hesabı için (yalnızca yardımcı)
3. **`/api/v1/mints/recent`** — yalnızca yardımcı bilgi; tarihsel coverage garantisi yok

**Önemli:** EDMT block-specific API yanıt vermezse `status="unknown"` döner ve live mint **engellenir**. Sadece RPC burn hesabıyla live mint yapılmaz.

Bilinen belirsizlikler:
- `/api/v1/blocks/:N` endpoint'inin tam response şeması resmi olarak dokümante edilmemiştir
- Fee quote endpoint (`/api/v1/blocks/:N/fee`) mevcut olmayabilir — bu durumda fee `undefined` döner ve fee gerektiren bloklar için live mint engellenir
- API 404 döndürürse RPC fallback devreye girer ama live mint yine de engellenir

---

## Capture Fee Hakkında

- Capture fee **ETH değildir** — EDMT protokol katmanındaki raw fragment balance'tan ödenir
- ERC-20 allowance veya ETH transfer gerektirmez
- Overpayment **refund edilmez** — fee quote'u birebir kullanın
- `MAX_CAPTURE_FEE_GWEI` limitini aşan fee'ler için mint yapılmaz
- Fee quote alınamazsa live mint engellenir

---

## Hata Giderme

### "PRIVATE_KEY not set" hatası
`.env` dosyasında `PRIVATE_KEY` tanımlı değil. Live mint için gerekli.

### "EDMT block-specific status not confirmed"
EDMT API erişilemiyor. Bot güvenli modda çalışıyor — live mint engellendi. RPC bağlantısını ve EDMT API durumunu kontrol edin.

### "gas price exceeds limit"
Ağ gas fiyatı `MAX_GAS_GWEI` limitini aşıyor. `.env`'de limiti artırın veya ağın sakinleşmesini bekleyin.

### "fee exceeds max"
Capture fee `MAX_CAPTURE_FEE_GWEI` limitini aşıyor. Limiti artırın veya bu bloğu atlayın.

### Pending tx takılı kaldı
```bash
npm run pending   # Pending tx'leri listele
npm run monitor   # Finality kontrolü yap
```

### Checkpoint sıfırlamak
```bash
# SQLite DB'yi sil ve yeniden başlat
rm edmt-bot.sqlite
npm run resume
```

---

## Veritabanı

SQLite dosyası `SQLITE_PATH` (varsayılan: `./edmt-bot.sqlite`) konumunda oluşturulur.

Tablolar:
- `checkpoints` — tarama ve mint pozisyonları
- `block_results` — her bloğun durum geçmişi
- `txs` — gönderilen transaction'lar ve durumları
- `errors` — hata kayıtları

---

## Testler

```bash
npm test          # Tüm testleri çalıştır (54 test)
npm run test:watch # Watch modunda çalıştır
```

Test kapsamı:
- CalldataBuilder: payload format, hex encoding, round-trip
- BlockScanner: beyond_current_head, not_eligible, burn_lt_1
- Checkpoint: advance/hold logic
- FeeQuoter: fee max kontrolü
- MintExecutor: tüm güvenlik kapıları (dry-run, live mint disabled, duplicate, gas, fee, pending)
- TxMonitor: finality, owner doğrulama, checkpoint güncelleme

---

## Mimari Özeti

```
CLI → BlockScanner → EdmtClient (API + RPC fallback)
                  ↓
              MintExecutor (12 güvenlik kapısı)
                  ↓
              TxMonitor (finality + indexer doğrulama)
                  ↓
              Checkpoint (SQLite kalıcı durum)
```

---

## Lisans

MIT

---

## Pre-Live Checklist

Aşağıdaki adımların tamamı tamamlanmadan `DRY_RUN=false` ve `ENABLE_LIVE_MINT=true` ayarlamayın:

- [ ] **Hot wallet kullan** — Ana cüzdanını veya büyük bakiyeli bir cüzdanı kullanma. Yalnızca bu bot için oluşturulmuş ayrı bir hot wallet kullan.
- [ ] **Ana cüzdan kullanma** — Seed phrase'ini veya ana cüzdanının private key'ini asla bu bota verme.
- [ ] **Gerçek RPC URL kullan** — `.env`'de Alchemy, Infura, QuickNode veya kendi node'unun URL'ini kullan. Public RPC'ler rate-limit uygular ve botu bozar.
- [ ] **Testleri çalıştır ve geçtiğini doğrula:**
  ```bash
  npm test
  ```
- [ ] **Build'i çalıştır ve hata olmadığını doğrula:**
  ```bash
  npm run build
  ```
- [ ] **Dry-run ile gerçek RPC ve EDMT API'ye bağlan:**
  ```bash
  npm run dry-run -- --from <BAŞLANGIÇ_BLOĞU> --limit 20
  ```
- [ ] **Loglardan EDMT API block-specific status'un döndüğünü doğrula** — `"source":"edmt_api"` içeren `block_decision` log satırları görünüyor mu? Eğer yalnızca `"event":"api_unavailable"` veya `"event":"block_unknown"` görünüyorsa live mint açma.
- [ ] **Capture fee quote davranışını kontrol et** — Fee gerektiren bloklar için `requiredFeeGwei` değerinin logda göründüğünü doğrula. Fee quote endpoint yoksa fee-required bloklar atlanacak.
- [ ] **Gas limitlerini ağ durumuna göre ayarla** — `MAX_GAS_GWEI` ve `MAX_PRIORITY_FEE_GWEI` değerlerini güncel ağ koşullarına göre belirle.
- [ ] **Wallet bakiyesini kontrol et** — Gas için yeterli ETH olduğundan emin ol.
- [ ] **`DRY_RUN=false` ve `ENABLE_LIVE_MINT=true` yalnızca son aşamada aç** — Yukarıdaki tüm adımlar tamamlandıktan sonra.
- [ ] **`REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX=true` açık bırak** — İlk tx öncesi CLI'da `yes` yazarak onay ver.
- [ ] **Unattended mod için wallet bakiyesini kontrol et** — `AUTO_MINT_MIN_WALLET_BALANCE_ETH=0.001` ve `AUTO_MINT_REQUIRE_HOT_WALLET_BALANCE_MAX_ETH=0.02` aralığında olduğundan emin ol. 0.01 ETH bu aralığa uygundur.
- [ ] **Emergency stop mekanizmasını test et** — `touch STOP_AUTOMINT` ile session'ın durduğunu doğrula, ardından `rm STOP_AUTOMINT` ile temizle.

---

## Known Safe Failure Modes

Bot aşağıdaki durumlarda güvenli şekilde başarısız olur — hiçbirinde gerçek tx gönderilmez:

| Durum | Bot Davranışı |
|-------|--------------|
| **EDMT block-specific endpoint çalışmıyor** | `status="unknown"` döner, live mint yapılmaz, checkpoint ilerlemez, errors tablosuna yazılır |
| **Fee quote alınamıyor (fee-required block)** | `skipped_fee_quote_unavailable` — tx gönderilmez, block atlanır |
| **RPC rate-limit veya bağlantı hatası** | `RPC_RETRY_LIMIT` kadar retry yapılır (exponential backoff), sonra `status="unknown"`, checkpoint ilerlemez |
| **Gas fiyatı `MAX_GAS_GWEI` limitini aşıyor** | `skipped_gas_exceeds_max` — tx gönderilmez |
| **Pending tx mevcut (`ALLOW_MULTIPLE_PENDING_TX=false`)** | `skipped_pending_tx` — yeni tx gönderilmez, önce mevcut tx'in finalize olması beklenir |
| **Aynı block için daha önce tx gönderilmiş** | `skipped_duplicate_tx` — duplicate tx engellenir |
| **`requiredFeeGwei > MAX_CAPTURE_FEE_GWEI`** | `skipped_fee_exceeds_max` — overpayment koruması devreye girer |
| **`PRIVATE_KEY` tanımlı değil** | `skipped_no_private_key` — live mint başlamaz |
| **`DRY_RUN=true`** | `dry_run` — tüm akış simüle edilir, tx gönderilmez |
| **`ENABLE_LIVE_MINT=false`** | `skipped_live_mint_disabled` — tx gönderilmez |
| **EDMT API sadece RPC fallback döndürüyor** | `edmtStatusConfirmed=false` → `skipped_edmt_status_unconfirmed` — RPC-only kararla live mint yapılmaz |

---

## EDMT API Endpoint Doğrulama Notu

> ⚠️ **Live mint açmadan önce bu adımları tamamlayın.**

### `/api/v1/blocks/:N` (Block-Specific Status)

Bu endpoint'in response formatı EDMT tarafından resmi olarak dokümante edilmemiştir. Bot, bilinen status string'lerini (`mintable`, `minted`, `beyond_current_head`) normalize eder; tanımlanamayan status'lar `unknown` olarak işlenir ve live mint engellenir.

**Doğrulama adımı:**
```bash
npm run dry-run -- --from <GÜNCEL_BLOK - 10> --limit 5
```
Logda şunu arayın:
```json
{"event":"block_decision","source":"edmt_api","status":"mintable"}
```
Bu satır görünüyorsa endpoint çalışıyor demektir.

### `/api/v1/blocks/:N/fee` (Capture Fee Quote)

Bu endpoint'in varlığı belirsizdir. Mevcut değilse:
- Fee gerektirmeyen bloklar normal şekilde işlenir
- Fee gerektiren bloklar `skipped_fee_quote_unavailable` ile atlanır — güvenli davranış

**Doğrulama adımı:** Dry-run loglarında `"event":"api_unavailable"` ile `"url":"...fee"` içeren satır varsa endpoint mevcut değil demektir. Bu durumda fee-required bloklar mintlenemez.

> **Bu doğrulamalar tamamlanmadan live mint açılmamalıdır.**

---

## Pipeline Auto Mint Mode

Pipeline modu, finality beklenmeksizin birden fazla tx'i eş zamanlı olarak "uçuşta" tutarak throughput'u önemli ölçüde artırır.

**Mevcut sequential modda:** Her mint tx'i için ~14 dakika (64 confirmation) beklenir → 8 saatlik session'da ~36 tx.

**Pipeline modunda:** Finality beklenmez → eş zamanlı `MAX_UNFINALIZED_TXS` kadar tx uçuşta olabilir → teorik throughput `MAX_UNFINALIZED_TXS × (14 dk / tx)` oranında artar.

### Aktivasyon Koşulları

Aşağıdaki **dört koşulun tamamı** sağlanmalıdır:

```env
AUTO_MINT_PIPELINE_MODE=true
UNATTENDED_AUTO_MINT=true
DRY_RUN=false
ENABLE_LIVE_MINT=true
```

### Pipeline Mode Konfigürasyon Değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `AUTO_MINT_PIPELINE_MODE` | `false` | Pipeline modunu aktif et |
| `AUTO_MINT_MAX_PENDING_TXS` | `3` | Eş zamanlı maksimum pending tx (status='pending') |
| `AUTO_MINT_MAX_UNFINALIZED_TXS` | `10` | Eş zamanlı maksimum unfinalized tx (pending+included) |
| `AUTO_MINT_TX_SPACING_MS` | `30000` | İki ardışık tx arası minimum bekleme (ms) |
| `AUTO_MINT_STOP_ON_PENDING_TX_FAILURE` | `true` | Failed tx görülünce yeni tx göndermeyi durdur |
| `AUTO_MINT_RECONCILE_INTERVAL_MS` | `12000` | TxMonitor reconcile aralığı (ms) |
| `AUTO_MINT_REQUIRE_INCLUDED_BEFORE_NEXT_TX` | `false` | Sonraki tx'ten önce öncekinin included olmasını zorunlu kıl |

### Önerilen Production Profili (Pipeline)

```env
AUTO_MINT_PIPELINE_MODE=true
AUTO_MINT_MAX_PENDING_TXS=3
AUTO_MINT_MAX_UNFINALIZED_TXS=10
AUTO_MINT_TX_SPACING_MS=30000
AUTO_MINT_STOP_ON_PENDING_TX_FAILURE=true
AUTO_MINT_RECONCILE_INTERVAL_MS=12000
AUTO_MINT_REQUIRE_INCLUDED_BEFORE_NEXT_TX=false
```

### Pipeline Loop Mimarisi

Her loop iterasyonunda sırayla:

1. **Pre-checks** — emergency stop, session limitleri, wallet bakiyesi
2. **Monitor Phase** — `TxMonitor.poll()` çağrılır; pending/included tx'ler izlenir
3. **Stop condition check** — `review_required` veya `failed` tx varsa yeni tx gönderimi durur
4. **Capacity check** — `pendingCount < MAX_PENDING_TXS` ve `unfinalizedCount < MAX_UNFINALIZED_TXS` kontrolü
5. **Tx spacing check** — son tx'ten bu yana `TX_SPACING_MS` geçti mi?
6. **Nonce check** — `getPendingNonce()` ile nonce anomaly tespiti
7. **Scan/Send Phase** — mintable block bulunursa tx gönderilir, scan checkpoint ilerler
8. **Sleep** — `RECONCILE_INTERVAL_MS` kadar bekle

### Güvenlik Garantileri (Pipeline Modunda)

- Tüm mevcut güvenlik kapıları (Gate 1–12) geçerliliğini sürdürür
- `AUTO_MINT_PIPELINE_MODE=false` olduğunda eski davranış **aynen** korunur
- Nonce anomaly (dropped tx, gap) tespit edildiğinde yeni tx gönderimi durur
- Aynı block için duplicate tx gönderimi `block_results` tablosu ile önlenir
- `review_required` veya `failed` tx durumunda pipeline otomatik durur
- Emergency stop (`STOP_AUTOMINT` dosyası) yeni tx gönderimini durdurur; mevcut pending tx'ler izlenmeye devam eder

### Checkpoint Stratejisi (Pipeline)

| Checkpoint | Ne Zaman İlerler |
|---|---|
| `last_scanned_block` | Tx submit edildiğinde veya block atlandığında |
| `last_successful_mint_block` | Finality (64+ conf) + EDMT owner doğrulaması sonrası |

İki checkpoint birbirinden bağımsız ilerler — duplicate tx riski olmadan tarama sürekliliği sağlanır.

### Pipeline Mode Log Event'leri

| Event | Açıklama |
|---|---|
| `pipeline_mode_enabled` | Session başlangıcında pipeline modu aktif |
| `pipeline_monitor_poll` | Her iterasyonda TxMonitor.poll() çağrıldı |
| `pipeline_pending_capacity_available` | Kapasite müsait, tx gönderilebilir |
| `pipeline_pending_capacity_full` | Kapasite dolu, yeni tx gönderilmiyor |
| `pipeline_tx_spacing_wait` | Tx spacing süresi dolmadı, bekleniyor |
| `pipeline_tx_submitted` | Tx başarıyla gönderildi |
| `pipeline_finalized_reconciled` | Tx finalize edildi, checkpoint güncellendi |
| `pipeline_nonce_anomaly` | Nonce anomaly tespit edildi, pipeline durdu |
| `pipeline_duplicate_prevented` | Duplicate tx önlendi |


---

## High Burn Priority Mint Mode

High Burn Priority Mode (`HIGH_BURN_PRIORITY_MODE=true`) re-orders the minting queue by Ethereum burn value. Instead of scanning blocks sequentially, the bot indexes blocks by `burnEth = burnGwei / 1e9`, groups them into tier buckets, and selects candidates from the highest tier downward.

### Tier Bucket Semantics

`HIGH_BURN_MIN_ETH_TIERS` defines **minimum threshold bucket boundaries**, not exact targets:

| Tier | Bucket Range |
|---|---|
| 100 | burnEth >= 100 |
| 90 | 90 <= burnEth < 100 |
| 50 | 50 <= burnEth < 90 |
| 20 | 20 <= burnEth < 50 |
| 10 | 10 <= burnEth < 20 |
| 5 | 5 <= burnEth < 10 |
| 4 | 4 <= burnEth < 5 |
| 3 | 3 <= burnEth < 4 |
| 2 | 2 <= burnEth < 3 |
| 1 | 1 <= burnEth < 2 |
| 0.5 | 0.5 <= burnEth < 1 |
| 0.25 | 0.25 <= burnEth < 0.5 |
| 0.1 | 0.1 <= burnEth < 0.25 |

After exhausting the 100-tier, the bot scans ALL blocks with `90 <= burnEth < 100` (not just exactly 90 ETH blocks), sorted by `burnEth DESC`.

### Activation

```env
HIGH_BURN_PRIORITY_MODE=true
UNATTENDED_AUTO_MINT=true
DRY_RUN=false
ENABLE_LIVE_MINT=true
```

### Recommended Profile

```env
HIGH_BURN_PRIORITY_MODE=true
HIGH_BURN_ACTIVE_TIER_ETH=4
HIGH_BURN_MIN_ETH_TIERS=100,90,50,20,10,5,4,3,2,1,0.5,0.25,0.1
HIGH_BURN_ON_EXHAUSTED=fallback_sequential
HIGH_BURN_ONLY_NO_FEE=true
HIGH_BURN_USE_CACHE=true
HIGH_BURN_CACHE_TTL_HOURS=168
HIGH_BURN_UNKNOWN_RETRY_MINUTES=30
HIGH_BURN_PENDING_API_BASE_URL=https://api.edmt.io/api/v1
```

### Fast High-Burn Acquisition

Preferred path: import EDMT's pending/unminted queue into SQLite without historical
RPC calls. The endpoint is ordered by burn, so the importer stops once it falls
below `--min-eth`.

```bash
# Import currently unminted candidates with burn >= 1 ETH
npm run highburn:import-pending -- --min-eth 1 --page-size 100

# If you want to include smaller high-burn/dust candidates later
npm run highburn:import-pending -- --min-eth 0.05 --page-size 100 --reset-cursor

# Inspect the queue before minting
npm run highburn:queue -- --min-eth 1 --limit 50

# Mint from SQLite in burn-desc order; use dry-run first
npm run highburn:catchup -- --min-eth 1 --limit 100 --dry-run
npm run highburn:catchup -- --min-eth 1 --limit 100 --max-tx 3
```

Fallback path: if you still need a London-to-head historical RPC scan, use the
resumable scanner. It checkpoints `highburn_rpc_scan_next_block` and sleeps on
rate-limit errors.

```bash
npm run highburn:scan-resume -- --from 12965000 --min-eth 1 --chunk-size 1000 --concurrency 1
npm run highburn:scan-resume -- --min-eth 1 --max-blocks 50000
```

### All HIGH_BURN_* Config Variables

| Variable | Default | Description |
|---|---|---|
| `HIGH_BURN_PRIORITY_MODE` | `false` | Enable high burn priority mode |
| `HIGH_BURN_SCAN_START_BLOCK` | `12965000` | Indexing start block |
| `HIGH_BURN_SCAN_END_BLOCK` | _(empty)_ | Indexing end block (empty = chain head) |
| `HIGH_BURN_MIN_ETH_TIERS` | `100,90,...,0.1` | Tier bucket boundaries (comma-separated ETH) |
| `HIGH_BURN_ACTIVE_TIER_ETH` | `4` | Initial active tier on session start |
| `HIGH_BURN_BATCH_SIZE` | `1000` | Blocks per RPC indexing batch |
| `HIGH_BURN_MAX_CANDIDATES_PER_TIER` | `10000` | Max candidates stored per tier |
| `HIGH_BURN_RESCAN_MINTED` | `false` | Re-scan finalized/minted_elsewhere blocks |
| `HIGH_BURN_USE_CACHE` | `true` | Skip RPC if block already indexed within TTL |
| `HIGH_BURN_CACHE_TTL_HOURS` | `168` | Cache validity (hours) |
| `HIGH_BURN_SORT` | `desc` | Candidate sort order within tier |
| `HIGH_BURN_ONLY_MINTABLE` | `true` | Only select EDMT-confirmed mintable candidates |
| `HIGH_BURN_ONLY_NO_FEE` | `true` | Skip fee-required candidates |
| `HIGH_BURN_SKIP_ALREADY_SEEN` | `true` | Skip submitted/finalized/minted_elsewhere blocks |
| `HIGH_BURN_ON_EXHAUSTED` | `fallback_sequential` | Behavior when all tiers exhausted |
| `HIGH_BURN_UNKNOWN_RETRY_MINUTES` | `30` | Retry interval for unknown-status candidates |
| `HIGH_BURN_PENDING_API_BASE_URL` | `https://api.edmt.io/api/v1` | RPC-free pending candidate API base |
| `HIGH_BURN_RPC_SCAN_CHUNK_SIZE` | `1000` | Resumable RPC scanner chunk size |
| `HIGH_BURN_RPC_SCAN_CONCURRENCY` | `1` | Resumable RPC scanner concurrency |
| `HIGH_BURN_RPC_SCAN_REQUEST_DELAY_MS` | `250` | Delay before each RPC block fetch |
| `HIGH_BURN_RPC_SCAN_RATE_LIMIT_COOLDOWN_MS` | `300000` | Sleep after rate-limit errors |
| `HIGH_BURN_RPC_SCAN_MAX_RETRIES` | `8` | Retries per block before recording an error |

### CLI Commands

```bash
# Index blocks for high-burn candidates (no tx sent)
npm run highburn:scan -- --from 12965000 --to 20000000 --min-eth 4

# Import EDMT pending/unminted high-burn candidates without RPC scanning
npm run highburn:import-pending -- --min-eth 1 --page-size 100

# Resume a rate-limit-aware RPC scan
npm run highburn:scan-resume -- --from 12965000 --min-eth 1

# Show candidate stats by tier and status
npm run highburn:status

# Show top queued candidates
npm run highburn:queue -- --min-eth 1 --limit 50

# Start high burn mint session
npm run highburn:mint

# Reset a tier's candidates to discovered
npm run highburn:reset-cache -- --tier 4
```

### Pipeline Integration

High Burn Mode works with Pipeline Mode:

```env
HIGH_BURN_PRIORITY_MODE=true
AUTO_MINT_PIPELINE_MODE=true
```

When both are active: high-burn candidates are selected and submitted without waiting for finality. All pipeline guards (capacity, tx spacing, nonce reconcile, duplicate prevention) remain active.

### Exhaustion Behavior

When all tiers have no more mintable candidates:

- `fallback_sequential` — returns to normal `last_scanned_block` checkpoint scanning
- `wait` — sleeps and retries candidate selection
- `stop` — session ends with `high_burn_all_tiers_exhausted`
