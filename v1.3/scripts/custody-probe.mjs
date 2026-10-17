// Day-0 custody probe on GenLayer Studio Next (chain 61997).
//
//   node scripts/custody-probe.mjs wallet   create a throwaway test wallet (key -> .env.local only)
//   node scripts/custody-probe.mjs run      deploy custody_probe.py, deposit, move_internal, withdraw
//
// The private key is written only to .env.local (gitignored) and is never printed.
// Only public addresses, tx hashes and results are shown.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env.local");
const KEY_VAR = "CUSTODY_TEST_PRIVATE_KEY";
const CONTRACT = path.join(ROOT, "experiments", "custody_probe.py");
const RESULTS = path.join(ROOT, "experiments", "custody_probe_results.json");
const EXPLORER_TX = "https://explorer-studio-dev.genlayer.com/tx/";

const GEN = 10n ** 18n;
const DEPOSIT = 2n * GEN;
const MOVE = GEN / 2n;
const WITHDRAW = GEN;
const MIN_BALANCE = (26n * GEN) / 10n; // 2 GEN deposit + ~0.1 GEN fee per tx, with headroom
const MAX_FEE = GEN / 2n; // per transaction; keeps test spending small

function readKey() {
  if (!fs.existsSync(ENV_FILE)) return null;
  const line = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${KEY_VAR}=`));
  const value = line?.slice(KEY_VAR.length + 1).trim();
  return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
}

function formatGen(wei) {
  const whole = wei / GEN;
  const frac = (wei % GEN).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function balanceOf(address) {
  const res = await fetch(studioDevnet.rpcUrls.default.http[0], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return BigInt(body.result);
}

function wallet() {
  if (studioDevnet.id !== 61997) throw new Error(`Unexpected chain id ${studioDevnet.id}`);
  let key = readKey();
  if (key) {
    console.log("A test wallet already exists in .env.local (not replaced).");
  } else {
    key = generatePrivateKey();
    const prefix = fs.existsSync(ENV_FILE) && !fs.readFileSync(ENV_FILE, "utf8").endsWith("\n") ? "\n" : "";
    fs.appendFileSync(ENV_FILE, `${prefix}# Throwaway Day-0 test wallet, chain 61997 only. Never commit.\n${KEY_VAR}=${key}\n`);
    console.log("New throwaway test wallet created; key saved to .env.local only.");
  }
  console.log(`Public address: ${createAccount(key).address}`);
}

async function step(log, name, fn) {
  console.log(`\n== ${name}`);
  const entry = { step: name };
  try {
    Object.assign(entry, await fn());
    entry.ok = entry.ok ?? true;
  } catch (err) {
    entry.ok = false;
    entry.error = String(err?.shortMessage || err?.message || err);
  }
  log.push(jsonSafe(entry));
  console.log(JSON.stringify(log.at(-1), null, 2));
  return entry;
}

function summarize(receipt) {
  const leader = receipt?.consensus_data?.leader_receipt?.[0] ?? receipt?.consensus_data?.leader_receipt;
  return {
    status: receipt?.statusName ?? receipt?.status,
    result: receipt?.resultName ?? receipt?.result,
    execution: leader?.execution_result ?? receipt?.txExecutionResultName,
    returned: leader?.result ?? null,
    error: leader?.genvm_result?.stderr || leader?.error || null,
  };
}

