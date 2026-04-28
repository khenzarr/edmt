/**
 * EDMT/eNAT API client with safe fallback strategy.
 *
 * Resolution order for getBlockStatus(N):
 *   1. EDMT API block-specific endpoint  → authoritative
 *   2. RPC fallback (block existence + burn calc)  → partial info only
 *      - RPC fallback alone is NEVER sufficient for live mint
 *      - If only RPC data is available, status = "unknown" for live mint purposes
 *   3. Both fail → status = "unknown", error recorded, live mint blocked
 *
 * /api/v1/mints/recent is used only as supplementary info (recent mints cache).
 * It does NOT guarantee full historical coverage and is NOT used for mint decisions.
 *
 * All endpoint URLs are read from config — no hardcoded URLs in logic.
 */

import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { recordError } from "./db.js";
import { getCurrentBlockNumber, calculateBurnGwei, blockExists } from "./ethClient.js";
import type { BlockResult } from "./types.js";

// ---------------------------------------------------------------------------
// Endpoint configuration (all URLs from config)
// ---------------------------------------------------------------------------

interface EndpointConfig {
  /** GET /api/v1/blocks/:blockNumber — block-specific status */
  blockStatus: (blockNumber: number) => string;
  /** GET /api/v1/mints/recent — recent mints (supplementary only) */
  recentMints: string;
  /** GET /api/v1/blocks/:blockNumber/fee — capture fee quote */
  feeQuote: (blockNumber: number) => string;
}

