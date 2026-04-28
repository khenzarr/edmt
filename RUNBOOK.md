# EDMT/eNAT Mint Bot — Operational Runbook

## Mint Session Log

### Session 1 — 27 April 2026

| Field | Value |
|---|---|
| Minted block | `24973100` |
| Tx hash | `0xd794c52c12a0874c3ba58e3a755dc133aabe3e5dc3978f031505dee1cff3f047` |
| Included in block | `24973353` |
| Final confirmations | `74/64` |
| Owner verified | `true` |
| `last_successful_mint_block` | `24973100` |
| `last_scanned_block` | `24973101` |
| `txs.status` | `finalized` |
| Live mint errors | none |

---

## Safe Mode Defaults

These values must be set at all times except during an active mint window:

```
DRY_RUN=true
ENABLE_LIVE_MINT=false
PRIVATE_KEY=          ← always empty at rest
```

---

## Next Mint Procedure

Follow this exact sequence for every mint. Do not skip steps.

### Step 1 — Scan for mintable block (safe mode)

```bash
npm run dry-run -- --from <LAST_SCANNED_BLOCK> --limit 200
```

Confirm all of the following in the log before proceeding:

- `status=mintable`
- `edmtStatusConfirmed=true`
- `source=edmt_api`
- `minted_by=null`
- `feeRequired=false`  ← or fee quote verified
- `maxFeePerGas` < `MAX_GAS_GWEI` (80 gwei)
- `[DRY-RUN] Would mint block: <N>` — no tx sent

### Step 2 — Pre-flight API check

```bash
# Verify block is still unminted immediately before live mint
curl https://api.edmt.io/api/v1/blocks/<N>
# Confirm: minted_by=null, is_mintable=true, finalized=true
```

### Step 3 — Enable live mint (single tx window)

Edit `.env` locally:

```
PRIVATE_KEY=<HOT_WALLET_KEY>   ← dedicated hot wallet only, never main wallet
DRY_RUN=false
ENABLE_LIVE_MINT=true
```

### Step 4 — Final dry-run confirmation

```bash
npm run dry-run -- --from <N> --limit 1
```

All gates must still pass. If block is now `minted`, abort — do not proceed.

### Step 5 — Send mint tx

```bash
npm run mint -- --block <N>
# Type "yes" at the manual confirmation prompt
```

### Step 6 — Restore safe mode immediately after tx is sent

Edit `.env`:

```
PRIVATE_KEY=
DRY_RUN=true
ENABLE_LIVE_MINT=false
```

### Step 7 — Monitor finality

```bash
npm run monitor
# Repeat until 64 confirmations reached (~13 minutes)
```

Verify in EDMT indexer:

```bash
curl https://api.edmt.io/api/v1/blocks/<N>
# Confirm: minted_by=<HOT_WALLET_ADDRESS>, mint_tx_hash=<TX_HASH>, finalized=true
```

### Step 8 — Verify DB state

```bash
npm run status
```

Expected:
- `last_successful_mint_block` = `<N>`
- `last_scanned_block` = `<N+1>`
- `txs.status` = `finalized`

---

## Safety Gates (enforced by code — do not bypass)

| Gate | Condition |
|---|---|
| Gate 1 | `DRY_RUN=false` required |
| Gate 2 | `ENABLE_LIVE_MINT=true` required |
| Gate 3 | `PRIVATE_KEY` non-empty required |
| Gate 4 | `status=mintable` required |
| Gate 5 | `edmtStatusConfirmed=true` required |
| Gate 6 | Fee quote available if `feeRequired=true` |
| Gate 7 | `requiredFeeGwei` ≤ `MAX_CAPTURE_FEE_GWEI` |
| Gate 8 | `maxFeePerGas` ≤ `MAX_GAS_GWEI` |
| Gate 9 | No duplicate tx for block |
| Gate 10 | No pending tx (`ALLOW_MULTIPLE_PENDING_TX=false`) |
| Gate 11 | `MAX_TX_PER_RUN=1` not exceeded |
| Gate 12 | Manual `yes` confirmation (`REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX=true`) |

---

## Key Reminders

