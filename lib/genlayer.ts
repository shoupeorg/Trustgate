import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { ExecutionResult, TransactionHashVariant, TransactionStatus } from "genlayer-js/types";

export const TRUSTGATE_CONTRACT = "0x4acc7623a1a5255b717752601F78D2cf3a99e7F3" as const;

type ClientOptions = NonNullable<Parameters<typeof createClient>[0]>;
export type BrowserProvider = NonNullable<ClientOptions["provider"]> & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
type GenLayerClient = ReturnType<typeof createClient>;

export type DiscoveredWallet = {
  id: string;
  name: string;
  icon?: string;
  rdns?: string;
  provider: BrowserProvider;
};

export const STUDIONET_CHAIN_ID = `0x${studionet.id.toString(16)}`;
const STUDIONET_RPC = studionet.rpcUrls.default.http[0];
const STUDIONET_EXPLORER = studionet.blockExplorers?.default.url;

export type InspectionDeal = {
  task: string;
  terms: string;
  permissions: string;
  payment: string;
  evidence: string;
  instructions: string;
};

type ContractIssue = {
  category: string;
  title: string;
  description: string;
  evidence: string;
  potential_consequence: string;
};

type ContractRevisedDeal = {
  contract_terms: string;
  requested_permissions: string;
  payment_conditions: string;
  evidence_requirements: string;
  instructions: string;
};

export type ContractInspectionReport = {
  inspection_id: string;
  report: {
    confidence: string;
    detected_issues: ContractIssue[];
    overall_risk: string;
    potential_consequences: string[];
    recommended_actions: string[];
    recommended_decision: string;
    revised_deal_package: ContractRevisedDeal;
    risk_categories: string[];
    safer_constraints: string[];
    summary: string;
    supporting_evidence: string[];
    unknowns: string[];
  };
};

declare global {
  interface Window {
    ethereum?: BrowserProvider;
  }
}

const readClient = createClient({ chain: studionet });
// Exact topics for NewTransaction(bytes32,address,address) and
// CreatedTransaction(bytes32,uint256), the two events decoded by genlayer-js 1.1.8.
const NEW_TRANSACTION_TOPIC = "0xdab9102861c7483a187584d6371d88316f005af507982ccf95c110879f3ed5a5";
const CREATED_TRANSACTION_TOPIC = "0x8620e7f03a280a3d2aa84bd41ba19524c2d7f1dbfa9d79cb81877b0f8c963f9b";

type EvmReceipt = { status?: string; logs?: Array<{ address?: string; topics?: string[] }> };

export type SubmittedTransaction = {
  evmTransactionHash: string;
  genLayerTransactionId: string | null;
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Contract report is missing ${field}.`);
  return value;
}

function requireStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Contract report has invalid ${field}.`);
  return value;
}

