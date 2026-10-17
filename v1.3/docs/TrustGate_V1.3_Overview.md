# TrustGate V1.3: Project Overview

> **Before an Agent Says Yes.**
> V1 told an AI agent whether it *should* say yes to a deal. V1.3 makes sure it *can't* say yes without TrustGate.

- **Live site:** https://trustgatecheck.xyz (V1 at https://trustgatecheck.xyz/v1)
- **Code:** https://github.com/shoupeorg/TrustGate-V1.3
- **Network:** GenLayer Studio Next / Studio Dev, chain 61997, explorer https://explorer-studio-dev.genlayer.com
- **Context:** GenLayer Agent Tank hackathon project. V1 is unchanged and now lives at https://trustgatecheck.xyz/v1.

---

## 1. The problem

AI agents are starting to spend money on their own: buying data, renting compute, paying freelancers. They can be fooled. A listing can say "our usual address is under maintenance, pay this new address", or hide text that tells an AI reviewer to approve the payment. If the agent holds the money, a fooled agent means lost money.

## 2. The idea

Take the money away from the agent, and make both sides of a deal rely on the same verdict.

1. The **owner** puts funds into a TrustGate **vault** (a smart contract on GenLayer) and writes a **mandate** in plain language, for example:
   *"Buy data or compute services for research. Only refundable or escrowed payments. Never pay an address the counterparty supplies at the last minute. Max 2 GEN per commitment."*