- **Never use your main wallet.** Use a dedicated hot wallet with minimal ETH.
- **Never log or print `PRIVATE_KEY`.** The code enforces this — do not add debug prints.
- **Never commit `.env` to version control.** It is in `.gitignore`.
- **Fee endpoint (`/api/v1/blocks/:N/fee`) currently returns 404.** Fee-required blocks cannot be minted until this endpoint is available. Only `feeRequired=false` blocks are safe to mint.
- **`edmtStatusConfirmed=false` blocks are never minted**, even if RPC shows burn data.

---

## Unattended Auto Mint Prosedürü

### Genel Bakış

`npm run automint` komutu, bot'u gözetimsiz (unattended) modda çalıştırır. Bot uyurken no-fee mintable block buldukça otomatik mint eder. Session sonunda JSON raporu konsola yazdırılır.

### Başlatma

**1. Wallet bakiyesini kontrol et**

```bash
# Bakiye 0.001–0.02 ETH aralığında olmalı
# 0.01 ETH bu aralığa uygundur
```

**2. `.env` ayarlarını yap**

```env
UNATTENDED_AUTO_MINT=true
DRY_RUN=false
ENABLE_LIVE_MINT=true
PRIVATE_KEY=<HOT_WALLET_KEY>

AUTO_MINT_MAX_TX_PER_SESSION=999
AUTO_MINT_MAX_TX_PER_DAY=999
AUTO_MINT_MAX_RUNTIME_MINUTES=480
AUTO_MINT_POLL_INTERVAL_MS=12000
AUTO_MINT_CONFIRM_EACH_TX=false
AUTO_MINT_MIN_WALLET_BALANCE_ETH=0.001
AUTO_MINT_REQUIRE_HOT_WALLET_BALANCE_MAX_ETH=0.02
AUTO_MINT_ONLY_NO_FEE_BLOCKS=true
AUTO_MINT_STOP_ON_FEE_REQUIRED=false
AUTO_MINT_STOP_ON_FIRST_ERROR=false
AUTO_MINT_STOP_ON_REVIEW_REQUIRED=true
AUTO_MINT_COOLDOWN_AFTER_TX_MS=60000
ALLOW_MULTIPLE_PENDING_TX=false
```

**3. Session'ı başlat**

```bash
npm run automint
```

### İzleme

Session çalışırken logları takip et:

```bash
# Ayrı bir terminal'de log dosyasını izle (eğer log dosyasına yazılıyorsa)
# veya stdout'u yönlendir:
npm run automint 2>&1 | tee automint.log
```

Önemli log event'leri:
- `BOT_START` — session başladı
- `MINT_GATE_FAILED` — block atlandı (fee, balance, pending tx)
- `BOT_STOP` — session sonlandı, stopReason içerir

### Durdurma

**Normal durdurma (emergency stop):**

```bash
touch STOP_AUTOMINT
```

Bot bir sonraki poll döngüsünde (max ~12 saniye) durur. Dosyayı manuel sil:

```bash
rm STOP_AUTOMINT
```

**Zorla durdurma:**

```bash
# SIGTERM gönder (graceful shutdown)
kill -TERM <PID>

# veya CTRL+C (SIGINT)
```

### Lock File Yönetimi

Bot çalışırken `./automint.lock` dosyası oluşturulur.

**Stale lock temizleme** (bot crash sonrası):

```bash
# Lock dosyasının içindeki PID'i kontrol et
cat automint.lock

# PID çalışmıyorsa güvenle sil
rm automint.lock
```

Bot bir sonraki başlatmada stale lock'u otomatik tespit eder ve temizler.

### Session Raporu Yorumlama

| `stopReason` | Açıklama |
|---|---|
| `completed` | Session normal tamamlandı |
| `max_runtime_exceeded` | 8 saatlik limit doldu |
| `session_tx_limit_reached` | Session tx limiti doldu |
| `daily_tx_limit_reached` | Günlük tx limiti doldu |
| `emergency_stop_file_detected` | `STOP_AUTOMINT` dosyası bulundu |
| `wallet_balance_low` | Bakiye < 0.001 ETH |
| `wallet_balance_high` | Bakiye > 0.02 ETH |
| `review_required_detected` | Tx review required durumuna geçti |
| `fee_required_block_detected` | Fee-required block + stopOnFeeRequired=true |
| `lock_file_exists` | Başka bir instance zaten çalışıyor |
| `first_error_stop` | stopOnFirstError=true + hata oluştu |

