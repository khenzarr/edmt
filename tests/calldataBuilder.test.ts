/**
 * CalldataBuilder unit tests.
 * Tests 1, 2, 3 from the spec test plan.
 */

import { describe, it, expect } from "vitest";
import { buildMintPayload, encodePayload, decodePayload } from "../src/calldataBuilder.js";

describe("CalldataBuilder", () => {
  // Test 1: no-fee payload exact match
  it("Test 1: buildMintPayload without fee produces exact protocol string", () => {
    const result = buildMintPayload(18765432);
    expect(result).toBe('data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"18765432"}');
  });

  it("buildMintPayload with undefined fee produces no fee field", () => {
    const result = buildMintPayload(12965000, undefined);
    expect(result).toBe('data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"12965000"}');
    expect(result).not.toContain('"fee"');
  });

  it("buildMintPayload with zero fee produces no fee field", () => {
    const result = buildMintPayload(18000000, 0n);
    expect(result).not.toContain('"fee"');
  });

  // Test 2: with-fee payload exact match
  it("Test 2: buildMintPayload with fee produces exact protocol string", () => {
    const feeGwei = 500000000n; // 0.5 gwei
    const result = buildMintPayload(18765432, feeGwei);
    expect(result).toBe(
      'data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"18765432","fee":"500000000"}'
    );
  });

  it("fee is written as decimal string, not scientific notation", () => {
    const feeGwei = 1_000_000_000_000n;
    const result = buildMintPayload(18000000, feeGwei);
    expect(result).toContain('"fee":"1000000000000"');
    expect(result).not.toContain("e+");
    expect(result).not.toContain("E+");
  });

  it("payload contains no extra whitespace", () => {
    const result = buildMintPayload(18765432, 100n);
    // No spaces, tabs, or newlines in the JSON portion
    const jsonPart = result.replace("data:,", "");
    expect(jsonPart).not.toMatch(/\s/);
  });

  // Test 3: hex round-trip
  it("Test 3: encodePayload → decodePayload round-trip preserves payload", () => {
    const payload = buildMintPayload(18765432);
    const encoded = encodePayload(payload);
    const decoded = decodePayload(encoded);
    expect(decoded).toBe(payload);
  });

  it("round-trip with fee preserves payload", () => {
    const payload = buildMintPayload(18765432, 999999999n);
    const encoded = encodePayload(payload);
    const decoded = decodePayload(encoded);
    expect(decoded).toBe(payload);
    // Decoded JSON must be parseable and match original fields
    const jsonStr = decoded.replace("data:,", "");
    const obj = JSON.parse(jsonStr) as Record<string, string>;
    expect(obj["p"]).toBe("edmt");
    expect(obj["op"]).toBe("emt-mint");
    expect(obj["tick"]).toBe("enat");
    expect(obj["blk"]).toBe("18765432");
    expect(obj["fee"]).toBe("999999999");
  });

  it("encodePayload returns 0x-prefixed hex string", () => {
    const payload = buildMintPayload(18765432);
    const encoded = encodePayload(payload);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("encodePayload hex decodes to correct UTF-8", () => {
    const payload = 'data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"1"}';
    const encoded = encodePayload(payload);
    const hex = encoded.slice(2);
    const decoded = Buffer.from(hex, "hex").toString("utf8");
    expect(decoded).toBe(payload);
  });

  it("large block number is encoded correctly", () => {
    const result = buildMintPayload(99999999);
    expect(result).toContain('"blk":"99999999"');
  });

  it("EIP-1559 activation block encodes correctly", () => {
    const result = buildMintPayload(12965000);
    expect(result).toBe('data:,{"p":"edmt","op":"emt-mint","tick":"enat","blk":"12965000"}');
  });
});