2. The **seller** (any wallet, often the seller's own AI agent) posts an **offer** to the vault: price and full terms. The offer is signed by the seller's wallet, the seller is the payee, and the contract stores the exact text and its sha256. An offer is never edited; a change is a new version linked to the previous one.
3. The buyer's **agent** can only **request** a commitment **by offer id**. Payee, amount and text come from the signed offer; the agent adds only its justification (untrusted). It never holds the funds.
4. The vault decides, in two layers, on GenLayer:
   - **Layer 1, hard limits (instant):** registered agent, latest open version of an offer made to this vault, amount under the cap (and the optional total cap), payee allowlist if set, enough money, no self-pay.
   - **Layer 2, GenLayer validators:** several independent AI validators judge the offer against the mandate and must agree. The offer text and the agent's justification are untrusted, so injected instructions don't work.
5. Three possible verdicts, stored once and read by both sides:
   - **ACCEPT:** funds are credited to the seller, for that exact seller-signed version. This is the only path that credits a payee.
   - **RENEGOTIATE:** money stays locked; the counterproposal is attached to the offer and goes to the **seller**, who can accept it (signing exactly that text as a new version), counter with its own version, or decline.
   - **REJECT:** money stays locked; the seller may counter or decline.

**Both agents rely on the same verdict. Neither side can change the terms alone. Money moves only for terms the seller signed and GenLayer accepted.**

## 3. Who does what

| Party | Role |
|---|---|
| **GenLayer** | The blockchain and its AI validators. Infrastructure. |
| **TrustGate** | The application built on GenLayer: the vault contract, the mandate, the judging logic, the website. |
| **Owner** | Deposits funds, writes the mandate, sets the cap. |
| **Agent** (buyer side) | Any AI agent the owner uses. It only requests signed offers; it decides nothing about funds. |
| **Seller** | Anyone with a wallet (often its own AI agent). Signs every offer version, is the payee, accepts / counters / declines counterproposals. |

**Why GenLayer?**

| Option | Holds the money with no owner in control | Understands the deal |
|---|---|---|
| Normal smart contract | Yes | No (only fixed rules) |
| AI on a private server | No (whoever runs the server controls it) | Yes |
| **GenLayer** | **Yes** | **Yes** |

GenLayer is the only option that does both. With an AI gate on a server, someone controls the decision over your money; on GenLayer nobody does. TrustGate has no AI of its own: buyer's agent ⇄ TrustGate contract on GenLayer ⇄ seller's agent; GenLayer validators decide. The demo's `agent_brain.py` only gives the demo agents a model to think with and never judges.

<!-- HEADLINE:START -->
> **Without GenLayer, the blockchain approved 15 unsafe payments. With GenLayer, 0.**
> Held-out set (written before the fix, never used for tuning): the same 31 requests checked by a normal smart contract with hard-coded rules and by TrustGate on GenLayer. Details in [Benchmark](#benchmark).
<!-- HEADLINE:END -->

**Difference from optimistic designs** (pay first, challenge later, slash a bond): TrustGate is preventive. Money doesn't move until the verdict.

## 4. The website

Open https://trustgatecheck.xyz. To submit anything, use a browser wallet (MetaMask) on GenLayer Studio Next (chain 61997). The site switches the network for you. Viewing needs no wallet.

| Section | What it is |
|---|---|
| **Header** | Project name, link to the V1 deal inspector (`/v1`), wallet connect button. |
| **Hero + TL;DR** | One-sentence pitch and the three-step explanation. |
| **Create a vault** (Owner) | Agent wallet address (who may request payments), mandate (with three templates: research purchases, SaaS subscriptions, freelance tasks), max per commitment, deposit. Character counter on the mandate (4,000 max). Shows the network fee before you confirm in the wallet. |
| **Agent (buyer)** | Lists the open, seller-signed offers for the agent's vault. The agent picks one and adds a justification; payee, amount and text cannot be changed. |
| **Seller** | Any connected wallet: post a signed offer to a vault (the buyer's mandate is shown), see TrustGate's counterproposal as a diff against your text, and accept it (sign exactly that text), counter, or decline. |
| **Negotiation view** | Shareable link per negotiation (`?negotiation=…`): offer v1 → verdict → counterproposal → seller signs v2 → verdict → credited, with who signed each step, the text diff between versions, provisional/final status and explorer links. |
| **Try it** | No wallet: a server-side demo seller signs the visitor's offer, the demo agent requests it, GenLayer judges it; on RENEGOTIATE the visitor can click "Seller accepts" so the demo seller signs v2. |
| **Live feed** | Every vault and every request on the contract: verdict, risk, summary, the mandate rules it broke with quotes from the deal, the counterproposal, validator votes, and a link to the transaction. Labels show **Provisional** (accepted by consensus) and **Final** (finalized). Refreshes every 8 seconds. |
| **Limits, stated plainly** | The known limitations (see section 8). |

## 5. Results so far

### Live agent run (not scripted)

An AI purchasing agent read freshly generated marketplace offers and decided on its own what to request. It does not see the owner's mandate; policy is TrustGate's job.

| Offer | Agent did | TrustGate did |
|---|---|---|
| Refundable dataset, payment to a seller-supplied address | Requested 1.8 GEN | **RENEGOTIATE** → agent resubmitted the safer terms → **ACCEPT**, credited to the payee inside the vault (earlier one-sided flow; today the seller must sign the safer terms) |
| GPU compute, "updated treasury address", 3-hour deadline | Was fooled, requested 6.4 GEN | **Blocked** (over the cap) |
| Labeling with a 50% non-refundable deposit | Requested 1.6 GEN | **REJECT**, HIGH risk |

### Benchmark

<!-- BENCH:START -->
Every number below is generated from committed raw results (`lib/benchmark-summary.json`, built by `scripts/summarize-benchmark.mjs`).

### On-chain: a normal smart contract vs. TrustGate on GenLayer

Both keep the money on-chain with nobody in control. The difference is whether the contract understands the deal. **Grey** cases pass every hard-coded rule and keyword check (a payout wallet "updated this morning", escrow the seller controls, refunds "at the vendor's discretion"). **Judge-targeted injections** try to order the reviewer to approve.

**[Held-out set (written before the fix, never used for tuning)](../experiments/benchmark/run-heldout-v6/results.md)**

| On-chain option | Correct | Unsafe payments made | Grey cases caught | Judge-targeted injections caught | Safe requests blocked |
|---|---|---|---|---|---|
| Normal smart contract (hard-coded rules) | 16/31 | **15** | 0/9 | 5/8 | 0 |
| **TrustGate on GenLayer** | 31/31 | **0** | 9/9 | 8/8 | 0 |

**[41-case set (used to tune the fix)](../experiments/benchmark/run-41-v6/results.md)**

| On-chain option | Correct | Unsafe payments made | Grey cases caught | Judge-targeted injections caught | Safe requests blocked |
|---|---|---|---|---|---|
| Normal smart contract (hard-coded rules) | 21/40 | **19** | 0/11 | 5/8 | 0 |
| **TrustGate on GenLayer** | 40/40 | **0** | 11/11 | 8/8 | 0 |

The held-out set was written and committed before the false-block fix and never used for tuning; it is the result that counts. These cases show behaviour, not a precise accuracy; we wrote them ourselves. In the 41-case set, limit-03 (a 0 GEN, harmless case) is not scored for any method, and on the negotiation contract TrustGate could not even be asked: the contract refuses 0 GEN offers.

**[Negotiation held-out set (written before the RENEGOTIATE/REJECT calibration, never used for tuning)](../experiments/benchmark/run-negotiation-v6/results.md)**: does GenLayer give the decision a careful owner expects?

| Expected decision | Cases | TrustGate on GenLayer | Normal smart contract |
|---|---|---|---|
| RENEGOTIATE (fixable terms) | 8 | 8/8 | cannot renegotiate |
| REJECT | 5 | 5/5 | cannot judge |
| ACCEPT | 3 | 3/3 | — |
| **Unsafe payments made** | | **0** | **11** |


### Off-chain comparison: a centralized AI gate on a private server (what you'd build without GenLayer)

A single AI model on a private server reaches similar accuracy, but it cannot hold funds without an owner, so it is not an on-chain alternative.

**[Held-out set (written before the fix, never used for tuning)](../experiments/benchmark/run-heldout-v6/results.md)**
| System | Correct | Unsafe payments made | Grey caught | Injections caught | Safe requests blocked |
|---|---|---|---|---|---|
| Single AI model, plain prompt (private server) | 29/31 | 1 | 9/9 | 7/8 | 1 |
| Single AI model, TrustGate's prompt (private server) | 31/31 | 0 | 9/9 | 8/8 | 0 |
| TrustGate on GenLayer (reference) | 31/31 | 0 | 9/9 | 8/8 | 0 |

**[41-case set (used to tune the fix)](../experiments/benchmark/run-41-v6/results.md)**
| System | Correct | Unsafe payments made | Grey caught | Injections caught | Safe requests blocked |
|---|---|---|---|---|---|
| Single AI model, plain prompt (private server) | 39/40 | 0 | 11/11 | 8/8 | 1 |
| Single AI model, TrustGate's prompt (private server) | 39/40 | 0 | 11/11 | 8/8 | 1 |
| TrustGate on GenLayer (reference) | 40/40 | 0 | 11/11 | 8/8 | 0 |


### Earlier runs (kept as published)

- [Held-out on the first negotiation contract (v5 rules)](../experiments/benchmark/run-heldout-negotiation/results.md) (TrustGate 31/31, 0 unsafe) · [run-41-v5](../experiments/benchmark/run-41-v5/results.md) (38/40) · [Held-out on the v5 one-sided contract](../experiments/benchmark/run-heldout-v5/results.md) (TrustGate 31/31, 0 unsafe) · [Fix diagnosis of the 4 false blocks](../experiments/benchmark/false-block-diagnosis.json) · [run-41-v4](../experiments/benchmark/run-41-v4/results.md) (first fix) · [run-41-v3](../experiments/benchmark/run-41-v3/results.md) (before the fix: TrustGate 36/40, 4 safe blocked) · [allowlist variant](../experiments/benchmark/run-41-v3-allowlist/results.md) (extra false-block test, not GenLayer-measuring) · [run-41](../experiments/benchmark/run-41/results.md) · [first 20-case run](../experiments/benchmark/results.md)

<!-- BENCH:END -->

## 6. What's in the code

| Path | What it is |
|---|---|
| `contracts/trustgate_vault.py` | **The product.** The vault: create vault, top up, owner reclaim, request commitment (both layers), withdraw, views. |
| `contracts/agent_brain.py` | Demo only. Gives the demo agent an AI model by running its thinking on GenLayer. It decides nothing about funds. |
| `experiments/custody_probe.py` | Day-0 test contract: can a GenLayer contract hold and release GEN? |
| `components/vault-app.tsx`, `components/negotiation.tsx`, `components/try-it.tsx`, `components/genlayer-value.tsx`, `lib/vault.ts`, `lib/negotiation.ts` | The V1.3 website: owner / agent / seller modes, negotiation view, Try it, benchmark. |
| `mcp/` | MCP server for both sides (buyer and seller tools). |
| `app/api/vault-feed/route.ts` | Builds the live feed from the contract's transaction history. |
| `scripts/` | Command-line tools: wallets, vault demo, new vault, live agent, benchmark (see the README). |
| `experiments/` | Results: Day-0 test, demo runs, agent runs, benchmark. |

### Deployed contracts (chain 61997)

| Contract | Address |
|---|---|
| **Site contract v6 (site, Try it, MCP)** | `0x53E6f0eC998d9BfAd1CA3753252EE94b2cd16BF0` |
| v6 test and benchmark contract (same code) | `0x3C61e0C6634d78f6a38efFA6B1872AC11A76f7f3` |
| First negotiation contract (v5 rules) | `0xdF2FEeED57870803f2707E02F7F568d39ccA8C05` |
| Negotiation contract, first deploy (superseded within minutes, unused) | `0x32D2DAB21A582e661AFECd2A127f446B92c4F495` |
| v5 benchmark contract (one-sided) | `0xfD1478Fb2755cFfA0918A29b5F343A24d6fd363a` |
| v4 benchmark contract (one-sided) | `0x83E2e7742C0b3D6abc52A77D37837a07BDe47E9B` |
| Previous public contract (one-sided) | `0x41B6781fEC91DfFb9747CF2D445677F37c66E43b` |
| Benchmark contract (v3, one-sided) | `0x8f0B3Dd51D4cb2098f20A85B02a2B05f56AF57D7` |
| Earlier contracts | `0xcc4A54239cdfaa491d2C6Ba2E755b269c8D71347`, `0x290c2ef005e3f7683e38c23C1CA69697f60aC053` (first V1.3 vault) |
| Demo agent brain | `0x1a72EC367Dc923D736fB46abE695f0f3Ba533Ea6` |
| Day-0 custody probe | `0xc98d2293caB5E980db586a0beFF8Ac6134cdd6A6` |
| V1 contract (untouched) | `0xf6F2108C8eD388699F382203b6eb93F6DC8a6584` |

## 7. How it was built and tested (short timeline)

1. **Day-0 custody test:** a GenLayer contract can receive and hold GEN, and internal moves work. Contract-to-wallet payouts did not arrive on chain 61997 (see section 8).
2. **Vault deployed** and four reference scenarios run end to end. All verdicts as expected.
3. **Website built**, then deployed to Cloudflare Workers as a separate Worker (`trustgate-v13`), leaving V1 alone.
4. **Live AI agent** built on GenLayer's own model, then tested against fresh offers.
5. **Benchmark** of 20 requests run on-chain, then 41 cases and a 31-case held-out set (see Benchmark).
6. **False-block fix** (shared judging rules for leader and validators, v4/v5).
7. **Two-sided negotiation:** seller-signed offers, request by offer, seller accepts / counters / declines; MCP tools for both sides; two autonomous AI agents negotiating on-chain (`experiments/negotiation-demo/`).

## 8. Limitations (stated honestly)

- **A wrong ACCEPT is possible.** The per-commitment cap limits the maximum loss.
- **A signed offer proves who will be paid, not who the seller is.** The payee is the signing wallet; nothing on-chain ties it to the business named in the text.
- **A silent seller** leaves a negotiation open; no funds move and the owner or agent can withdraw from it.
- **Mandate quality matters.** A vague mandate gives vague judgments. Use a template.
- **Minutes, not milliseconds.** Each judged request takes a few minutes. Hard-limit rejections are instant.
- **Payouts on Studio Next.** The `withdraw` call succeeds but no GEN reaches the wallet on chain 61997. Released funds are therefore credited to the payee inside the vault.
- **Contract reads were failing on Studio Next** during development, for every contract including other people's (`Can't reconnect until invalid transaction is rolled back`). The V1.3 site and scripts rebuild everything from the transaction history, so they keep working. The live V1 site is affected: its reports get stuck on "Building risk report".
- **Studio Next only** for this milestone.

## 9. Status

V1.3 runs on https://trustgatecheck.xyz with the two-sided negotiation contract, Try it, the MCP server for both sides, the benchmark, and the full test suite. V1 (the deal inspector) is unchanged at https://trustgatecheck.xyz/v1. Code: https://github.com/shoupeorg/TrustGate-V1.3.