### Güvenli Mod'a Dönüş

Session sonlandıktan sonra:

```env
PRIVATE_KEY=
DRY_RUN=true
ENABLE_LIVE_MINT=false
UNATTENDED_AUTO_MINT=false
```

---

## Pipeline Auto Mint Mode Prosedürü

### Genel Bakış

Pipeline modu, finality beklenmeksizin birden fazla tx'i eş zamanlı olarak "uçuşta" tutarak throughput'u artırır. Sequential modda her tx için ~14 dakika finality beklenir; pipeline modunda bu bekleme kaldırılır.

> ⚠️ **Pipeline modu yalnızca deneyimli operatörler için önerilir. Önce sequential modda test edin.**

### Aktivasyon Koşulları

```env
AUTO_MINT_PIPELINE_MODE=true
UNATTENDED_AUTO_MINT=true
DRY_RUN=false
ENABLE_LIVE_MINT=true
```

### Pipeline Başlatma Prosedürü

**1. Sequential modda dry-run ile doğrula**

```bash
# Önce pipeline=false ile test et
AUTO_MINT_PIPELINE_MODE=false npm run automint
```

**2. Pipeline konfigürasyonunu ayarla**

```env
AUTO_MINT_PIPELINE_MODE=true
AUTO_MINT_MAX_PENDING_TXS=3
AUTO_MINT_MAX_UNFINALIZED_TXS=10
AUTO_MINT_TX_SPACING_MS=30000
AUTO_MINT_STOP_ON_PENDING_TX_FAILURE=true
AUTO_MINT_RECONCILE_INTERVAL_MS=12000
AUTO_MINT_REQUIRE_INCLUDED_BEFORE_NEXT_TX=false
```

**3. Pipeline session'ı başlat**

```bash
npm run automint
```

Session başlangıcında `pipeline_mode_enabled` log event'i görünmelidir.

### Pipeline İzleme

Önemli log event'leri:

| Event | Durum |
|---|---|
| `pipeline_mode_enabled` | Pipeline aktif, session başladı |
| `pipeline_monitor_poll` | Her iterasyonda TxMonitor çalışıyor |
| `pipeline_pending_capacity_available` | Kapasite müsait, tx gönderilebilir |
| `pipeline_pending_capacity_full` | Kapasite dolu, bekleniyor |
| `pipeline_tx_spacing_wait` | Tx spacing süresi dolmadı |
| `pipeline_tx_submitted` | Yeni tx gönderildi |
| `pipeline_finalized_reconciled` | Tx finalize edildi |
| `pipeline_nonce_anomaly` | ⚠️ Nonce anomaly — pipeline durdu |
| `pipeline_duplicate_prevented` | Duplicate tx önlendi |

### Pipeline Sorun Giderme

#### `pipeline_nonce_anomaly` görüldü

Nonce gap, dropped tx veya replacement tx tespit edildi. Pipeline yeni tx göndermeyi durdurur.

```bash
# Mevcut pending tx'leri kontrol et
npm run pending

# DB durumunu kontrol et
npm run status

# Gerekirse manuel reconcile
npm run monitor
```

Anomaly çözüldükten sonra session'ı yeniden başlat.

#### Kapasite sürekli dolu (`pipeline_pending_capacity_full`)

`AUTO_MINT_MAX_PENDING_TXS` veya `AUTO_MINT_MAX_UNFINALIZED_TXS` limitine ulaşıldı.

- `AUTO_MINT_MAX_PENDING_TXS` değerini artır (dikkatli ol)
- `AUTO_MINT_TX_SPACING_MS` değerini artır (daha yavaş gönderim)
- Ağ tıkanıklığı varsa bekle

#### Duplicate tx uyarısı (`pipeline_duplicate_prevented`)

Normal davranış — aynı block için ikinci tx gönderimi önlendi. Sorun değil.

#### `review_required_detected` ile pipeline durdu

Bir tx manuel inceleme gerektiriyor.

```bash
# Hangi tx review_required durumunda?
npm run pending

# DB'yi kontrol et
sqlite3 edmt-bot.sqlite "SELECT * FROM txs WHERE status='review_required';"
```

Manuel inceleme sonrası DB'yi güncelle ve session'ı yeniden başlat.

### Pipeline Durdurma