function buildEndpoints(): EndpointConfig {
  const base = config.edmtApiBaseUrl;
  return {
    blockStatus: (n: number) => `${base}/blocks/${n}`,
    recentMints: `${base}/mints/recent`,
    feeQuote: (n: number) => `${base}/blocks/${n}/fee`,
  };
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry and backoff
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  retries: number = config.apiRetryLimit
): Promise<{ ok: boolean; status: number; data: unknown }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        const data: unknown = await res.json();
        return { ok: true, status: res.status, data };
      }

      // 404 is a definitive "not found" — no retry
      if (res.status === 404) {
        return { ok: false, status: 404, data: null };
      }

      // 5xx — retry
      lastError = new Error(`HTTP ${res.status} from ${url}`);
    } catch (err) {
      lastError = err;
    }

    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
    logger.warn(
      {
        event: LogEvent.API_RETRY,
        url,
        attempt,
        maxAttempts: retries,
        delayMs: delay,
        err: String(lastError),
      },
      `API call failed (attempt ${attempt}/${retries}), retrying in ${delay}ms`
    );

    if (attempt < retries) {
      await sleep(delay);
    }
  }

  return { ok: false, status: 0, data: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// EDMT API response types (best-effort — API shape may vary)
// ---------------------------------------------------------------------------

/**
 * New API shape: { data: { ... }, as_of_block: N }
 * Legacy shape (kept for forward-compat): flat object with status/burnGwei/etc.
 */
interface EdmtBlockApiResponseNew {
  // New wrapped shape
  data?: {
    blk?: number;
    burn?: string | number;
    is_mintable?: boolean;
    minted_by?: string | null;
    mint_tx_hash?: string | null;
    finalized?: boolean;
    mintedAtTs?: number;
    // fee fields (future)
    feeRequired?: boolean;
    fee_required?: boolean;
    requiredFeeGwei?: string | number;
    required_fee_gwei?: string | number;
  };
  as_of_block?: number;
  // Legacy flat shape fields (kept for forward-compat)
  block?: number;
  status?: string;
  owner?: string;
  mintTx?: string;
  mint_tx?: string;
  feeRequired?: boolean;
  fee_required?: boolean;
  requiredFeeGwei?: string | number;
  required_fee_gwei?: string | number;
  burnGwei?: string | number;
  burn_gwei?: string | number;
  reason?: string;
}

// Keep old name as alias for backward compat within this file
type EdmtBlockApiResponse = EdmtBlockApiResponseNew;

// ---------------------------------------------------------------------------
// Main public function
// ---------------------------------------------------------------------------

/**
 * Get the mint status of a specific Ethereum block.
 *
 * Safety contract:
 *   - edmtStatusConfirmed=true ONLY when EDMT API block-specific endpoint responded successfully
 *   - Live mint MUST NOT proceed unless edmtStatusConfirmed=true
 *   - RPC fallback sets edmtStatusConfirmed=false → live mint blocked
 */
export async function getBlockStatus(blockNumber: number): Promise<BlockResult> {
  const endpoints = buildEndpoints();

  // -------------------------------------------------------------------------
  // Step 1: Pre-flight eligibility checks (no API call needed)
  // -------------------------------------------------------------------------

  // EIP-1559 activation check
  if (blockNumber < 12965000) {
    return {
      block: blockNumber,
      status: "not_eligible",
      reason: "pre_eip1559",
      edmtStatusConfirmed: false,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Check if block is beyond current chain head (RPC)
  // -------------------------------------------------------------------------
  let currentHead: number;
  try {
    currentHead = await getCurrentBlockNumber();
  } catch {
    // RPC unavailable — cannot determine head
    const reason = "rpc_unavailable: cannot determine current block head";
    recordError({ block: blockNumber, stage: "edmtClient:getCurrentHead", message: reason });
    return {
      block: blockNumber,
      status: "unknown",
      reason,
      edmtStatusConfirmed: false,
    };
  }

  if (blockNumber > currentHead) {
    return {
      block: blockNumber,
      status: "beyond_current_head",
      reason: `block ${blockNumber} > current head ${currentHead}`,
      edmtStatusConfirmed: false,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: Try EDMT API block-specific endpoint (authoritative)
  // -------------------------------------------------------------------------
  const apiUrl = endpoints.blockStatus(blockNumber);
  logger.debug({ event: LogEvent.API_RETRY, url: apiUrl }, "Querying EDMT block-specific API");

  const apiResult = await fetchWithRetry(apiUrl);

  if (apiResult.ok && apiResult.data) {
    const parsed = parseEdmtBlockResponse(blockNumber, apiResult.data as EdmtBlockApiResponse);
    if (parsed) {
      logger.info(
        {
          event: LogEvent.BLOCK_DECISION,
          block: blockNumber,
          status: parsed.status,
          source: "edmt_api",
        },
        `Block ${blockNumber} status from EDMT API: ${parsed.status}`
      );
      return { ...parsed, edmtStatusConfirmed: true };
    }
  }

  // 404 from block-specific endpoint — block not indexed yet or endpoint not available
  if (apiResult.status === 404) {
    logger.warn(
      { event: LogEvent.API_UNAVAILABLE, block: blockNumber, url: apiUrl },
      "EDMT block-specific API returned 404 — falling back to RPC"
    );
  } else {
    logger.warn(
      {
        event: LogEvent.API_UNAVAILABLE,
        block: blockNumber,
        url: apiUrl,
        status: apiResult.status,
      },
      "EDMT block-specific API unavailable — falling back to RPC"
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: RPC fallback — block existence + burn calculation
  //         This provides partial info ONLY. edmtStatusConfirmed stays false.
  //         Live mint is BLOCKED when edmtStatusConfirmed=false.
  // -------------------------------------------------------------------------
  logger.info(
    { event: LogEvent.API_FALLBACK, block: blockNumber },
    "Using RPC fallback for block status (live mint will be blocked)"
  );

  let burnGwei: bigint | undefined;
  try {
    const exists = await blockExists(blockNumber);
    if (!exists) {
      return {
        block: blockNumber,
        status: "beyond_current_head",
        reason: "block not found on RPC despite being <= current head",
        edmtStatusConfirmed: false,
      };
    }

    burnGwei = await calculateBurnGwei(blockNumber);
  } catch (err) {
    const message = `RPC fallback failed for block ${blockNumber}: ${String(err)}`;
    recordError({ block: blockNumber, stage: "edmtClient:rpcFallback", message });
    logger.error({ event: LogEvent.RPC_ERROR, block: blockNumber, err: String(err) }, message);
    return {
      block: blockNumber,
      status: "unknown",
      reason: message,
      edmtStatusConfirmed: false,
    };
  }

  // Pre-EIP-1559 block (no baseFeePerGas)
  if (burnGwei === undefined) {
    return {
      block: blockNumber,
      status: "not_eligible",
      reason: "pre_eip1559 (no baseFeePerGas on RPC)",
      burnGwei: undefined,
      edmtStatusConfirmed: false,
    };
  }

  // Burn too low
  if (burnGwei < config.minBurnGwei) {
    return {
      block: blockNumber,
      status: "not_eligible",
      reason: "burn_lt_1",
      burnGwei,
      edmtStatusConfirmed: false,
    };
  }

  // RPC says block exists and burn is sufficient, but we cannot confirm
  // minted/mintable status without EDMT API → return unknown to block live mint
  const reason =
    "EDMT block-specific API unavailable; RPC fallback cannot confirm minted/mintable status. Live mint blocked.";
  recordError({ block: blockNumber, stage: "edmtClient:fallbackUnknown", message: reason });

  logger.warn(
    { event: LogEvent.BLOCK_UNKNOWN, block: blockNumber, burnGwei: burnGwei.toString() },
    reason
  );

  return {
    block: blockNumber,
    status: "unknown",
    burnGwei,
    reason,
    edmtStatusConfirmed: false,
  };
}

// ---------------------------------------------------------------------------
// Fee quote endpoint
// ---------------------------------------------------------------------------

/**
 * Query EDMT API for capture fee quote for a specific block.
 * Returns undefined if no fee is required or if the endpoint is unavailable.
 * Returns the fee in gwei as bigint if required.
 *
 * Safety: if the endpoint returns an error or unexpected shape,
 * returns undefined (caller must treat as "fee unknown" and block live mint).
 */
export async function getFeeQuote(
  blockNumber: number
): Promise<{ feeRequired: boolean; requiredFeeGwei?: bigint } | undefined> {
  const endpoints = buildEndpoints();
  const url = endpoints.feeQuote(blockNumber);

  const result = await fetchWithRetry(url);

  if (!result.ok) {
    // Endpoint unavailable — cannot determine fee
    logger.warn(
      { event: LogEvent.API_UNAVAILABLE, block: blockNumber, url },
      "EDMT fee quote endpoint unavailable"
    );
    return undefined;
  }

  const data = result.data as Record<string, unknown>;

  const feeRequired =
    (data["feeRequired"] as boolean | undefined) ??
    (data["fee_required"] as boolean | undefined) ??
    false;

  if (!feeRequired) {
    return { feeRequired: false };
  }

  const rawFee =
    (data["requiredFeeGwei"] as string | number | undefined) ??
    (data["required_fee_gwei"] as string | number | undefined);

  if (rawFee === undefined || rawFee === null) {
    logger.warn(
      { event: LogEvent.API_UNAVAILABLE, block: blockNumber },
      "EDMT fee quote: feeRequired=true but no fee value returned"
    );
    return undefined;
  }

  try {
    const requiredFeeGwei = BigInt(String(rawFee));
    return { feeRequired: true, requiredFeeGwei };
  } catch {
    logger.warn(
      { event: LogEvent.API_UNAVAILABLE, block: blockNumber, rawFee },
      "EDMT fee quote: could not parse fee value as bigint"
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Parse EDMT API block response
// ---------------------------------------------------------------------------

function parseEdmtBlockResponse(
  blockNumber: number,
  data: EdmtBlockApiResponse
): BlockResult | null {
  if (!data || typeof data !== "object") return null;

  // -------------------------------------------------------------------------
  // Unwrap: support both new { data: {...} } wrapper and legacy flat shape
  // -------------------------------------------------------------------------
  const hasNewShape = "data" in data && data.data !== null && typeof data.data === "object";

  if (hasNewShape) {
    // -----------------------------------------------------------------------
    // New API shape: { data: { blk, burn, is_mintable, minted_by, ... } }
    // -----------------------------------------------------------------------
    const raw = data.data!;

    // Burn
    const burnRaw = raw.burn;
    let burnGwei: bigint | undefined;
    if (burnRaw !== undefined && burnRaw !== null) {
      try {
        burnGwei = BigInt(String(burnRaw));
      } catch {
        burnGwei = undefined;
      }
    }

    // Fee fields (future-proofing — fee endpoint currently 404)
    const feeRequired = raw.feeRequired ?? raw.fee_required ?? false;
    const rawFee = raw.requiredFeeGwei ?? raw.required_fee_gwei;
    let requiredFeeGwei: bigint | undefined;
    if (rawFee !== undefined && rawFee !== null) {
      try {
        requiredFeeGwei = BigInt(String(rawFee));
      } catch {
        requiredFeeGwei = undefined;
      }
    }

    // Owner / mintTx
    const owner = raw.minted_by ?? undefined;
    const mintTx = raw.mint_tx_hash ?? undefined;

    // Status derivation from is_mintable + minted_by
    let status: BlockResult["status"];
    let reason: string | undefined;

    if (owner && owner.length > 0) {
      // minted_by is populated → already minted
      status = "minted";
    } else if (raw.is_mintable === true) {
      status = "mintable";
    } else if (raw.is_mintable === false) {
      status = "not_eligible";
      reason = "api_not_mintable";
    } else {
      // is_mintable field missing — unrecognised shape
      logger.warn(
        { event: LogEvent.BLOCK_UNKNOWN, block: blockNumber },
        `New API shape: is_mintable field missing — treating as unknown`
      );
      return null;
    }

    return {
      block: blockNumber,
      status,
      burnGwei,
      owner: owner && owner.length > 0 ? owner : undefined,
      mintTx: mintTx && mintTx.length > 0 ? mintTx : undefined,
      feeRequired,
      requiredFeeGwei,
      reason,
      edmtStatusConfirmed: true,
    };
  }

  // -------------------------------------------------------------------------
  // Legacy flat shape: { status, burnGwei, owner, ... }
  // -------------------------------------------------------------------------
  const rawStatus = (data.status ?? "").toLowerCase();

  let status: BlockResult["status"];

  if (rawStatus === "mintable" || rawStatus === "this block is currently mintable") {
    status = "mintable";
  } else if (rawStatus === "minted" || rawStatus === "this block has been minted") {
    status = "minted";
  } else if (
    rawStatus === "beyond_current_head" ||
    rawStatus === "beyond current head" ||
    rawStatus === "this block does not exist on the current api chain yet"
  ) {
    status = "beyond_current_head";
  } else if (rawStatus === "not_eligible") {
    status = "not_eligible";
  } else if (rawStatus === "") {
    // Empty status — treat as unknown
    return null;
  } else {
    // Unrecognised status — treat as unknown to be safe
    logger.warn(
      { event: LogEvent.BLOCK_UNKNOWN, block: blockNumber, rawStatus },
      `Unrecognised EDMT API status: "${rawStatus}" — treating as unknown`
    );
    return null;
  }

  const burnRaw = data.burnGwei ?? data.burn_gwei;
  const burnGwei = burnRaw !== undefined ? BigInt(String(burnRaw)) : undefined;

  const feeRequired = data.feeRequired ?? data.fee_required ?? false;

  const rawFee = data.requiredFeeGwei ?? data.required_fee_gwei;
  const requiredFeeGwei = rawFee !== undefined ? BigInt(String(rawFee)) : undefined;

  return {
    block: blockNumber,
    status,
    burnGwei,
    owner: data.owner,
    mintTx: data.mintTx ?? data.mint_tx,
    feeRequired,
    requiredFeeGwei,
    reason: data.reason,
    edmtStatusConfirmed: true,
  };
}