function parseReport(value: unknown): ContractInspectionReport {
  if (typeof value !== "string" || value.length === 0) throw new Error("The finalized inspection did not return a report.");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("The contract returned an invalid JSON report."); }
  if (!parsed || typeof parsed !== "object") throw new Error("The contract returned an invalid report object.");

  const root = parsed as Record<string, unknown>;
  const reportValue = root.report;
  if (!reportValue || typeof reportValue !== "object") throw new Error("The contract report payload is missing.");
  const report = reportValue as Record<string, unknown>;
  const issuesValue = report.detected_issues;
  if (!Array.isArray(issuesValue)) throw new Error("Contract report has invalid detected issues.");
  const detectedIssues = issuesValue.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Contract report issue ${index + 1} is invalid.`);
    const issue = value as Record<string, unknown>;
    return {
      category: requireString(issue.category, "issue category"),
      title: requireString(issue.title, "issue title"),
      description: requireString(issue.description, "issue description"),
      evidence: requireString(issue.evidence, "issue evidence"),
      potential_consequence: requireString(issue.potential_consequence, "issue consequence"),
    };
  });
  const revisedValue = report.revised_deal_package;
  if (!revisedValue || typeof revisedValue !== "object") throw new Error("Contract report has no revised deal package.");
  const revised = revisedValue as Record<string, unknown>;

  return {
    inspection_id: requireString(root.inspection_id, "inspection ID"),
    report: {
      confidence: requireString(report.confidence, "confidence"),
      detected_issues: detectedIssues,
      overall_risk: requireString(report.overall_risk, "overall risk"),
      potential_consequences: requireStrings(report.potential_consequences, "potential consequences"),
      recommended_actions: requireStrings(report.recommended_actions, "recommended actions"),
      recommended_decision: requireString(report.recommended_decision, "recommended decision"),
      revised_deal_package: {
        contract_terms: requireString(revised.contract_terms, "revised contract terms"),
        requested_permissions: requireString(revised.requested_permissions, "revised permissions"),
        payment_conditions: requireString(revised.payment_conditions, "revised payment conditions"),
        evidence_requirements: requireString(revised.evidence_requirements, "revised evidence requirements"),
        instructions: requireString(revised.instructions, "revised instructions"),
      },
      risk_categories: requireStrings(report.risk_categories, "risk categories"),
      safer_constraints: requireStrings(report.safer_constraints, "safer constraints"),
      summary: requireString(report.summary, "summary"),
      supporting_evidence: requireStrings(report.supporting_evidence, "supporting evidence"),
      unknowns: requireStrings(report.unknowns, "unknowns"),
    },
  };
}

export function getBrowserProvider(): BrowserProvider | null {
  if (typeof window === "undefined" || !window.ethereum || typeof window.ethereum.request !== "function") return null;
  return window.ethereum;
}

export function discoverWalletProviders(onChange: (wallets: DiscoveredWallet[]) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wallets = new Map<string, DiscoveredWallet>();
  const publish = () => onChange(Array.from(wallets.values()));
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: BrowserProvider }>).detail;
    if (!detail?.provider || typeof detail.provider.request !== "function") return;
    if (Array.from(wallets.values()).some((wallet) => wallet.provider === detail.provider || Boolean(detail.info?.rdns && wallet.rdns === detail.info.rdns))) return;
    const id = detail.info?.uuid || detail.info?.rdns || detail.info?.name || `provider-${wallets.size + 1}`;
    wallets.set(id, { id, name: detail.info?.name || "Browser Wallet", icon: detail.info?.icon, rdns: detail.info?.rdns, provider: detail.provider });
    publish();
  };
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const fallback = window.setTimeout(() => {
    const provider = getBrowserProvider();
    if (wallets.size === 0 && provider) {
      wallets.set("window.ethereum", { id: "window.ethereum", name: "Browser Wallet", provider });
      publish();
    }
  }, 300);
  return () => {
    window.clearTimeout(fallback);
    window.removeEventListener("eip6963:announceProvider", announce);
  };
}

async function ensureStudionetNetwork(provider: BrowserProvider): Promise<void> {
  const current = await provider.request({ method: "eth_chainId" });
  if (current === STUDIONET_CHAIN_ID) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: STUDIONET_CHAIN_ID }] } as never);
  } catch (error) {
    const { code } = providerErrorDetails(error);
    if (code !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: STUDIONET_CHAIN_ID, chainName: studionet.name, rpcUrls: [STUDIONET_RPC], nativeCurrency: studionet.nativeCurrency, blockExplorerUrls: STUDIONET_EXPLORER ? [STUDIONET_EXPLORER] : [] }] } as never);
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: STUDIONET_CHAIN_ID }] } as never);
  }
}

function walletForAccount(provider: BrowserProvider, address: `0x${string}`) {
  return { address, client: createClient({ chain: studionet, account: address, provider }), provider };
}

export async function connectStudionetWallet(provider: BrowserProvider) {
  if (!provider || typeof provider.request !== "function") throw new Error("No compatible EIP-1193 browser wallet provider is available.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) {
    throw new Error("The wallet did not return a valid account address.");
  }
  const address = accounts[0] as `0x${string}`;
  await ensureStudionetNetwork(provider);
  return walletForAccount(provider, address);
}

export async function restoreStudionetWallet(provider: BrowserProvider, address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("The wallet did not expose a valid account address.");
  await ensureStudionetNetwork(provider);
  return walletForAccount(provider, address as `0x${string}`);
}

export type ConnectedWallet = Awaited<ReturnType<typeof connectStudionetWallet>>;

async function studionetRpc(method: string, params: unknown[]): Promise<unknown> {
  if (studionet.id !== 61999 || STUDIONET_RPC !== "https://studio.genlayer.com/api") throw new Error("TrustGate is not configured for stable GenLayer Studionet.");
  const response = await fetch(STUDIONET_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  if (!response.ok) throw new Error(`Studionet RPC request failed with HTTP ${response.status}.`);
  const payload = await response.json() as { result?: unknown; error?: { message?: string; code?: number } };
  if (payload.error) throw new Error(payload.error.message || `Studionet RPC error ${payload.error.code ?? "unknown"}.`);
  return payload.result;
}

export async function getStudionetBalance(address: string): Promise<bigint> {
  const result = await studionetRpc("eth_getBalance", [address, "latest"]);
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) throw new Error("Studionet returned an invalid wallet balance.");
  return BigInt(result);
}

type ProviderError = { code?: unknown; message?: unknown; cause?: unknown };

function providerErrorDetails(error: unknown): { code?: number; message?: string } {
  if (error instanceof Error) {
    const extended = error as Error & ProviderError;
    const code = typeof extended.code === "number" ? extended.code : undefined;
    if (extended.cause) {
      const cause = providerErrorDetails(extended.cause);
      return { code: cause.code ?? code, message: cause.message ?? error.message };
    }
    return { code, message: error.message };
  }
  if (error && typeof error === "object") {
    const value = error as ProviderError;
    const code = typeof value.code === "number" ? value.code : undefined;
    const message = typeof value.message === "string" ? value.message : undefined;
    if (value.cause) {
      const cause = providerErrorDetails(value.cause);
      return { code: cause.code ?? code, message: cause.message ?? message };
    }
    return { code, message };
  }
  return { message: typeof error === "string" ? error : undefined };
}

export function walletConnectionErrorMessage(error: unknown): string {
  const { code, message } = providerErrorDetails(error);
  if (code === 4001) return "Wallet connection was rejected. Click Connect Wallet when you are ready to approve account access and the Studionet network.";
  if (code === -32002) return "A wallet connection request is already pending. Open your wallet extension and approve or reject the existing request.";
  if (code === 4902) return "Stable Studionet is not available in the wallet and could not be added automatically. Allow the wallet to add the network, then try again.";
  if (code === 4900 || code === 4901) return "The wallet is disconnected from Stable Studionet. Reconnect the wallet and try again.";
  if (code === 4200 || message?.toLowerCase().includes("wallet_getsnaps") || message?.toLowerCase().includes("wallet_requestsnaps")) {
    return "This wallet does not support the GenLayer wallet methods required by genlayer-js. Use a compatible MetaMask wallet and try again.";
  }
  if (message?.toLowerCase().includes("switch") || message?.toLowerCase().includes("addethereumchain")) {
    return `The wallet could not add or switch to Stable Studionet. ${message}`;
  }
  return message ? `Wallet connection failed: ${message}` : "Wallet connection failed with an unknown provider error. Check the browser console for the original exception.";
}

export function createInspectionId(): string {
  return `trustgate-${Date.now()}-${crypto.randomUUID()}`;
}

export class FinalizationPendingError extends Error {
  constructor() {
    super("Consensus accepted the transaction. Finalization is still pending.");
    this.name = "FinalizationPendingError";
  }
}

export class FinalizedReportPendingError extends Error {
  constructor() {
    super("Transaction finalized. Waiting for the finalized TrustGate report.");
    this.name = "FinalizedReportPendingError";
  }
}

export class TransactionIdPendingError extends Error {
  readonly identifiers: SubmittedTransaction;

  constructor(identifiers: SubmittedTransaction) {
    super("Transaction submitted, but the GenLayer transaction ID could not yet be resolved.");
    this.name = "TransactionIdPendingError";
    this.identifiers = identifiers;
  }
}

type ReceiptHash = Parameters<typeof readClient.waitForTransactionReceipt>[0]["hash"];
type InspectionLifecycle = {
  onConsensusAccepted?: () => void;
  onFinalized?: () => void;
};

async function readFinalReport(inspectionId: string): Promise<ContractInspectionReport> {
  const rawReport = await readClient.readContract({
    address: TRUSTGATE_CONTRACT,
    functionName: "get_report",
    args: [inspectionId],
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  });
  const parsed = parseReport(rawReport);
  if (parsed.inspection_id !== inspectionId) {
    throw new Error(`The finalized report belongs to a different inspection (${parsed.inspection_id}).`);
  }
  return parsed;
}

async function waitForFinalReport(
  inspectionId: string,
  options: { interval?: number; attempts?: number } = {},
): Promise<ContractInspectionReport | null> {
  const interval = options.interval ?? 3000;
  const attempts = options.attempts ?? 30;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readFinalReport(inspectionId);
    } catch {
      // A finalized transaction can briefly precede visibility of its finalized
      // contract state on Studionet. This is an expected, retryable condition.
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}

export async function resumeInspectionOnchain(
  client: GenLayerClient,
  genLayerTransactionId: string,
  inspectionId: string,
  lifecycle: InspectionLifecycle = {},
): Promise<ContractInspectionReport> {
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash: genLayerTransactionId as ReceiptHash,
      status: TransactionStatus.FINALIZED,
      interval: 3000,
      retries: 120,
    });
  } catch (error) {
    let numericStatus: number | string | undefined;
    let statusName: string | undefined;
    try {
      const transaction = await client.getTransaction({ hash: genLayerTransactionId as ReceiptHash });
      numericStatus = transaction.status;
      statusName = transaction.statusName;
    } catch (statusError) {
      const message = error instanceof Error ? error.message : String(error);
      if (/current status:\s*5\b/i.test(message)) {
        numericStatus = 5;
        statusName = TransactionStatus.ACCEPTED;
      }
      console.error("GenLayer transaction status lookup failed:", statusError);
    }
    console.error("GenLayer finalization polling failed:", { error, status: numericStatus, statusName });
    if (numericStatus === 5 || numericStatus === TransactionStatus.ACCEPTED || statusName === TransactionStatus.ACCEPTED) {
      lifecycle.onConsensusAccepted?.();
      throw new FinalizationPendingError();
    }
    throw error;
  }

  lifecycle.onConsensusAccepted?.();
  lifecycle.onFinalized?.();
  // The inspection-specific durable state is authoritative. Studionet 1.1.8
  // may expose FINALIZED before that state is immediately readable.
  const finalizedReport = await waitForFinalReport(inspectionId);
  if (finalizedReport) return finalizedReport;
  if (receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR) {
    throw new Error("GenLayer finalized the transaction with an explicit execution failure, and no valid finalized TrustGate report is available.");
  }
  throw new FinalizedReportPendingError();
}

function extractGenLayerTransactionId(receipt: EvmReceipt): string | null {
  for (const log of receipt.logs ?? []) {
    const eventTopic = log.topics?.[0]?.toLowerCase();
    const txId = log.topics?.[1];
    if ((eventTopic === NEW_TRANSACTION_TOPIC || eventTopic === CREATED_TRANSACTION_TOPIC) && /^0x[0-9a-fA-F]{64}$/.test(txId ?? "")) {
      return txId!;
    }
  }
  return null;
}

async function getEvmReceipt(provider: BrowserProvider, evmTransactionHash: string): Promise<EvmReceipt | null> {
  const receipt = await provider.request({
    method: "eth_getTransactionReceipt",
    params: [evmTransactionHash],
  } as Parameters<BrowserProvider["request"]>[0]);
  return receipt && typeof receipt === "object" ? receipt as EvmReceipt : null;
}

export async function resolveGenLayerTransactionId(
  provider: BrowserProvider,
  evmTransactionHash: string,
  options: { interval?: number; retries?: number } = {},
): Promise<string | null> {
  const interval = options.interval ?? 3000;
  const retries = options.retries ?? 120;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const receipt = await getEvmReceipt(provider, evmTransactionHash);
    if (receipt) {
      if (receipt.status === "0x0") throw new Error(`The EVM submission reverted (${evmTransactionHash}).`);
      return extractGenLayerTransactionId(receipt);
    }
    if (attempt < retries - 1) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}

export async function resumeSubmittedInspection(
  client: GenLayerClient,
  provider: BrowserProvider,
  identifiers: SubmittedTransaction,
  inspectionId: string,
  onResolved: (genLayerTransactionId: string) => void,
  lifecycle: InspectionLifecycle = {},
): Promise<ContractInspectionReport> {
  const genLayerTransactionId = identifiers.genLayerTransactionId
    ?? await resolveGenLayerTransactionId(provider, identifiers.evmTransactionHash, { retries: 1 });
  if (!genLayerTransactionId) throw new TransactionIdPendingError(identifiers);
  onResolved(genLayerTransactionId);
  return resumeInspectionOnchain(client, genLayerTransactionId, inspectionId, lifecycle);
}

export async function inspectDealOnchain(
  client: ReturnType<typeof createClient>,
  provider: BrowserProvider,
  inspectionId: string,
  deal: InspectionDeal,
  onSubmitted: (identifiers: SubmittedTransaction) => void,
  onFinalizing: () => void,
  lifecycle: InspectionLifecycle = {},
): Promise<ContractInspectionReport> {
  // genlayer-js 1.1.8 estimates gas internally in writeContract immediately
  // before dispatch; its public write API has no distribution/feeValue inputs.
  const evmTransactionHash = await client.writeContract({
    address: TRUSTGATE_CONTRACT,
    functionName: "inspect_deal",
    args: [inspectionId, deal.task, deal.terms, deal.permissions, deal.payment, deal.evidence, deal.instructions],
    value: BigInt(0),
  });
  if (typeof evmTransactionHash !== "string") throw new Error("The wallet did not return an EVM transaction hash.");
  let identifiers: SubmittedTransaction = { evmTransactionHash, genLayerTransactionId: null };
  onSubmitted(identifiers);
  const genLayerTransactionId = await resolveGenLayerTransactionId(provider, evmTransactionHash);
  if (!genLayerTransactionId) throw new TransactionIdPendingError(identifiers);
  identifiers = { evmTransactionHash, genLayerTransactionId };
  onSubmitted(identifiers);
  onFinalizing();
  return resumeInspectionOnchain(client, genLayerTransactionId, inspectionId, lifecycle);
}
