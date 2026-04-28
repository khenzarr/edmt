/**
 * High Burn Batch Report — detailed status after each scan batch
 */
const Database = require('better-sqlite3');
const db = new Database('./edmt-bot.sqlite');

const args = process.argv.slice(2);
const label = args[0] || 'Current';

console.log(`\n=== HIGH BURN BATCH REPORT: ${label} ===`);

// Total candidates
const total = db.prepare('SELECT COUNT(*) as cnt FROM high_burn_candidates').get();
console.log(`\nTotal candidates: ${total.cnt}`);

// Tier distribution
const tiers = db.prepare(`
  SELECT tier_eth, COUNT(*) as cnt
  FROM high_burn_candidates
  GROUP BY tier_eth
  ORDER BY tier_eth DESC
`).all();

console.log('\nTier Distribution:');
const tierLabels = {
  100: '>= 100 ETH',
  90:  '90-100 ETH',
  50:  '50-90 ETH',
  20:  '20-50 ETH',
  10:  '10-20 ETH',
  5:   '5-10 ETH',
  4:   '4-5 ETH',
  3:   '3-4 ETH',
  2:   '2-3 ETH',
  1:   '1-2 ETH',
};
for (const t of tiers) {
  const label = tierLabels[t.tier_eth] || `>= ${t.tier_eth} ETH`;
  console.log(`  ${label.padEnd(14)}: ${t.cnt}`);
}

// Status distribution
const statuses = db.prepare(`
  SELECT status, COUNT(*) as cnt
  FROM high_burn_candidates
  GROUP BY status
  ORDER BY cnt DESC
`).all();

console.log('\nStatus Distribution:');
for (const s of statuses) {
  console.log(`  ${s.status.padEnd(22)}: ${s.cnt}`);
}

// Top 20 candidates by burn_eth DESC
const top20 = db.prepare(`
  SELECT block, burn_eth, tier_eth, status, edmt_status, minted_by, fee_required
  FROM high_burn_candidates
  ORDER BY burn_eth DESC
  LIMIT 20
`).all();

console.log('\nTop 20 Candidates (burn_eth DESC):');
console.log(
  'Block'.padEnd(12) +
  'burn_eth'.padEnd(14) +
  'tier_eth'.padEnd(10) +
  'status'.padEnd(20) +
  'edmt_status'.padEnd(14) +
  'fee_req'
);
console.log('-'.repeat(80));
for (const c of top20) {
  console.log(
    String(c.block).padEnd(12) +
    String(c.burn_eth.toFixed(4)).padEnd(14) +
    String(c.tier_eth).padEnd(10) +
    String(c.status || '').padEnd(20) +
    String(c.edmt_status || '-').padEnd(14) +
    String(c.fee_required !== null ? c.fee_required : '-')
  );
}

// Sorting check
const sorted = db.prepare('SELECT burn_eth FROM high_burn_candidates ORDER BY burn_eth DESC LIMIT 5').all();
const isSorted = sorted.every((r, i) => i === 0 || r.burn_eth <= sorted[i-1].burn_eth);
console.log(`\nburn_eth DESC sorting correct: ${isSorted ? 'YES' : 'NO'}`);

// Mintable candidates
const mintable = db.prepare(`
  SELECT COUNT(*) as cnt FROM high_burn_candidates
  WHERE status NOT IN ('minted_elsewhere','not_eligible','fee_required_skipped','submitted','finalized')
  AND (edmt_status IS NULL OR edmt_status = 'mintable')
  AND (fee_required IS NULL OR fee_required = 0)
`).get();
console.log(`Potentially mintable (no-fee): ${mintable.cnt}`);

// Tx check
const txs = db.prepare('SELECT COUNT(*) as cnt FROM txs').get();
const recentTx = db.prepare('SELECT submitted_at FROM txs ORDER BY submitted_at DESC LIMIT 1').get();
console.log(`\nTotal txs in DB: ${txs.cnt}`);
console.log(`Most recent tx: ${recentTx ? recentTx.submitted_at : 'none'}`);

db.close();
