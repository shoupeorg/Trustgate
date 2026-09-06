import "server-only";

import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_URL = "https://studio.genlayer.com/api";
const CHAIN_ID = 61999;
const EXPECTED_TREASURY = getAddress("0x223CaA499378cE57BD5754F1cB66336f04ae20a4");
const FAUCET_AMOUNT = parseEther("2");
const BALANCE_POLL_ATTEMPTS = 10;
const BALANCE_POLL_INTERVAL = 1500;
const READ_RETRY_DELAYS = [500, 1000] as const;
const SUBMISSION_LOOKUP_ATTEMPTS = 6;
const RECEIPT_POLL_INTERVAL = 3000;
const RECEIPT_TIMEOUT = 180_000;

const studionet = defineChain({
  id: CHAIN_ID,
  name: "GenLayer Studionet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

class FaucetRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function faucetError(message: string, status: number, stage: string) {
  return NextResponse.json({ success: false, error: message, stage }, { status });
}

function sleep(delay: number) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function errorChain(error: unknown) {
  const chain: Array<{ name?: string; code?: number; status?: number; message?: string; shortMessage?: string }> = [];
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const value = current as { name?: unknown; code?: unknown; status?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    chain.push({
      name: typeof value.name === "string" ? value.name : undefined,
      code: typeof value.code === "number" ? value.code : undefined,
      status: typeof value.status === "number" ? value.status : undefined,
      message: typeof value.message === "string" ? value.message : undefined,
      shortMessage: typeof value.shortMessage === "string" ? value.shortMessage : undefined,
    });
    current = value.cause;
  }
  return chain;
}

function sanitizedRpcError(error: unknown, method: string) {
  const chain = errorChain(error);
  const primary = chain[0] ?? {};
  const coded = chain.find(({ code, status }) => code !== undefined || status !== undefined);
  const concise = chain.find(({ shortMessage }) => shortMessage)?.shortMessage
    ?? chain.find(({ message }) => message)?.message?.split("\n", 1)[0]
    ?? "RPC request failed before a response could be decoded.";
  return {
    method,
    name: primary.name ?? "UnknownError",
    code: coded?.code ?? null,
    httpStatus: coded?.status ?? null,
    message: concise,
    receivedHttpResponse: coded?.status !== undefined,
  };
}

function isTransientReadError(error: unknown) {
  return errorChain(error).some(({ name, code, status, message }) => {
    if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) return true;
    if (code === -32005 || code === -32603) return true;
    if (name && /HttpRequestError|TimeoutError|SocketError|NetworkError/.test(name)) return true;
    return Boolean(message && /timeout|timed out|network|fetch failed|ECONN|rate.?limit|HTTP (408|425|429|5\d\d)/i.test(message));
  });
}

async function readWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= READ_RETRY_DELAYS.length || !isTransientReadError(error)) throw error;
      await sleep(READ_RETRY_DELAYS[attempt]);
    }
  }
}

function isNotFoundError(error: unknown) {
  return errorChain(error).some(({ name }) => name === "TransactionNotFoundError" || name === "TransactionReceiptNotFoundError");
}

type PublicClient = ReturnType<typeof createPublicClient>;
type Receipt = Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;

