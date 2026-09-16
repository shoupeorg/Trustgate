import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { TransactionHashVariant, type TransactionHash } from "genlayer-js/types";
import { createTransactionKit, type PolicyQuote, type SubmitInput, type TrackedStatus, type TransactionKit } from "@genlayer/transaction-kit";

const configuredContractAddress = process.env.NEXT_PUBLIC_TRUSTGATE_CONTRACT_ADDRESS;
export const TRUSTGATE_CONTRACT = configuredContractAddress && /^0x[0-9a-fA-F]{40}$/.test(configuredContractAddress)
  ? configuredContractAddress as `0x${string}`
  : null;

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

export const STUDIO_NEXT_CHAIN_ID = `0x${studioDevnet.id.toString(16)}`;
const STUDIO_NEXT_RPC = studioDevnet.rpcUrls.default.http[0];
const STUDIO_NEXT_EXPLORER = studioDevnet.blockExplorers?.default.url;
const STUDIO_NEXT_TRANSACTION_URL = "https://explorer-studio-dev.genlayer.com/tx";

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

export type ContractPreviousIssueStatus = {
  previous_issue_title: string;
  status: "RESOLVED" | "PARTIALLY_RESOLVED" | "UNRESOLVED";
  reason: string;
  current_evidence: string;
};

export type ContractRevisionContext = {
  is_revision: boolean;
  parent_inspection_id: string;
  previous_overall_risk: string;
  risk_direction: "INITIAL" | "IMPROVED" | "UNCHANGED" | "WORSENED";
  previous_issue_statuses: ContractPreviousIssueStatus[];
  new_issues: Array<{ title: string; reason_new: string }>;
  all_previous_material_issues_addressed: boolean;
};

export type ContractCounterproposalClosure = {
  issue_title: string;
  addressed: boolean;
  revised_field: string;
  closure_explanation: string;
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
    revision_context?: ContractRevisionContext;
    counterproposal_closure?: ContractCounterproposalClosure[];
  };
};

declare global {
  interface Window {
    ethereum?: BrowserProvider;
  }
}

const readClient = createClient({ chain: studioDevnet });

export type SubmittedTransaction = {
  evmTransactionHash: string | null;
  genLayerTransactionId: string;
};

export function studioNextTransactionUrl(transactionHash: string): string {
  return `${STUDIO_NEXT_TRANSACTION_URL}/${transactionHash}`;
}

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
  let revisionContext: ContractRevisionContext | undefined;
  const revisionValue = report.revision_context;
  if (revisionValue !== undefined) {
    if (!revisionValue || typeof revisionValue !== "object") throw new Error("Contract report has invalid revision context.");
    const revision = revisionValue as Record<string, unknown>;
    if (typeof revision.is_revision !== "boolean" || typeof revision.all_previous_material_issues_addressed !== "boolean") throw new Error("Contract report has invalid revision flags.");
    if (!Array.isArray(revision.previous_issue_statuses) || !Array.isArray(revision.new_issues)) throw new Error("Contract report has invalid revision issue lineage.");
    const previous_issue_statuses = revision.previous_issue_statuses.map((value, index) => {
      if (!value || typeof value !== "object") throw new Error(`Contract report previous issue ${index + 1} is invalid.`);
      const item = value as Record<string, unknown>;
      const status = requireString(item.status, "previous issue status");
      if (!(["RESOLVED", "PARTIALLY_RESOLVED", "UNRESOLVED"] as string[]).includes(status)) throw new Error("Contract report has an unsupported previous issue status.");
      return { previous_issue_title: requireString(item.previous_issue_title, "previous issue title"), status: status as ContractPreviousIssueStatus["status"], reason: requireString(item.reason, "previous issue reason"), current_evidence: requireString(item.current_evidence, "previous issue current evidence") };
    });
    const new_issues = revision.new_issues.map((value, index) => {
      if (!value || typeof value !== "object") throw new Error(`Contract report new issue ${index + 1} is invalid.`);
      const item = value as Record<string, unknown>;
      return { title: requireString(item.title, "new issue title"), reason_new: requireString(item.reason_new, "new issue reason") };
    });
    const riskDirection = requireString(revision.risk_direction, "risk direction");
    if (!(["INITIAL", "IMPROVED", "UNCHANGED", "WORSENED"] as string[]).includes(riskDirection)) throw new Error("Contract report has an unsupported risk direction.");
    revisionContext = { is_revision: revision.is_revision, parent_inspection_id: typeof revision.parent_inspection_id === "string" ? revision.parent_inspection_id : "", previous_overall_risk: typeof revision.previous_overall_risk === "string" ? revision.previous_overall_risk : "", risk_direction: riskDirection as ContractRevisionContext["risk_direction"], previous_issue_statuses, new_issues, all_previous_material_issues_addressed: revision.all_previous_material_issues_addressed };
  }
  let counterproposalClosure: ContractCounterproposalClosure[] | undefined;
  if (report.counterproposal_closure !== undefined) {
    if (!Array.isArray(report.counterproposal_closure)) throw new Error("Contract report has invalid counterproposal closure.");
    counterproposalClosure = report.counterproposal_closure.map((value, index) => {
      if (!value || typeof value !== "object") throw new Error(`Contract report closure ${index + 1} is invalid.`);
      const item = value as Record<string, unknown>;
      if (typeof item.addressed !== "boolean") throw new Error("Contract report closure has an invalid addressed flag.");
      return { issue_title: requireString(item.issue_title, "closure issue title"), addressed: item.addressed, revised_field: requireString(item.revised_field, "closure revised field"), closure_explanation: requireString(item.closure_explanation, "closure explanation") };
    });
  }

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
      revision_context: revisionContext,
      counterproposal_closure: counterproposalClosure,
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

