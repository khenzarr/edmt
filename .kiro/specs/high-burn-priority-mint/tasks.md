# Implementation Plan: High Burn Priority Mint Mode

## Overview

Mevcut `AutoMintRunner` döngüsünü, burn değerine göre önceliklendirilmiş block seçimi yapabilen High Burn Priority Mode ile genişletir. Uygulama sırası: types → logger → config → db (schema + CRUD) → highBurnIndexer → highBurnSelector → autoMintRunner integration → CLI → .env.example → tests → README/RUNBOOK → final checkpoint.

## Design Corrections Applied

1. **Numeric sorting safety**: `burn_eth REAL` kolonu eklendi, `ORDER BY burn_eth DESC` kullanılır.
2. **Unknown retry backoff**: `HIGH_BURN_UNKNOWN_RETRY_MINUTES=30` config eklendi; `last_attempt_at + retry_interval` geçmeden unknown candidate tekrar seçilmez.

## Tasks

- [x] 1. types.ts — Yeni tipler ekle
  - `HighBurnCandidateStatus` union type ekle: `"discovered" | "mintable" | "submitted" | "finalized" | "minted_elsewhere" | "not_eligible" | "fee_required_skipped" | "unknown" | "review_required" | "skipped"`
  - `HighBurnCandidate` interface ekle: `block`, `burnGwei`, `burnEth`, `tierEth`, `status`, `edmt_status`, `minted_by`, `mint_tx_hash`, `fee_required`, `seen_at`, `updated_at`, `attempts`, `last_attempt_at`, `skip_reason`
  - `StopReason` union'ına `"high_burn_all_tiers_exhausted"` ekle
  - `src/types.ts` dosyasını düzenle

- [x] 2. logger.ts — Yeni HIGH_BURN_* LogEvent sabitleri ekle
  - `LogEvent` nesnesine şu sabitleri ekle: `HIGH_BURN_MODE_ENABLED`, `HIGH_BURN_CANDIDATE_DISCOVERED`, `HIGH_BURN_CANDIDATE_CACHED`, `HIGH_BURN_CANDIDATE_SELECTED`, `HIGH_BURN_CANDIDATE_MINTED_ELSEWHERE`, `HIGH_BURN_CANDIDATE_SUBMITTED`, `HIGH_BURN_CANDIDATE_FINALIZED`, `HIGH_BURN_TIER_STARTED`, `HIGH_BURN_TIER_EXHAUSTED`, `HIGH_BURN_TIER_DOWNGRADED`, `HIGH_BURN_ALL_TIERS_EXHAUSTED`, `HIGH_BURN_CACHE_HIT`, `HIGH_BURN_SKIP_SEEN`
  - `src/logger.ts` dosyasını düzenle

- [x] 3. config.ts — 18 yeni high burn config alanı ekle
  - `parseFloatArrayEnv()` helper ekle: `"100,90,50"` → `[100, 90, 50]` (descending sort)
  - `parseHighBurnOnExhausted()` validator ekle: `"wait" | "fallback_sequential" | "stop"`
  - Config alanları: `highBurnPriorityMode`, `highBurnScanStartBlock`, `highBurnScanEndBlock`, `highBurnMinEthTiers`, `highBurnActiveTierEth`, `highBurnBatchSize`, `highBurnMaxCandidatesPerTier`, `highBurnRescanMinted`, `highBurnUseCache`, `highBurnCacheTtlHours`, `highBurnSort`, `highBurnOnlyMintable`, `highBurnOnlyNoFee`, `highBurnSkipAlreadySeen`, `highBurnOnExhausted`, `highBurnUnknownRetryMinutes`
  - Varsayılan değerler: `false`, `12965000`, `undefined`, `[100,90,50,20,10,5,4,3,2,1,0.5,0.25,0.1]`, `4`, `1000`, `10000`, `false`, `true`, `168`, `"desc"`, `true`, `true`, `true`, `"fallback_sequential"`, `30`
  - `src/config.ts` dosyasını düzenle

