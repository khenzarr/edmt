const Database = require('better-sqlite3');
const db = new Database('./edmt-bot.sqlite');

const totalTxs = db.prepare('SELECT COUNT(*) as cnt FROM txs').get();
const sessionTxs = db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE submitted_at > datetime('now', '-30 minutes')").get();
const finalized = db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'finalized'").get();
const included = db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'included'").get();
const pending = db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'pending'").get();
const failed = db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'failed'").get();
const reviewReq = db.prepare("SELECT COUNT(*) as cnt FROM txs WHERE status = 'review_required'").get();

const cp = db.prepare("SELECT key, value FROM checkpoints WHERE key IN ('last_scanned_block','last_submitted_block','last_successful_mint_block')").all();

const recentTxs = db.prepare('SELECT block, tx_hash, status, submitted_at FROM txs ORDER BY submitted_at DESC LIMIT 15').all();

// Block results stats
const brStats = db.prepare("SELECT status, COUNT(*) as cnt FROM block_results GROUP BY status ORDER BY cnt DESC").all();
const feeSkipped = db.prepare("SELECT COUNT(*) as cnt FROM block_results WHERE status = 'not_eligible' AND reason LIKE '%fee%'").get();
const mintedSkipped = db.prepare("SELECT COUNT(*) as cnt FROM block_results WHERE status = 'minted'").get();
const unknownCount = db.prepare("SELECT COUNT(*) as cnt FROM block_results WHERE status = 'unknown'").get();

console.log('\n=== 30-MINUTE FAST PIPELINE REPORT ===\n');
console.log('TX SUMMARY:');
console.log('  Total txs in DB:          ', totalTxs.cnt);
console.log('  Session txs (last 30 min):', sessionTxs.cnt);
console.log('  Finalized:                ', finalized.cnt);
console.log('  Included (pending finality):', included.cnt);
console.log('  Pending:                  ', pending.cnt);
console.log('  Failed:                   ', failed.cnt);
console.log('  Review required:          ', reviewReq.cnt);

console.log('\nCHECKPOINTS:');
for (const c of cp) console.log(' ', c.key + ':', c.value);

console.log('\nBLOCK RESULTS:');
for (const b of brStats) console.log(' ', b.status.padEnd(20), b.cnt);
console.log('  fee_required skipped:     ', feeSkipped.cnt);
console.log('  minted (skipped):         ', mintedSkipped.cnt);
console.log('  unknown:                  ', unknownCount.cnt);

console.log('\nRECENT 15 TXS (newest first):');
console.log('Block'.padEnd(12) + 'Status'.padEnd(12) + 'Time (UTC)');
console.log('-'.repeat(40));
for (const t of recentTxs) {
  console.log(String(t.block).padEnd(12) + t.status.padEnd(12) + t.submitted_at.slice(11, 19));
}

db.close();