async function ensureStudioNextNetwork(provider: BrowserProvider): Promise<void> {
  const current = await provider.request({ method: "eth_chainId" });
  if (current === STUDIO_NEXT_CHAIN_ID) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: STUDIO_NEXT_CHAIN_ID }] } as never);
  } catch (error) {
    const { code } = providerErrorDetails(error);
    if (code !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: STUDIO_NEXT_CHAIN_ID, chainName: studioDevnet.name, rpcUrls: [STUDIO_NEXT_RPC], nativeCurrency: studioDevnet.nativeCurrency, blockExplorerUrls: STUDIO_NEXT_EXPLORER ? [STUDIO_NEXT_EXPLORER] : [] }] } as never);
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: STUDIO_NEXT_CHAIN_ID }] } as never);
  }
}

function walletForAccount(provider: BrowserProvider, address: `0x${string}`) {
  return { address, client: createClient({ chain: studioDevnet, account: address, provider }), provider };
}

export async function connectStudioNextWallet(provider: BrowserProvider) {
  if (!provider || typeof provider.request !== "function") throw new Error("No compatible EIP-1193 browser wallet provider is available.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) {
    throw new Error("The wallet did not return a valid account address.");
  }
  const address = accounts[0] as `0x${string}`;
  await ensureStudioNextNetwork(provider);
  return walletForAccount(provider, address);
}

export async function restoreStudioNextWallet(provider: BrowserProvider, address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("The wallet did not expose a valid account address.");
  await ensureStudioNextNetwork(provider);
  return walletForAccount(provider, address as `0x${string}`);
}

export type ConnectedWallet = Awaited<ReturnType<typeof connectStudioNextWallet>>;

async function studioNextRpc(method: string, params: unknown[]): Promise<unknown> {
  if (studioDevnet.id !== 61997) throw new Error("TrustGate is not configured for GenLayer Studio Next.");
  const response = await fetch(STUDIO_NEXT_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  if (!response.ok) throw new Error(`Studio Next RPC request failed with HTTP ${response.status}.`);
  const payload = await response.json() as { result?: unknown; error?: { message?: string; code?: number } };
  if (payload.error) throw new Error(payload.error.message || `Studio Next RPC error ${payload.error.code ?? "unknown"}.`);
  return payload.result;
}

export async function getStudioNextBalance(address: string): Promise<bigint> {
  const result = await studioNextRpc("eth_getBalance", [address, "latest"]);
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) throw new Error("Studio Next returned an invalid wallet balance.");
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
  if (code === 4001) return "Wallet connection was rejected. Click Connect Wallet when you are ready to approve account access and the Studio Next network.";
  if (code === -32002) return "A wallet connection request is already pending. Open your wallet extension and approve or reject the existing request.";
  if (code === 4902) return "Studio Next is not available in the wallet and could not be added automatically. Allow the wallet to add the network, then try again.";
  if (code === 4900 || code === 4901) return "The wallet is disconnected from Studio Next. Reconnect the wallet and try again.";
  if (code === 4200 || message?.toLowerCase().includes("wallet_getsnaps") || message?.toLowerCase().includes("wallet_requestsnaps")) {
    return "This wallet does not support the GenLayer wallet methods required by genlayer-js. Use a compatible MetaMask wallet and try again.";
  }
  if (message?.toLowerCase().includes("switch") || message?.toLowerCase().includes("addethereumchain")) {
    return `The wallet could not add or switch to Studio Next. ${message}`;
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

export class LifecycleStatusPendingError extends Error {
  constructor() {
    super("Onchain inspection submitted. Network status is temporarily unavailable.");
    this.name = "LifecycleStatusPendingError";
  }
}

export type FinalizedFailureDetails = {
  inspectionId: string;
  genLayerTransactionId: string;
  lifecycleStatus: string;
  consensusResult: string;
  executionResult: string;
  exitCode: number | null;
};

export class FinalizedInspectionFailedError extends Error {
  readonly details: FinalizedFailureDetails;

  constructor(details: FinalizedFailureDetails) {
    super("Inspection finalized without a committed Risk Report.");
    this.name = "FinalizedInspectionFailedError";
    this.details = details;
  }
}

type InspectionLifecycle = {
  onConsensusAccepted?: () => void;
  onFinalized?: () => void;
  onNetworkRetry?: () => void;
  onReportDelayed?: () => void;
  onReportNetworkInterrupted?: () => void;
  signal?: AbortSignal;
};

const LIFECYCLE_TRANSPORT_ATTEMPTS = 3;
const LIFECYCLE_RETRY_DELAYS = [1000, 2000];

const FINAL_REPORT_REQUEST_TIMEOUT = 12000;
const FINAL_REPORT_RETRY_INTERVAL = 3000;

export type InspectionFeeQuote = PolicyQuote;

function requireContractAddress(): `0x${string}` {
  if (!TRUSTGATE_CONTRACT) {
    throw new Error("Studio Next TrustGate contract is not configured. Set NEXT_PUBLIC_TRUSTGATE_CONTRACT_ADDRESS to the deployed chain 61997 contract address.");
  }
  return TRUSTGATE_CONTRACT;
}

async function accountFromProvider(provider: BrowserProvider): Promise<`0x${string}`> {
  const accounts = await provider.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) {
    throw new Error("Reconnect the submitting wallet before continuing this inspection.");
  }
  return accounts[0] as `0x${string}`;
}

function kitFor(provider: BrowserProvider, account: `0x${string}`): TransactionKit {
  return createTransactionKit({ chain: studioDevnet, provider, account });
}

function abortError(): Error {
  const error = new Error("Finalized report recovery was cancelled.");
  error.name = "AbortError";
  return error;
}

async function withBoundedWait<T>(promise: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Finalized report read timed out."));
    }, timeout);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      clearTimeout(timer);
      cleanup();
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
  });
}

