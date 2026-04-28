const Database = require('better-sqlite3');
const db = new Database('./edmt-bot.sqlite');

console.log('=== HIGH BURN DRY-RUN RAPORU ===\n');

// 1. Toplam candidate
const total = db.prepare('SELECT COUNT(*) as cnt FROM high_burn_candidates').get();
console.log('Toplam candidate:', total.cnt);

// 2. Tier dagilimi
const tiers = db.prepare('SELECT tier_eth, COUNT(*) as cnt FROM high_burn_candidates GROUP BY tier_eth ORDER BY tier_eth DESC').all();
console.log('\nTier Dagilimi:');
for (const t of tiers) console.log('  >= ' + t.tier_eth + ' ETH: ' + t.cnt + ' candidate');

// 3. Status dagilimi
const statuses = db.prepare('SELECT status, COUNT(*) as cnt FROM high_burn_candidates GROUP BY status').all();
console.log('\nStatus Dagilimi:');
for (const s of statuses) console.log('  ' + s.status + ': ' + s.cnt);

// 4. Top 20 candidate
const top20 = db.prepare('SELECT block, burn_eth, tier_eth, status, edmt_status, minted_by, fee_required FROM high_burn_candidates ORDER BY burn_eth DESC LIMIT 20').all();
console.log('\nTop 20 Candidate (burn_eth DESC):');
console.log('Block'.padEnd(12) + 'burn_eth'.padEnd(16) + 'tier_eth'.padEnd(10) + 'status'.padEnd(14) + 'edmt_status'.padEnd(14) + 'minted_by'.padEnd(12) + 'fee_req');
console.log('-'.repeat(85));
for (const c of top20) {
  console.log(
    String(c.block).padEnd(12) +
    String(c.burn_eth.toFixed(4)).padEnd(16) +
    String(c.tier_eth).padEnd(10) +
    String(c.status || '').padEnd(14) +
    String(c.edmt_status || '-').padEnd(14) +
    String(c.minted_by || '-').padEnd(12) +
    String(c.fee_required !== null ? c.fee_required : '-')
  );
}

// 5. Sorting dogrulama
const sorted = db.prepare('SELECT burn_eth FROM high_burn_candidates ORDER BY burn_eth DESC LIMIT 5').all();
const isSorted = sorted.every((r, i) => i === 0 || r.burn_eth <= sorted[i-1].burn_eth);
console.log('\nburn_eth DESC sorting dogru mu? ' + (isSorted ? 'EVET' : 'HAYIR'));

// 6. Minted/submitted/finalized cache
const cached = db.prepare("SELECT COUNT(*) as cnt FROM high_burn_candidates WHERE status IN ('submitted','finalized','minted_elsewhere')").get();
console.log('Minted/submitted/finalized cache: ' + cached.cnt + ' kayit');

// 7. Unknown retry
const unknown = db.prepare("SELECT COUNT(*) as cnt FROM high_burn_candidates WHERE status = 'unknown'").get();
console.log('Unknown status: ' + unknown.cnt + ' kayit');

// 8. Tx gonderildi mi?
const txs = db.prepare('SELECT COUNT(*) as cnt FROM txs').get();
console.log('\nTx gonderildi mi? ' + txs.cnt + ' tx kaydi (0 olmali - DRY_RUN=true)');

// 9. Block results
const br = db.prepare('SELECT COUNT(*) as cnt FROM block_results').get();
console.log('Block results: ' + br.cnt + ' kayit');

db.close();
