# SENTINEL — On-chain AI Policy Firewall for Autonomous Agents

> **A natural-language spending policy, enforced as a cryptographic precondition by a smart contract on Mantle.**
> The AI's decision isn't advice — without its EIP-712 approval, the agent's vault physically cannot move funds.

![Mantle](https://img.shields.io/badge/Mantle-Sepolia_5003-65B3AE?style=for-the-badge)
![EIP-712](https://img.shields.io/badge/EIP--712-AI_co--signer-f97316?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)

Built for the **Mantle Turing Hackathon** — AI × on-chain.

---

## The problem

Autonomous AI agents are getting their own treasuries — they pay for APIs, compute, data, and oracle queries and settle on-chain with no human in the loop. The only thing standing between an agent (or a *hijacked* agent) and a drained wallet today is a rigid JSON config, checked **off-chain, inside the very process an attacker is trying to compromise.** If the backend is owned, the policy is owned.

## The idea

SENTINEL separates **policy** from **enforcement**:

- **Policy** is a plain-English document a treasury manager edits — no JSON, no redeploy.
- **Enforcement** is a smart contract on Mantle.

An LLM reads the policy and the proposed spend and decides. When — and only when — it **approves**, the policy-signer key produces a single-use **EIP-712** authorization bound to `{token, recipient, amount, purposeHash, nonce, deadline}`. The on-chain `SentinelVault` verifies that signature before releasing a cent.

**Consequence:** the agent itself, the relayer that pays gas, and any compromised backend **cannot move funds without a valid AI approval.** The model's decision is enforced by the EVM on Mantle, not trusted off-chain.

---

## Architecture

```
   Agent intent ($42 for compute)
            │
            ▼
   ┌──────────────────┐     plain-English policy.txt
   │  SENTINEL node   │◀────────────────────────────────
   │  (server.js)     │
   │                  │   1. LLM evaluates intent vs policy  (OpenRouter / Claude)
   │                  │   2. APPROVED → policy-signer signs EIP-712 approval
   │                  │   3. relayer submits vault.executeTransfer(...)
   └────────┬─────────┘   4. logDecision(...) → on-chain audit (approve AND reject)
            │
            ▼  (Mantle Sepolia · chainId 5003)
   ┌──────────────────┐        ┌─────────────────────┐
   │  SentinelVault   │        │  SentinelRegistry   │
   │  • holds USDC/MNT│        │  • append-only      │
   │  • verifies the  │        │    decision log     │
   │    EIP-712 sig   │        │  • tamper-evident   │
   │  • single-use    │        │    audit trail      │
   │    nonces        │        └─────────────────────┘
   └──────────────────┘
```

### Contracts (`contracts/`)

| Contract | Role |
|---|---|
| **`SentinelVault.sol`** | The agent's on-chain treasury. `executeTransfer` / `executeNativeTransfer` release funds **only** against a valid, unexpired, single-use EIP-712 approval signed by the configured `policySigner`. Manual ECDSA recovery, replay-safe nonces, domain-bound to chain 5003. |
| **`SentinelRegistry.sol`** | Append-only, tamper-evident audit log. Every decision — **approve and reject** — commits `keccak256(policyVersion, txParams, decision, reason)` on-chain. The reusable "policy audit trail" primitive other Mantle agent projects can adopt. |
| **`MockUSDC.sol`** | 6-decimal test settlement token so judges can reproduce the full demo without hunting a faucet token. Swap for canonical USDC on mainnet — the contracts are asset-agnostic. |

### Off-chain (`server.js`, `mantle.js`)

- Reads live vault balances from Mantle.
- Runs the natural-language policy through an LLM (OpenRouter / Claude), with a deterministic fallback so the demo runs with **no API key**.
- Signs EIP-712 approvals and relays real Mantle transactions, returning real tx hashes + explorer links.
- WebSocket dashboard (`public/`) streams every decision, signature, and on-chain settlement live.

---

## Quick start

```bash
npm install                 # also compiles the contracts (postinstall)
cp .env.example .env

# 1. Generate fresh throwaway Mantle Sepolia keys
npm run genkey              # prints a DEPLOYER address to fund

# 2. Fund the printed deployer at https://faucet.sepolia.mantle.xyz
npm run fund:check          # confirm MNT arrived

# 3. Deploy to Mantle Sepolia (vault, registry, mock USDC; seeds 25k USDC)
npm run deploy:mantle       # writes deployments/mantle-sepolia.json

# 4. (optional) add OPENROUTER_API_KEY to .env for live AI evaluation

# 5. Run
npm start                   # http://localhost:3000
```

**No deployment yet?** The app still runs in **off-chain preview** mode — the dashboard, policy editing, AI evaluation, and the rejection logic all work; only the on-chain settlement is stubbed until you deploy.

---

## Demo flow

1. Open the dashboard → **Enter War Room**.
2. The **Agent Spend Simulator** fires transactions at the firewall:
   - `$42 compute` → **approved**, signed, **settled on Mantle** (click the tx hash → explorer).
   - `$150 BlockedVendor` → **rejected** by rule 3; the rejection is still committed on-chain to the audit registry.
   - `$5 search` → **rejected** by the per-search cap.
3. **Red Team Mode** sweeps adversarial probes (just-under-limit, oversized, blocked-vendor) to show the firewall holding.
4. Edit the **policy document** in plain English, hit **Push Policy** — the next transaction is judged against the new rule, no redeploy.
5. The **Dead-Agent Switch** countdown sweeps the vault to the backup wallet on-chain if the agent goes silent (`/api/heartbeat/fast-forward` to demo it instantly).

---

## How this maps to the judging criteria

| Dimension | Where it shows up |
|---|---|
| **Technical Depth** (AI × on-chain) | The AI's decision is an on-chain precondition: LLM → EIP-712 signature → contract-verified `executeTransfer`. Three Solidity contracts, manual ECDSA recovery, replay-safe nonces, dependency-light solc build. |
| **Innovation** | A new paradigm — *AI as an on-chain co-signer.* Natural-language policy whose enforcement is cryptographic, plus a tamper-evident on-chain log of every autonomous spending decision. |
| **Mantle Ecosystem Contribution** | Native Mantle deployment (chainId 5003), MNT gas, real on-chain settlement. The `PolicyGuard` + `Registry` pattern is a reusable primitive any agent treasury on Mantle can adopt. |
| **Product Completeness** | One-command run, live WebSocket war-room UI, runnable with or without an API key, real explorer-linked transactions, deploy script + faucet flow documented. |

---

## Project layout

```
contracts/        SentinelVault.sol · SentinelRegistry.sol · MockUSDC.sol
scripts/          genkey · compile (solc) · deploy · balance
mantle.js         on-chain layer: balances, EIP-712 signing, relaying, audit log
server.js         policy engine + LLM evaluation + WebSocket dashboard
public/           vanilla HTML/CSS/JS war-room dashboard
deployments/      mantle-sepolia.json (written by deploy)
PITCH.md          one-page project pitch
```

## License

MIT