async function waitForDelay(delay: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorDetails(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message, current.name);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" ").toLowerCase();
}

function isTransientLifecycleError(error: unknown): boolean {
  const details = errorDetails(error);
  return [
    "failed to fetch",
    "network error",
    "networkerror",
    "timeout",
    "timed out",
    "temporary",
    "transport",
    "connection",
    "socket",
    "econnreset",
    "econnrefused",
    "eth_gettransactionbyhash",
    "status lookup failed",
    "rpc error",
  ].some((fragment) => details.includes(fragment));
}

async function readFinalReport(inspectionId: string): Promise<ContractInspectionReport> {
  const rawReport = await readClient.readContract({
    address: requireContractAddress(),
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
  options: { interval?: number; requestTimeout?: number; signal?: AbortSignal; onDelayed?: () => void; onNetworkInterrupted?: () => void } = {},
): Promise<ContractInspectionReport> {
  const interval = options.interval ?? FINAL_REPORT_RETRY_INTERVAL;
  const requestTimeout = options.requestTimeout ?? FINAL_REPORT_REQUEST_TIMEOUT;
  const startedAt = Date.now();
  while (true) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await withBoundedWait(readFinalReport(inspectionId), requestTimeout, options.signal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      // A finalized transaction can briefly precede visibility of its finalized
      // contract state on Studio Next. This is an expected, retryable condition.
      if (isTransientLifecycleError(error)) {
        options.onNetworkInterrupted?.();
      } else if (Date.now() - startedAt >= 120000) {
        options.onDelayed?.();
      }
    }
    const elapsed = Date.now() - startedAt;
    const retryDelay = elapsed < 120000 ? interval : elapsed < 300000 ? 5000 : 10000;
    await waitForDelay(retryDelay, options.signal);
  }
}

function notifyTrackedStatus(status: TrackedStatus, lifecycle: InspectionLifecycle): void {
  if (status.statusName?.toUpperCase() === "ACCEPTED") lifecycle.onConsensusAccepted?.();
}

export function finalizedTransactionDecision(input: {
  trackedPhase: TrackedStatus["phase"];
  lifecycleState: "processing" | "decided" | "finalized" | "canceled";
  consensusOutcome?: "accepted" | "undetermined" | "validators-timeout" | "leader-timeout";
  executionResultName?: string;
}): "pending" | "read-final-report" | "failed" {
  if (input.trackedPhase !== "finalized" || input.lifecycleState !== "finalized") return "pending";
  return input.consensusOutcome === "accepted" && input.executionResultName?.toUpperCase() === "FINISHED_WITH_RETURN"
    ? "read-final-report"
    : "failed";
}

async function trackExistingInspection(
  kit: TransactionKit,
  genLayerTransactionId: `0x${string}`,
  inspectionId: string,
  lifecycle: InspectionLifecycle,
): Promise<ContractInspectionReport> {
  let tracked: TrackedStatus | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < LIFECYCLE_TRANSPORT_ATTEMPTS; attempt += 1) {
    if (lifecycle.signal?.aborted) throw abortError();
    try {
      tracked = await kit.track(genLayerTransactionId, (status) => {
        if (lifecycle.signal?.aborted) throw abortError();
        notifyTrackedStatus(status, lifecycle);
      }, { until: "finalized" });
      break;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      lastError = error;
      if (!isTransientLifecycleError(error) || attempt === LIFECYCLE_TRANSPORT_ATTEMPTS - 1) break;
      lifecycle.onNetworkRetry?.();
      await waitForDelay(LIFECYCLE_RETRY_DELAYS[attempt], lifecycle.signal);
    }
  }

  if (!tracked) {
    if (isTransientLifecycleError(lastError)) throw new LifecycleStatusPendingError();
    throw lastError;
  }

  const transaction = await readClient.getTransaction({ hash: genLayerTransactionId as TransactionHash });
  const lifecycleState = transaction.lifecycle.state;
  const consensusOutcome = lifecycleState === "decided" || lifecycleState === "finalized"
    ? transaction.lifecycle.outcome
    : undefined;
  const executionResult = transaction.txExecutionResultName?.toUpperCase()
    ?? tracked.executionResultName?.toUpperCase()
    ?? "UNKNOWN";
  const decision = finalizedTransactionDecision({
    trackedPhase: tracked.phase,
    lifecycleState,
    consensusOutcome,
    executionResultName: executionResult,
  });

  if (decision !== "read-final-report") {
    throw new FinalizedInspectionFailedError({
      inspectionId,
      genLayerTransactionId,
      lifecycleStatus: lifecycleState.toUpperCase(),
      consensusResult: consensusOutcome?.toUpperCase() ?? transaction.resultName ?? "UNKNOWN",
      executionResult,
      exitCode: null,
    });
  }

  lifecycle.onConsensusAccepted?.();
  lifecycle.onFinalized?.();
  return waitForFinalReport(inspectionId, {
    signal: lifecycle.signal,
    onDelayed: lifecycle.onReportDelayed,
    onNetworkInterrupted: lifecycle.onReportNetworkInterrupted,
  });
}

