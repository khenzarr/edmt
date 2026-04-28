/**
 * CalldataBuilder — constructs and encodes EDMT/eNAT mint calldata.
 *
 * Protocol format (no fee):
 *   data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"<N>"}
 *
 * Protocol format (with capture fee):
 *   data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"<N>","fee":"<FEE_GWEI>"}
 *
 * Rules:
 *   - No whitespace in JSON payload
 *   - fee field is ONLY added when feeGwei is defined and > 0n
 *   - fee is written as a decimal string (bigint.toString()) — no scientific notation
 *   - encodePayload returns 0x-prefixed hex of the UTF-8 payload string
 */

/**
 * Build the raw mint payload string.
 * @param block  Target Ethereum block number
 * @param feeGwei  Capture fee in gwei (bigint). Omit or pass undefined if no fee required.
 */
export function buildMintPayload(block: number, feeGwei?: bigint): string {
  // Base fields — key order is fixed per protocol spec
  const base: Record<string, string> = {
    p: "edmt",
    op: "emt-mint",
    tick: "enat",
    blk: String(block),
  };

  // Only add fee field when explicitly required and non-zero
  if (feeGwei !== undefined && feeGwei > 0n) {
    base["fee"] = feeGwei.toString();
  }

  // JSON.stringify with no replacer and no space → compact, no whitespace
  const json = JSON.stringify(base);
  return `data:,${json}`;
}

/**
 * Encode a payload string to 0x-prefixed hex (UTF-8 encoding).
 * @param payload  The raw payload string (e.g. result of buildMintPayload)
 */
export function encodePayload(payload: string): string {
  const bytes = Buffer.from(payload, "utf8");
  return "0x" + bytes.toString("hex");
}

/**
 * Decode a 0x-prefixed hex string back to the original UTF-8 string.
 * Used for round-trip verification in tests.
 */
export function decodePayload(hex: string): string {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(stripped, "hex").toString("utf8");
}
