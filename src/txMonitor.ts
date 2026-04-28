/**
 * TxMonitor — monitors pending transactions and handles finality.
 *
 * Lifecycle:
 *   pending → included (receipt.status=1) → finalized (after FINALITY_CONFIRMATIONS)
 *   pending → failed (receipt.status≠1)
 *   included/finalized → review_required (indexer mismatch or reorg)
 *
 * After finality:
 *   - EDMT indexer is queried to verify owner matches wallet address
 *   - If verified: last_successful_mint_block checkpoint is updated
 *   - If mismatch: block is marked review_required
 */

import { config } from "./config.js";
import { logger, LogEvent } from "./logger.js";
import { getPendingTxs, updateTxStatus, upsertBlockResult, recordError } from "./db.js";
import { getTransactionReceipt, getCurrentBlockNumber } from "./ethClient.js";
import { getBlockStatus } from "./edmtClient.js";
import { setSuccessfulMintBlock, setFinalizedTx } from "./checkpoint.js";

// ---------------------------------------------------------------------------
// Main poll function — call periodically
// ---------------------------------------------------------------------------

export async function poll(): Promise<void> {
  const pendingTxs = getPendingTxs();

  if (pendingTxs.length === 0) return;

  logger.info(
    { event: LogEvent.TX_INCLUDED, count: pendingTxs.length },
    `TxMonitor: checking ${pendingTxs.length} pending tx(s)`
  );

  const currentBlock = await getCurrentBlockNumber().catch(() => null);

  for (const tx of pendingTxs) {
    await processPendingTx(tx, currentBlock);
  }
}

// ---------------------------------------------------------------------------
// Process a single pending tx
// ---------------------------------------------------------------------------

