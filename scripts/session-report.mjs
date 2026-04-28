import Database from "better-sqlite3";

const db = new Database("./edmt-bot.sqlite");

console.log("=== Session Final Report ===\n");

// All txs
const txs = db.prepare("SELECT block, tx_hash, status, submitted_at, updated_at FROM txs ORDER BY id ASC").all();
console.log(`Total txs: ${txs.length}`);

const byStatus = {};
for (const tx of txs) {
  byStatus[tx.status] = (byStatus[tx.status] || 0) + 1;
}
console.log("By status:", JSON.stringify(byStatus));

// Included but not finalized
const included = txs.filter(t => t.status === "included");
console.log(`\nIncluded (not yet finalized): ${included.length}`);
for (const tx of included) {
  console.log(`  block=${tx.block} hash=${tx.tx_hash.slice(0,20)}... updated=${tx.updated_at}`);
}

// Finalized
const finalized = txs.filter(t => t.status === "finalized");
console.log(`\nFinalized: ${finalized.length}`);

// Pending
const pending = txs.filter(t => t.status === "pending");
console.log(`Pending: ${pending.length}`);

// Review required
const review = txs.filter(t => t.status === "review_required");
console.log(`Review required: ${review.length}`);

// Checkpoints
console.log("\n=== Checkpoints ===");
const cp = db.prepare("SELECT * FROM checkpoints").all();
for (const c of cp) console.log(`  ${c.key} = ${c.value}`);

// block_results summary
const brStats = db.prepare("SELECT status, COUNT(*) as cnt FROM block_results GROUP BY status").all();
console.log("\n=== Block Results ===");
for (const r of brStats) console.log(`  ${r.status}: ${r.cnt}`);

db.close();
