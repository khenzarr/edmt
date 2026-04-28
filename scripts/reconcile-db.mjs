import Database from "better-sqlite3";

const db = new Database("./edmt-bot.sqlite");
const now = new Date().toISOString();

const TX_HASH = "0xb35d99027973b9c253e0e86dd39b2723072de7f4a6024c78a4615ca508e6c1b2";
const BLOCK = 24973104;
const OWNER = "0x16fc54924b4dc280d14bcfd5a764234bac60336e";

// txs: included → finalized
db.prepare(
  "UPDATE txs SET status='finalized', updated_at=? WHERE block=? AND tx_hash=?"
).run(now, BLOCK, TX_HASH);

// block_results: included → successful_mint
db.prepare(
  "UPDATE block_results SET status='successful_mint', owner=?, mint_tx=?, updated_at=? WHERE block=?"
).run(OWNER, TX_HASH, now, BLOCK);

// checkpoints: last_successful_mint_block → 24973104
db.prepare(
  "INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_successful_mint_block',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
).run(String(BLOCK), now);

// checkpoints: last_finalized_tx
db.prepare(
  "INSERT INTO checkpoints (key, value, updated_at) VALUES ('last_finalized_tx',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
).run(TX_HASH, now);

console.log("DB reconcile complete");

const cp = db.prepare("SELECT * FROM checkpoints").all();
console.log("checkpoints:", JSON.stringify(cp, null, 2));

const tx = db.prepare("SELECT block, tx_hash, status FROM txs WHERE block=?").get(BLOCK);
console.log("txs[24973104]:", JSON.stringify(tx));

const br = db.prepare("SELECT block, status, owner FROM block_results WHERE block=?").get(BLOCK);
console.log("block_results[24973104]:", JSON.stringify(br));

db.close();