async function processPendingTx(
  tx: {
    id: number;
    block: number;
    tx_hash: string;
    nonce: number;
    submitted_at: string;
    status?: string;
  },
  currentBlock: number | null
): Promise<void> {
  // If already included, skip receipt fetch and go straight to finality check
  if ((tx as { status?: string }).status === "included") {
    let receipt;
    try {
      receipt = await getTransactionReceipt(tx.tx_hash);
    } catch {
      return;
    }
    if (receipt && receipt.status === 1) {
      await verifyOwnership(tx.block, tx.tx_hash, receipt.blockNumber, currentBlock);
    }
    return;
  }
  let receipt;
  try {
    receipt = await getTransactionReceipt(tx.tx_hash);
  } catch (err) {
    logger.warn(
      { event: LogEvent.RPC_ERROR, txHash: tx.tx_hash, err: String(err) },
      `Failed to get receipt for ${tx.tx_hash}`
    );
    return;
  }

  if (!receipt) {
    // Still pending — check for potential reorg (tx submitted long ago)
    if (currentBlock !== null) {
      const submittedAt = new Date(tx.submitted_at).getTime();
      const ageMs = Date.now() - submittedAt;
      const ageBlocks = Math.floor(ageMs / 12000); // ~12s per block
      if (ageBlocks > 200) {
        logger.warn(
          {
            event: LogEvent.TX_REORG_SUSPECTED,
            txHash: tx.tx_hash,
            block: tx.block,
            ageBlocks,
          },
          `Tx ${tx.tx_hash} has been pending for ~${ageBlocks} blocks — possible reorg`
        );
        updateTxStatus(tx.tx_hash, "review_required");
        upsertBlockResult({
          block: tx.block,
          status: "review_required",
          reason: "tx_pending_too_long",
        });
      }
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Receipt received
  // -------------------------------------------------------------------------

  if (receipt.status === 1) {
    // Transaction included successfully
    updateTxStatus(tx.tx_hash, "included");
    upsertBlockResult({ block: tx.block, status: "included" });

    logger.info(
      {
        event: LogEvent.TX_INCLUDED,
        txHash: tx.tx_hash,
        block: tx.block,
        blockNumber: receipt.blockNumber,
      },
      `Tx ${tx.tx_hash} included in block ${receipt.blockNumber}`
    );

    // Verify EDMT indexer ownership
    await verifyOwnership(tx.block, tx.tx_hash, receipt.blockNumber, currentBlock);
  } else {
    // Transaction failed
    updateTxStatus(tx.tx_hash, "failed");
    upsertBlockResult({ block: tx.block, status: "failed", reason: "tx_reverted" });
    recordError({
      block: tx.block,
      stage: "txMonitor:failed",
      message: `Tx ${tx.tx_hash} failed (receipt.status=${receipt.status})`,
    });

    logger.warn(
      { event: LogEvent.TX_FAILED, txHash: tx.tx_hash, block: tx.block },
      `Tx ${tx.tx_hash} failed`
    );
  }
}

// ---------------------------------------------------------------------------
// Ownership verification and finality
// ---------------------------------------------------------------------------

async function verifyOwnership(
  block: number,
  txHash: string,
  includedInBlock: number,
  currentBlock: number | null
): Promise<void> {
  // Check if we've reached finality
  if (currentBlock === null) return;

  const confirmations = currentBlock - includedInBlock;

  if (confirmations < config.finalityConfirmations) {
    logger.info(
      {
        event: LogEvent.TX_INCLUDED,
        txHash,
        block,
        confirmations,
        required: config.finalityConfirmations,
      },
      `Tx ${txHash} has ${confirmations}/${config.finalityConfirmations} confirmations — waiting for finality`
    );
    return;
  }

  // Finality reached — verify with EDMT indexer
  logger.info(
    { event: LogEvent.TX_FINALIZED, txHash, block, confirmations },
    `Tx ${txHash} reached finality (${confirmations} confirmations) — verifying with EDMT indexer`
  );

  try {
    const blockStatus = await getBlockStatus(block);

    if (blockStatus.status === "minted" && blockStatus.owner) {
      // Get wallet address for comparison
      const { getWallet } = await import("./ethClient.js");
      let walletAddress: string;
      try {
        walletAddress = getWallet().address;
      } catch {
        // No wallet in dry-run mode — skip ownership check
        updateTxStatus(txHash, "finalized");
        upsertBlockResult({ block, status: "finalized" });
        setFinalizedTx(txHash);
        setSuccessfulMintBlock(block);
        logger.info(
          { event: LogEvent.TX_FINALIZED, txHash, block },
          `Block ${block} finalized (wallet not available for ownership check)`
        );
        return;
      }

      const ownerMatches = blockStatus.owner.toLowerCase() === walletAddress.toLowerCase();

      if (ownerMatches) {
        updateTxStatus(txHash, "finalized");
        upsertBlockResult({
          block,
          status: "successful_mint",
          owner: blockStatus.owner,
          mintTx: txHash,
        });
        setFinalizedTx(txHash);
        setSuccessfulMintBlock(block);

        logger.info(
          { event: LogEvent.TX_FINALIZED, txHash, block, owner: blockStatus.owner },
          `Block ${block} successfully minted and verified — owner: ${blockStatus.owner}`
        );
      } else {
        // Owner mismatch — someone else minted first (first-is-first)
        updateTxStatus(txHash, "review_required");
        upsertBlockResult({
          block,
          status: "review_required",
          owner: blockStatus.owner,
          reason: `owner_mismatch: expected ${walletAddress}, got ${blockStatus.owner}`,
        });

        logger.warn(
          {
            event: LogEvent.TX_REVIEW_REQUIRED,
            txHash,
            block,
            expectedOwner: walletAddress,
            actualOwner: blockStatus.owner,
          },
          `Block ${block} owner mismatch — review required`
        );
      }
    } else if (blockStatus.status === "unknown") {
      // Indexer unavailable — mark for review
      updateTxStatus(txHash, "review_required");
      upsertBlockResult({
        block,
        status: "review_required",
        reason: "indexer_unavailable_at_finality",
      });

      logger.warn(
        { event: LogEvent.TX_REVIEW_REQUIRED, txHash, block },
        `EDMT indexer unavailable at finality check — block ${block} marked review_required`
      );
    } else {
      // Unexpected status
      updateTxStatus(txHash, "review_required");
      upsertBlockResult({
        block,
        status: "review_required",
        reason: `unexpected_indexer_status: ${blockStatus.status}`,
      });

      logger.warn(
        { event: LogEvent.TX_REVIEW_REQUIRED, txHash, block, indexerStatus: blockStatus.status },
        `Unexpected EDMT indexer status at finality — block ${block} marked review_required`
      );
    }
  } catch (err) {
    recordError({
      block,
      stage: "txMonitor:verifyOwnership",
      message: `Finality verification failed: ${String(err)}`,
    });
    updateTxStatus(txHash, "review_required");
    upsertBlockResult({ block, status: "review_required", reason: "finality_verification_error" });

    logger.error(
      { event: LogEvent.TX_REVIEW_REQUIRED, txHash, block, err: String(err) },
      `Finality verification error for block ${block}`
    );
  }
}