- [x] 4. db.ts — high_burn_candidates tablosu ve CRUD fonksiyonları
  - `createTables()` içine `high_burn_candidates` tablosunu ekle:
    - `block INTEGER PRIMARY KEY`
    - `burn_gwei TEXT NOT NULL` (bigint string)
    - `burn_eth REAL NOT NULL` (numeric, sorting için)
    - `tier_eth REAL NOT NULL`
    - `status TEXT NOT NULL DEFAULT 'discovered'`
    - `edmt_status TEXT`
    - `minted_by TEXT`
    - `mint_tx_hash TEXT`
    - `fee_required INTEGER`
    - `seen_at TEXT NOT NULL`
    - `updated_at TEXT NOT NULL`
    - `attempts INTEGER NOT NULL DEFAULT 0`
    - `last_attempt_at TEXT`
    - `skip_reason TEXT`
  - Indexler: `idx_hbc_burn_eth ON high_burn_candidates(burn_eth DESC)`, `idx_hbc_tier_eth`, `idx_hbc_status`, `idx_hbc_updated_at`
  - Yeni fonksiyonlar:
    - `upsertHighBurnCandidate(params)`: INSERT OR IGNORE
    - `updateHighBurnCandidateStatus(block, status, extra?)`: status + updated_at güncelle
    - `queryNextHighBurnCandidate(tierEth, opts)`: candidate seç (SQL aşağıda)
    - `isHighBurnTierExhausted(tierEth)`: tüm candidateler terminal mi?
    - `getHighBurnStatusSummary()`: tier × status count tablosu
    - `resetHighBurnTier(tierEth)`: status → 'discovered'
    - `countHighBurnCandidatesByTier(tierEth)`: count
  - `queryNextHighBurnCandidate` SQL:
    ```sql
    SELECT * FROM high_burn_candidates hbc
    WHERE hbc.tier_eth = ?
      AND hbc.status NOT IN ('submitted','finalized','minted_elsewhere','skipped','not_eligible','fee_required_skipped')
      AND (hbc.status != 'unknown' OR hbc.last_attempt_at IS NULL
           OR (julianday('now') - julianday(hbc.last_attempt_at)) * 1440 >= ?)
      AND NOT EXISTS (SELECT 1 FROM txs t WHERE t.block = hbc.block AND t.status IN ('pending','included','finalized'))
      AND NOT EXISTS (SELECT 1 FROM block_results br WHERE br.block = hbc.block AND br.status IN ('submitted','included','finalized','successful_mint'))
      [AND hbc.fee_required = 0]
      [AND hbc.edmt_status = 'mintable']
    ORDER BY hbc.attempts ASC, hbc.burn_eth DESC
    LIMIT 1
    ```
  - `src/db.ts` dosyasını düzenle

- [x] 5. src/highBurnIndexer.ts — BurnIndexer (yeni dosya)
  - `assignTier(burnEth: number, tiers: number[]): number | null` — export et (test edilebilirlik için)
  - `indexBlockRange(from, to, minEth, opts): Promise<IndexSummary>` — batch indexleme
  - Cache hit: `HIGH_BURN_USE_CACHE=true` + `seen_at` TTL içinde → RPC çağrısı yapma, `HIGH_BURN_CACHE_HIT` logla
  - Skip-seen: `HIGH_BURN_SKIP_ALREADY_SEEN=true` + status terminal → `HIGH_BURN_SKIP_SEEN` logla
  - `HIGH_BURN_BATCH_SIZE` kadar block per iteration
  - `HIGH_BURN_MAX_CANDIDATES_PER_TIER` kapasitesi aşılırsa o tier için yeni candidate ekleme
  - Pre-EIP-1559 block (baseFeePerGas=null) → skip
  - `src/highBurnIndexer.ts` dosyasını oluştur

- [x] 6. src/highBurnSelector.ts — CandidateSelector + TierManager (yeni dosya)
  - `getNextHighBurnCandidate(tierEth, opts): HighBurnCandidateRow | null` — `queryNextHighBurnCandidate()` wrapper
  - `isTierExhausted(tierEth): boolean` — `isHighBurnTierExhausted()` wrapper
  - `getNextLowerTier(currentTier, allTiers): number | null`
  - `TierManager` class:
    - `activeTier: number`
    - `tryDowngrade(): boolean` — downgrade veya exhausted
    - `isAllExhausted(): boolean`
  - `src/highBurnSelector.ts` dosyasını oluştur

- [x] 7. autoMintRunner.ts — HighBurnRunner entegrasyonu
  - `HIGH_BURN_PRIORITY_MODE=true` iken pipeline loop içinde `decideBlock()` yerine `getNextHighBurnCandidate()` kullan
  - `HIGH_BURN_PRIORITY_MODE=false` iken mevcut davranış **aynen** korunur
  - Session başlangıcında `HIGH_BURN_MODE_ENABLED` logla
  - Candidate bulunamazsa `TierManager.tryDowngrade()` çağır
  - `HIGH_BURN_ON_EXHAUSTED` davranışını uygula:
    - `fallback_sequential`: `decideBlock(currentBlock)` ile devam et
    - `wait`: `sleep(autoMintPollIntervalMs)`, retry
    - `stop`: session `high_burn_all_tiers_exhausted` ile sonlandır
  - Tx submit sonrası: `updateHighBurnCandidateStatus(block, "submitted")`
  - TxMonitor finality sonrası: `updateHighBurnCandidateStatus(block, "finalized")`
  - Pipeline guardlar (capacity, spacing, nonce reconcile, duplicate) korunur
  - `src/autoMintRunner.ts` dosyasını düzenle