async function getReceiptIfAvailable(publicClient: PublicClient, hash: `0x${string}`): Promise<Receipt | null> {
  try {
    return await readWithRetry(() => publicClient.getTransactionReceipt({ hash }));
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function transactionExists(publicClient: PublicClient, hash: `0x${string}`) {
  try {
    await readWithRetry(() => publicClient.getTransaction({ hash }));
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function recoverAmbiguousSubmission(publicClient: PublicClient, hash: `0x${string}`) {
  for (let attempt = 0; attempt < SUBMISSION_LOOKUP_ATTEMPTS; attempt += 1) {
    const receipt = await getReceiptIfAvailable(publicClient, hash);
    if (receipt) return { found: true, receipt };
    if (await transactionExists(publicClient, hash)) return { found: true, receipt: null };
    if (attempt < SUBMISSION_LOOKUP_ATTEMPTS - 1) await sleep(BALANCE_POLL_INTERVAL);
  }
  return { found: false, receipt: null };
}

async function waitForEvmReceipt(publicClient: PublicClient, hash: `0x${string}`) {
  const deadline = Date.now() + RECEIPT_TIMEOUT;
  while (Date.now() < deadline) {
    const receipt = await getReceiptIfAvailable(publicClient, hash);
    if (receipt) return receipt;
    await sleep(RECEIPT_POLL_INTERVAL);
  }
  throw new FaucetRequestError("The native GEN transfer was submitted, but its EVM receipt is still pending.", 504);
}

async function verifiedRecipientBalance(
  publicClient: PublicClient,
  recipient: `0x${string}`,
  balanceBefore: bigint,
) {
  for (let attempt = 0; attempt < BALANCE_POLL_ATTEMPTS; attempt += 1) {
    const balanceAfter = await readWithRetry(() => publicClient.getBalance({ address: recipient }));
    if (balanceAfter >= balanceBefore + FAUCET_AMOUNT) return balanceAfter;
    if (attempt < BALANCE_POLL_ATTEMPTS - 1) {
      await sleep(BALANCE_POLL_INTERVAL);
    }
  }
  throw new FaucetRequestError("The transfer was submitted, but the recipient balance could not be verified.", 502);
}

export async function POST(request: NextRequest) {
  let stage = "request-validation";
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new FaucetRequestError("Provide a valid JSON request body.", 400);
    }
    const requestedAddress = body && typeof body === "object" && "address" in body
      ? (body as { address?: unknown }).address
      : null;
    if (typeof requestedAddress !== "string" || !isAddress(requestedAddress)) {
      throw new FaucetRequestError("Provide a valid EVM wallet address.", 400);
    }
    const recipient = getAddress(requestedAddress);
    if (recipient === zeroAddress) throw new FaucetRequestError("The zero address cannot receive faucet funds.", 400);

    stage = "treasury-configuration";
    const privateKey = process.env.TRUSTGATE_FAUCET_PRIVATE_KEY;
    if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new FaucetRequestError("The TrustGate faucet treasury is not configured.", 503);
    }
    const treasury = privateKeyToAccount(privateKey as `0x${string}`);
    if (treasury.address !== EXPECTED_TREASURY) {
      throw new FaucetRequestError("The TrustGate faucet treasury configuration is invalid.", 503);
    }

    stage = "rpc-connectivity";
    const publicClient = createPublicClient({ chain: studionet, transport: http(RPC_URL) });
    const walletClient = createWalletClient({ account: treasury, chain: studionet, transport: http(RPC_URL) });
    const activeChainId = await readWithRetry(() => publicClient.getChainId());
    stage = "chain-validation";
    if (activeChainId !== CHAIN_ID) throw new FaucetRequestError("The faucet RPC is not connected to GenLayer Studionet.", 503);

    stage = "balance-and-fee-check";
    const [treasuryBalanceBefore, recipientBalanceBefore, estimatedGas, gasPrice] = await Promise.all([
      readWithRetry(() => publicClient.getBalance({ address: treasury.address })),
      readWithRetry(() => publicClient.getBalance({ address: recipient })),
      readWithRetry(() => publicClient.estimateGas({ account: treasury.address, to: recipient, value: FAUCET_AMOUNT })),
      readWithRetry(() => publicClient.getGasPrice()),
    ]);
    if (treasuryBalanceBefore < FAUCET_AMOUNT + estimatedGas * gasPrice) {
      throw new FaucetRequestError("The TrustGate faucet treasury does not have enough GEN.", 503);
    }

    stage = "transaction-preparation";
    const preparedTransaction = await readWithRetry(() => walletClient.prepareTransactionRequest({
      account: treasury,
      chain: studionet,
      to: recipient,
      value: FAUCET_AMOUNT,
    }));
    const serializedTransaction = await walletClient.signTransaction(preparedTransaction);
    const transactionHash = keccak256(serializedTransaction);

    stage = "transaction-submission";
    let recoveredReceipt: Receipt | null = null;
    try {
      const broadcastHash = await walletClient.sendRawTransaction({ serializedTransaction });
      if (broadcastHash.toLowerCase() !== transactionHash.toLowerCase()) {
        throw new Error("The RPC returned a transaction hash that did not match the signed transaction.");
      }
    } catch {
      stage = "submission-unknown";
      const recovered = await recoverAmbiguousSubmission(publicClient, transactionHash);
      if (!recovered.found) {
        throw new FaucetRequestError(
          "The transfer submission status is unknown. Do not request faucet funds again immediately; check this transaction later.",
          503,
        );
      }
      recoveredReceipt = recovered.receipt;
    }
    // Native GEN transfers are ordinary EVM transactions. They require only
    // their EVM receipt, never GenLayer Intelligent Contract consensus polling.
    stage = "receipt-confirmation";
    const receipt = recoveredReceipt ?? await waitForEvmReceipt(publicClient, transactionHash);
    if (receipt.status !== "success") {
      throw new FaucetRequestError("The Studionet faucet transfer failed.", 502);
    }
    stage = "balance-verification";
    await verifiedRecipientBalance(publicClient, recipient, recipientBalanceBefore);
    stage = "treasury-balance-refresh";
    const treasuryBalanceAfter = await readWithRetry(() => publicClient.getBalance({ address: treasury.address }));

    return NextResponse.json({
      success: true,
      recipient,
      amount: FAUCET_AMOUNT.toString(),
      transactionHash,
      treasuryBalanceAfter: treasuryBalanceAfter.toString(),
    });
  } catch (error) {
    if (error instanceof FaucetRequestError) return faucetError(error.message, error.status, stage);
    const safeDiagnostic = { stage, ...sanitizedRpcError(error, stage === "rpc-connectivity" ? "eth_chainId" : "faucet-stage") };
    console.warn("TrustGate faucet request failed:", safeDiagnostic);
    return faucetError(`The TrustGate faucet failed during ${stage}.`, 502, stage);
  }
}