export async function resumeSubmittedInspection(
  _client: GenLayerClient,
  provider: BrowserProvider,
  identifiers: SubmittedTransaction,
  inspectionId: string,
  onResolved: (genLayerTransactionId: string) => void,
  lifecycle: InspectionLifecycle = {},
): Promise<ContractInspectionReport> {
  const account = await accountFromProvider(provider);
  onResolved(identifiers.genLayerTransactionId);
  return trackExistingInspection(
    kitFor(provider, account),
    identifiers.genLayerTransactionId as `0x${string}`,
    inspectionId,
    lifecycle,
  );
}

export async function inspectDealOnchain(
  _client: GenLayerClient,
  provider: BrowserProvider,
  inspectionId: string,
  deal: InspectionDeal,
  onSubmitted: (identifiers: SubmittedTransaction) => void,
  onFinalizing: () => void,
  lifecycle: InspectionLifecycle = {},
  parentInspectionId?: string,
  approveFee?: (quote: InspectionFeeQuote) => boolean | Promise<boolean>,
): Promise<ContractInspectionReport> {
  if (!approveFee) throw new Error("Studio Next transaction fees require explicit user approval.");
  const account = await accountFromProvider(provider);
  const kit = kitFor(provider, account);
  const transaction: SubmitInput = {
    kind: "write",
    address: requireContractAddress(),
    method: parentInspectionId ? "inspect_revision" : "inspect_deal",
    args: parentInspectionId
      ? [inspectionId, parentInspectionId, deal.task, deal.terms, deal.permissions, deal.payment, deal.evidence, deal.instructions]
      : [inspectionId, deal.task, deal.terms, deal.permissions, deal.payment, deal.evidence, deal.instructions],
  };
  const quote = await kit.estimate({ preset: "standard" }, transaction);
  if (quote.verification.status === "mismatch") {
    throw new Error("The Studio Next fee policy changed. Re-estimate before approving the transaction.");
  }
  if (!await approveFee(quote)) throw new Error("Studio Next fee approval was cancelled.");

  const submitted = await kit.submit(quote, transaction);
  const identifiers: SubmittedTransaction = {
    evmTransactionHash: submitted.evmTxHash ?? null,
    genLayerTransactionId: submitted.genlayerTxId,
  };
  onSubmitted(identifiers);
  onFinalizing();
  return trackExistingInspection(kit, submitted.genlayerTxId, inspectionId, lifecycle);
}
