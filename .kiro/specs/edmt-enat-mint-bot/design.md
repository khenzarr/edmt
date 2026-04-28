# EDMT/eNAT Mint a Block Bot — Technical Design Document

## Overview

Bu doküman, Ethereum mainnet üzerinde EDMT/eNAT protokolünün "Mint a Block" akışını otomatikleştiren botun production-grade teknik tasarımını tanımlar. Bot; block durumlarını tarar, mintable adayları tespit eder, calldata-only EIP-1559 transaction gönderir, her adımı SQLite'a checkpoint olarak yazar ve kesintisiz resume edebilir.

Tasarım 13 gereksinimi ve 4 ek güvenlik/operasyon iyileştirmesini kapsar:
- `FINALITY_CONFIRMATIONS=64` (config'e alınmış)
- `BEYOND_HEAD_BEHAVIOR=wait|skip|stop` (enum config)
- Live mint için block-specific EDMT status kesinliği zorunlu
- `ALLOW_MULTIPLE_PENDING_TX=false` varsayılan (pending tx varken yeni tx gönderilmez)


---

## 1. Architecture Overview

### 1.1 Genel Mimari

Bot, birbirinden bağımsız modüllerden oluşan katmanlı bir mimariye sahiptir. Her modül tek bir sorumluluğa odaklanır ve bağımlılıklar tek yönlüdür.

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLI (cli.ts)                           │
│          scan | mint | resume | status | pending | dry-run      │
└───────────────────────────┬─────────────────────────────────────┘
                            │
              ┌─────────────▼──────────────┐
              │     BlockScanner           │
              │  (blockScanner.ts)         │
              └──┬──────────┬──────────────┘
                 │          │
    ┌────────────▼──┐  ┌────▼────────────┐
    │  EdmtClient   │  │   EthClient     │
    │(edmtClient.ts)│  │ (ethClient.ts)  │
    └───────────────┘  └─────────────────┘
                 │
    ┌────────────▼──────────────────────┐
    │         MintExecutor              │
    │       (mintExecutor.ts)           │
    │                                   │
    │  ┌─────────────┐ ┌─────────────┐  │
    │  │ FeeQuoter   │ │Calldata     │  │
    │  │(feeQuoter)  │ │Builder      │  │
    │  └─────────────┘ └─────────────┘  │
    └────────────┬──────────────────────┘
                 │
    ┌────────────▼──────────────────────┐
    │         TxMonitor                 │
    │       (txMonitor.ts)              │
    └────────────┬──────────────────────┘
                 │
    ┌────────────▼──────────────────────┐
    │    Checkpoint Manager             │
    │      (checkpoint.ts)              │
    └────────────┬──────────────────────┘
                 │
    ┌────────────▼──────────────────────┐
    │         Database (db.ts)          │
    │         SQLite via better-sqlite3 │
    └───────────────────────────────────┘
```

### 1.2 Tarama → Karar → Mint → İzleme → Checkpoint Akışı

```
START
  │
  ▼
[Config & DB Init]
  │
  ▼
[Load Checkpoint] ──► last_scanned_block
  │
  ▼
┌─[BlockScanner.getNextCandidate()]──────────────────────────────┐
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ EdmtClient.getBlockStatus(N)                             │  │
│  │                                                          │  │
│  │  1. EDMT API block-specific endpoint                     │  │
│  │  2. RPC fallback (block existence + burn calc)           │  │
│  │  3. If both fail → status="unknown"                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  status?                                                        │
│  ├─ beyond_current_head → BEYOND_HEAD_BEHAVIOR (wait/skip/stop)│
│  ├─ not_eligible        → skip, checkpoint+1                   │
│  ├─ minted              → skip, checkpoint+1                   │
│  ├─ unknown             → log error, NO checkpoint advance     │
│  └─ mintable            → proceed to MintExecutor              │
└─────────────────────────────────────────────────────────────────┘
  │
  ▼ (mintable)
[MintExecutor.execute(block, status)]
  │
  ├─ DRY_RUN=true  → log payload, NO sendTransaction
  │
  └─ LIVE MINT GATES (all must pass):
       DRY_RUN=false
       ENABLE_LIVE_MINT=true
       PRIVATE_KEY present
       block-specific EDMT status confirmed
       fee quote obtained (if required)
       requiredFeeGwei <= MAX_CAPTURE_FEE_GWEI
       gas within limits
       no duplicate tx for this block
       ALLOW_MULTIPLE_PENDING_TX=false → no pending tx
       MAX_TX_PER_RUN not exceeded
       REQUIRE_MANUAL_CONFIRMATION_FOR_FIRST_TX → CLI confirm
       │
       ▼
  [sendTransaction] → txHash
       │
       ▼
  [DB: txs INSERT status=pending]
  [Checkpoint: last_submitted_block = N]
       │
       ▼
  [TxMonitor.poll()]
       │
       ├─ receipt.status=1 → included → EDMT indexer verify
       │    ├─ owner matches → finalized → successful_mint
       │    └─ owner mismatch → review_required
       │
       └─ receipt.status≠1 → failed → errors table
```

### 1.3 Dry-Run vs Live Mint Akış Farkları

| Adım | Dry-Run | Live Mint |
|------|---------|-----------|
| Block tarama | ✅ Tam | ✅ Tam |
| EDMT API sorgusu | ✅ Tam | ✅ Tam |
| Fee quote | ✅ Hesaplanır, loglanır | ✅ Hesaplanır, kullanılır |
| Gas tahmini | ✅ Hesaplanır, loglanır | ✅ Hesaplanır, kontrol edilir |
| Calldata oluşturma | ✅ Oluşturulur, loglanır | ✅ Oluşturulur, tx'e eklenir |
| sendTransaction | ❌ Çağrılmaz | ✅ Çağrılır |
| DB txs kaydı | ❌ Yazılmaz | ✅ Yazılır |
| Checkpoint güncelleme | ✅ Güncellenir | ✅ Güncellenir |
| TxMonitor | ❌ Çalışmaz | ✅ Çalışır |

