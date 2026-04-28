/**
 * Ethereum RPC client wrapper.
 * Uses ethers v6 JsonRpcProvider.
 * All RPC calls are retried up to RPC_RETRY_LIMIT times with exponential backoff.
 * PRIVATE_KEY is used to create the Wallet but is NEVER logged or included in errors.
 */

import { ethers } from "ethers";
import { config, hasPrivateKey } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { recordError } from "./db.js";

// ---------------------------------------------------------------------------
// Provider / Wallet singletons
// ---------------------------------------------------------------------------

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet: ethers.Wallet | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(config.rpcUrl);
  }
  return _provider;
}

export function getWallet(): ethers.Wallet {
  if (!_wallet) {
    if (!hasPrivateKey()) {
      throw new Error("PRIVATE_KEY is not set. Cannot create wallet for live minting.");
    }
    // Key is used here but NEVER stored in logs or error messages
    _wallet = new ethers.Wallet(config.privateKey, getProvider());
  }
  return _wallet;
}

// ---------------------------------------------------------------------------
// Retry helper with exponential backoff
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries: number = config.rpcRetryLimit
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
      logger.warn(
        {
          event: LogEvent.RPC_RETRY,
          label,
          attempt,
          maxAttempts: retries,
          delayMs: delay,
          err: String(err),
        },
        `RPC call "${label}" failed (attempt ${attempt}/${retries}), retrying in ${delay}ms`
      );
      if (attempt < retries) {
        await sleep(delay);
      }
    }
  }
  const message = `RPC call "${label}" failed after ${retries} attempts`;
  logger.error({ event: LogEvent.RPC_ERROR, label, err: String(lastError) }, message);
  recordError({ stage: `rpc:${label}`, message, stack: String(lastError) });
  throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public RPC wrappers
// ---------------------------------------------------------------------------

export async function getCurrentBlockNumber(): Promise<number> {
  return withRetry(() => getProvider().getBlockNumber(), "getBlockNumber");
}

export async function getBlock(blockNumber: number): Promise<ethers.Block | null> {
  return withRetry(() => getProvider().getBlock(blockNumber), `getBlock(${blockNumber})`);
}

export async function getTransactionReceipt(
  txHash: string
): Promise<ethers.TransactionReceipt | null> {
  return withRetry(
    () => getProvider().getTransactionReceipt(txHash),
    `getTransactionReceipt(${txHash.slice(0, 10)}...)`
  );
}

export async function getFeeData(): Promise<ethers.FeeData> {
  return withRetry(() => getProvider().getFeeData(), "getFeeData");
}

export async function sendRawTransaction(
  tx: ethers.TransactionRequest
): Promise<ethers.TransactionResponse> {
  const wallet = getWallet();
  return withRetry(() => wallet.sendTransaction(tx), "sendTransaction");
}

export async function getTransactionCount(address: string): Promise<number> {
  return withRetry(
    () => getProvider().getTransactionCount(address, "pending"),
    `getTransactionCount(${address.slice(0, 10)}...)`
  );
}

/**
 * Get the pending nonce for an address.
 * Uses provider.getTransactionCount(address, "pending").
 * Used by pipeline mode to get the next nonce for each tx.
 */
export async function getPendingNonce(address: string): Promise<number> {
  return withRetry(
    () => getProvider().getTransactionCount(address, "pending"),
    `getPendingNonce(${address.slice(0, 10)}...)`
  );
}

// ---------------------------------------------------------------------------
// Burn calculation
// ---------------------------------------------------------------------------

/**
 * Calculate burn(N) = floor(baseFeePerGas(N) * gasUsed(N) / 1e9) in gwei.
 * Returns undefined if the block doesn't exist or lacks EIP-1559 fields.
 * Uses bigint arithmetic throughout to avoid precision loss.
 */
export async function calculateBurnGwei(blockNumber: number): Promise<bigint | undefined> {
  const block = await getBlock(blockNumber);
  if (!block) return undefined;

  // baseFeePerGas is null for pre-EIP-1559 blocks
  if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
    return undefined;
  }

  const baseFee: bigint = block.baseFeePerGas; // already bigint in ethers v6
  const gasUsed: bigint = block.gasUsed; // already bigint in ethers v6

  // burn = floor(baseFeePerGas * gasUsed / 1e9)
  // All values in wei; divide by 1e9 to get gwei
  const burnGwei = (baseFee * gasUsed) / BigInt(1_000_000_000);
  return burnGwei;
}

/**
 * Check whether a block exists on chain (i.e. block number <= current head).
 */
export async function blockExists(blockNumber: number): Promise<boolean> {
  const block = await getBlock(blockNumber);
  return block !== null;
}

/**
 * Get the ETH balance of a wallet address.
 * Returns the balance as a float in ETH (not wei, not gwei).
 */
export async function getWalletBalanceEth(address: string): Promise<number> {
  const balanceWei = await withRetry(
    () => getProvider().getBalance(address),
    `getBalance(${address.slice(0, 10)}...)`
  );
  return Number(ethers.formatEther(balanceWei));
}