async function run(resumeContract = null) {
  if (studioDevnet.id !== 61997) throw new Error(`Unexpected chain id ${studioDevnet.id}`);
  const key = readKey();
  if (!key) throw new Error("No test wallet. Run: node scripts/custody-probe.mjs wallet");
  const account = createAccount(key);
  const client = createClient({ chain: studioDevnet, account });
  const other = createAccount(generatePrivateKey()).address; // receives the internal move; key discarded

  const start = await balanceOf(account.address);
  console.log(`Wallet ${account.address} balance: ${formatGen(start)} GEN`);
  if (!resumeContract && start < MIN_BALANCE) throw new Error(`Need at least ${formatGen(MIN_BALANCE)} GEN on the test wallet.`);

  const log = [];
  // Studio Next rejects zero-fee transactions (FeeValueMustBeNonZero), so every tx carries an estimate.
  // Writes are estimated from a simulation (covers child messages such as withdraw's transfer);
  // if the simulation fails, fall back to a policy-only estimate and record why.
  const fees = async (write) => {
    let estimate;
    let estimateNote = null;
    if (write) {
      try {
        estimate = await client.estimateTransactionFeesForWrite(write);
      } catch (err) {
        estimateNote = `simulation estimate failed: ${String(err?.shortMessage || err?.message || err)}`;
      }
    }
    estimate ??= await client.estimateTransactionFees();
    if (estimate.feeValue > MAX_FEE) throw new Error(`Fee estimate ${formatGen(estimate.feeValue)} GEN exceeds the ${formatGen(MAX_FEE)} GEN cap.`);
    const { distribution, messageAllocations, feeValue } = estimate;
    return { fees: { distribution, messageAllocations, feeValue }, fee_gen: formatGen(feeValue), estimate_note: estimateNote };
  };
  const send = async (hashPromise, feeInfo) => {
    const hash = await hashPromise;
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({ hash, waitUntil: "decided", interval: 5000, retries: 120 });
    } catch (err) {
      return { tx: hash, explorer: EXPLORER_TX + hash, fee_gen: feeInfo.fee_gen, ok: false, error: `sent, but receipt read failed: ${String(err?.shortMessage || err?.message || err)}` };
    }
    const s = summarize(receipt);
    return { tx: hash, explorer: EXPLORER_TX + hash, fee_gen: feeInfo.fee_gen, estimate_note: feeInfo.estimate_note, ...s, ok: String(s.execution ?? "").toUpperCase().includes("SUCCESS") || s.execution === 1 };
  };
  const write = async (functionName, args, value) => {
    const req = { address: contract, functionName, args, ...(value ? { value } : {}) };
    const feeInfo = await fees(req);
    return send(client.writeContract({ ...req, fees: feeInfo.fees }), feeInfo);
  };
  // Studio Next contract reads (gen_call) can fail server-side; never let a failed read hide a sent tx.
  const view = async (address, functionName, args = []) => {
    try {
      return await client.readContract({ address, functionName, args });
    } catch (err) {
      return `read failed: ${String(err?.details || err?.shortMessage || err?.message || err).slice(0, 120)}`;
    }
  };
  const held = async () => formatGen(await balanceOf(contract));

  let contract = resumeContract;
  if (resumeContract) {
    console.log(`Resuming on contract ${contract} (deploy + deposit already done), native balance ${await held()} GEN`);
  } else {
  // Free pre-check: the runner rejects code the GenVM cannot parse (e.g. "runner malformed")
  // without charging anything, so never pay for a deploy that would fail this way.
  const schema = await step(log, "schema pre-check (free)", async () => ({
    methods: Object.keys((await client.getContractSchemaForCode(fs.readFileSync(CONTRACT, "utf8"))).methods ?? {}),
  }));
  if (!schema.ok) return finish(log, account.address, start);

  await step(log, "deploy custody_probe.py", async () => {
    const feeInfo = await fees(null);
    const r = await send(client.deployContract({ code: fs.readFileSync(CONTRACT, "utf8"), args: [], fees: feeInfo.fees }), feeInfo);
    const receipt = await client.getTransaction({ hash: r.tx });
    contract = receipt?.data?.contract_address ?? receipt?.recipient ?? receipt?.to_address ?? null;
    return { ...r, contract };
  });
  // A failed deploy still gets an address; never send value to it.
  if (!contract || !log.at(-1)?.ok) return finish(log, account.address, start);

  await step(log, `deposit ${formatGen(DEPOSIT)} GEN`, async () => ({
    ...(await write("deposit", [], DEPOSIT)),
    contract_native_gen: await held(),
    balance_of_me: await view(contract, "balance_of", [account.address]),
    total_held: await view(contract, "total_held"),
  }));

  if (!log.at(-1)?.ok) return finish(log, account.address, start, contract);
  }

  await step(log, `move_internal ${formatGen(MOVE)} GEN`, async () => ({
    ...(await write("move_internal", [other, MOVE])),
    to: other,
    contract_native_gen: await held(),
    balance_of_me: await view(contract, "balance_of", [account.address]),
    balance_of_other: await view(contract, "balance_of", [other]),
  }));

  await step(log, `withdraw ${formatGen(WITHDRAW)} GEN`, async () => {
    const before = await balanceOf(account.address);
    const r = await write("withdraw", [WITHDRAW]);
    const after = await balanceOf(account.address);
    return {
      ...r,
      contract_native_gen: await held(),
      wallet_delta_gen: (after < before ? "-" : "+") + formatGen(after < before ? before - after : after - before),
      balance_of_me: await view(contract, "balance_of", [account.address]),
      total_held: await view(contract, "total_held"),
    };
  });

  return finish(log, account.address, start, contract);
}

async function finish(log, address, start, contract = null) {
  const end = await balanceOf(address);
  const out = { chain: studioDevnet.id, wallet: address, contract, start_gen: formatGen(start), end_gen: formatGen(end), at: new Date().toISOString(), steps: log };
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWallet balance: ${formatGen(start)} -> ${formatGen(end)} GEN. Results: experiments/custody_probe_results.json`);
}

const cmd = process.argv[2];
const RESUME = process.argv[3];
if (cmd === "wallet") wallet();
else if (cmd === "resume" && /^0x[0-9a-fA-F]{40}$/.test(RESUME ?? "")) run(RESUME).catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
else if (cmd === "run") run().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
else console.log("Usage: node scripts/custody-probe.mjs wallet | run | resume <contract>");