**Normal durdurma:**

```bash
touch STOP_AUTOMINT
```

Pipeline yeni tx göndermeyi durdurur; mevcut pending/included tx'ler izlenmeye devam eder. Tüm tx'ler finalize olunca session kapanır.

**Acil durdurma:**

```bash
kill -TERM <PID>
```

### Pipeline Session Raporu — Ek Stop Reason'lar

| `stopReason` | Açıklama |
|---|---|
| `pending_tx_failure_detected` | Tx failed + `STOP_ON_PENDING_TX_FAILURE=true` |
| `nonce_anomaly_detected` | Nonce gap/dropped tx tespit edildi |

### Pipeline Güvenli Mod'a Dönüş

```env
AUTO_MINT_PIPELINE_MODE=false
PRIVATE_KEY=
DRY_RUN=true
ENABLE_LIVE_MINT=false
UNATTENDED_AUTO_MINT=false
```


---

## High Burn Priority Mode Prosedürü

### Genel Bakış

High Burn Priority Mode, blockları burn değerine göre önceliklendirerek yüksek burn'lü blockları önce mintler. Önce `highburn:scan` ile candidate'lar indexlenir, sonra `highburn:mint` veya `automint` ile mintlenir.

### Adım 1 — Candidate Indexleme

```bash
# Tüm EIP-1559 bloklarını 4 ETH minimum ile indexle
npm run highburn:scan -- --from 12965000 --min-eth 4

# Belirli bir aralığı indexle
npm run highburn:scan -- --from 18000000 --to 20000000 --min-eth 4
```

Indexleme tamamlandıktan sonra durumu kontrol et:

```bash
npm run highburn:status
```

### Adım 2 — Konfigürasyon

```env
HIGH_BURN_PRIORITY_MODE=true
HIGH_BURN_ACTIVE_TIER_ETH=4
HIGH_BURN_ON_EXHAUSTED=fallback_sequential
HIGH_BURN_ONLY_NO_FEE=true
HIGH_BURN_USE_CACHE=true
HIGH_BURN_UNKNOWN_RETRY_MINUTES=30
UNATTENDED_AUTO_MINT=true
DRY_RUN=false
ENABLE_LIVE_MINT=true
```

### Adım 3 — Session Başlatma

```bash
npm run highburn:mint
# veya
npm run automint
```

Session başlangıcında `high_burn_mode_enabled` log event'i görünmeli.

### İzleme

| Log Event | Anlam |
|---|---|
| `high_burn_tier_started` | Yeni tier aktif |
| `high_burn_candidate_selected` | Candidate seçildi |
| `high_burn_candidate_submitted` | Tx gönderildi |
| `high_burn_candidate_finalized` | Tx finalize edildi |
| `high_burn_tier_exhausted` | Tier bitti, alt tier'a geçiliyor |
| `high_burn_tier_downgraded` | Tier downgrade |
| `high_burn_all_tiers_exhausted` | Tüm tierlar bitti |
| `high_burn_cache_hit` | Cache'ten okundu, RPC çağrısı yapılmadı |
| `high_burn_skip_seen` | Daha önce işlenmiş block atlandı |

### Tier Exhaustion Yönetimi

Bir tier exhausted olduğunda bot otomatik olarak alt tier'a geçer. Tüm tierlar bittiğinde `HIGH_BURN_ON_EXHAUSTED` davranışı uygulanır:

- `fallback_sequential`: Normal checkpoint scanner'a dön
- `wait`: Bekle ve tekrar dene
- `stop`: Session'ı durdur

### Cache Reset

Bir tier'ı sıfırlamak için:

```bash
npm run highburn:reset-cache -- --tier 4
```

Bu komut o tier'daki tüm candidate'ları `status=discovered` olarak sıfırlar.

### Unknown Retry Backoff

`unknown` status'taki candidate'lar `HIGH_BURN_UNKNOWN_RETRY_MINUTES` (varsayılan: 30 dakika) geçmeden tekrar seçilmez. Bu, aynı block üzerinde zaman kaybını önler.

### Güvenli Mod'a Dönüş

```env
HIGH_BURN_PRIORITY_MODE=false
PRIVATE_KEY=
DRY_RUN=true
ENABLE_LIVE_MINT=false
UNATTENDED_AUTO_MINT=false
```