- [x] 8. src/cli.ts — CLI komutları ekle
  - `highburn:scan -- --from <BLOCK> --to <BLOCK> --min-eth <NUMBER>`: indexleme, tx yok
  - `highburn:status`: tier × status özet tablosu
  - `highburn:mint`: HighBurnRunner session başlat
  - `highburn:reset-cache -- --tier <ETH>`: tier reset
  - `package.json` scripts güncelle
  - `src/cli.ts` dosyasını düzenle

- [x] 9. .env.example — HIGH_BURN_* değişkenlerini ekle
  - Tüm 18 `HIGH_BURN_*` değişkenini Türkçe açıklamalarıyla ekle
  - `.env.example` dosyasını düzenle

- [x] 10. tests/highBurnIndexer.test.ts — BurnIndexer + assignTier testleri (yeni dosya)
  - Tier assignment testleri (6 case):
    - `assignTier(99.9, tiers)` → `90`
    - `assignTier(90.0, tiers)` → `90`
    - `assignTier(89.999, tiers)` → `50`
    - `assignTier(4.7, tiers)` → `4`
    - `assignTier(3.99, tiers)` → `3`
    - `assignTier(0.09, tiers)` → `null`
  - Burn calculation testleri:
    - `burnGwei` bigint hesaplama doğruluğu
    - `burnEth` float dönüşümü
  - Candidate insert testleri:
    - `burnEth >= tier` → DB'ye eklenir
    - `burnEth < lowest tier` → eklenmez
    - Cache hit → RPC çağrısı yapılmaz
    - Skip-seen → işlenmez

- [x] 11. tests/highBurnSelector.test.ts — CandidateSelector + TierManager testleri (yeni dosya)
  - Sorting testleri:
    - Aynı tier içinde `burn_eth DESC` sıralama
    - 100-tier candidate 4-tier'dan önce seçilir
  - Tier exhaustion testleri:
    - Tier exhausted → alt tier'a geçilir
    - Tüm tierlar exhausted → `isAllExhausted()` true
  - Status filter testleri:
    - `minted_elsewhere` candidate seçilmez
    - `submitted` candidate seçilmez
    - `finalized` candidate seçilmez
    - `fee_required=1` + `onlyNoFee=true` → seçilmez
  - Unknown retry backoff testleri:
    - `unknown` + `last_attempt_at` yeni → seçilmez
    - `unknown` + `last_attempt_at` eski (>30 dk) → seçilir
  - Duplicate prevention testleri:
    - `txs` tablosunda `pending` → seçilmez
    - `block_results` tablosunda `submitted` → seçilmez

- [x] 12. tests/autoMintRunner.highBurn.test.ts — HighBurnRunner entegrasyon testleri (yeni dosya)
  - `HIGH_BURN_ON_EXHAUSTED=fallback_sequential` → `decideBlock()` çağrılır
  - `HIGH_BURN_ON_EXHAUSTED=stop` → session `high_burn_all_tiers_exhausted` ile durur
  - Pipeline mode + high burn candidate → `execute()` `pipelineMode:true` ile çağrılır
  - Duplicate prevention high burn modda çalışır
  - `HIGH_BURN_PRIORITY_MODE=false` → mevcut davranış bozulmaz (regression)

- [x] 13. README.md + RUNBOOK.md güncelleme
  - README'ye "High Burn Priority Mode" bölümü ekle:
    - Tüm `HIGH_BURN_*` config değişkenleri, varsayılanlar, açıklamalar
    - Tier bucket semantics tablosu
    - Önerilen production profili
    - Pipeline ile birlikte kullanım
  - RUNBOOK'a operasyonel prosedürler ekle:
    - `highburn:scan` ile indexleme
    - `highburn:status` ile izleme
    - Tier exhaustion yönetimi
    - Cache reset prosedürü
    - Unknown retry backoff açıklaması

- [x] 14. Final checkpoint — npm test + build + lint + format:check
  - `npm test` çalıştır, tüm testlerin geçtiğini doğrula (önceki 113 + yeni 20+ test)
  - `npm run build` çalıştır, TypeScript derleme hatası olmadığını doğrula
  - `npm run lint` çalıştır, ESLint hatası olmadığını doğrula
  - `npm run format:check` çalıştır, Prettier uyumsuzluğu olmadığını doğrula

## Notes

- `burn_eth REAL` kolonu numeric sorting güvenliği için eklendi; `ORDER BY burn_eth DESC` kullanılır
- `HIGH_BURN_UNKNOWN_RETRY_MINUTES=30`: unknown candidate `last_attempt_at + 30 dk` geçmeden tekrar seçilmez
- `HIGH_BURN_PRIORITY_MODE=false` iken sıfır davranış değişikliği — tüm mevcut testler geçmeye devam eder
- `assignTier()` ve `getNextHighBurnCandidate()` test edilebilirlik için export edilmeli
- Pipeline mode (AUTO_MINT_PIPELINE_MODE) ve High Burn mode (HIGH_BURN_PRIORITY_MODE) bağımsız çalışır; ikisi birlikte aktif olabilir
