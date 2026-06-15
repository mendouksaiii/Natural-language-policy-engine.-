# SENTINEL — Codebase Context

**For Claude / contributors.** SENTINEL is an **on-chain AI policy firewall for autonomous agents, deployed on Mantle**, built for the Mantle Turing Hackathon (AI × on-chain).

## Mental model

A plain-English spending policy is evaluated by an LLM before every spend. On APPROVAL the policy-signer key produces a single-use **EIP-712** authorization; the on-chain `SentinelVault` verifies that signature before releasing funds. Every decision (approve and reject) is committed to the on-chain `SentinelRegistry`. The AI's decision is a cryptographic precondition, not an off-chain trust assumption.

## Layout

- **`contracts/`** — `SentinelVault.sol` (EIP-712-gated treasury, manual ECDSA recovery, replay-safe nonces), `SentinelRegistry.sol` (append-only audit log), `MockUSDC.sol` (test settlement token).
- **`scripts/`** — `genkey.js` (fresh Mantle Sepolia keys), `compile.js` (solc → `build/`), `deploy.js` (deploy + seed + write `deployments/mantle-sepolia.json`), `balance.js`.
- **`mantle.js`** — on-chain layer: live balances, EIP-712 signing (`signTypedData`), `vault.executeTransfer` relaying, registry logging. Reports `enabled:false` (off-chain preview) when no deployment exists.
- **`server.js`** — Express + WebSocket. `evaluatePolicy` (OpenRouter / Anthropic / deterministic `simulate` fallback) → `settleOnChain` → broadcast. Heartbeat dead-agent switch sweeps the vault on-chain.
- **`public/`** — vanilla HTML/CSS/JS war-room dashboard. WS events: `init`, `evaluating`, `transaction`, `wallet_update`, `heartbeat`, `dead_agent_switch`, `policy_updated`. Transactions carry `explorerUrl` / `registryUrl` for clickable Mantle links.
- **`policy.txt`** — the plain-English law.

## Network

Mantle Sepolia, chainId **5003**, RPC `https://rpc.sepolia.mantle.xyz`, explorer `https://explorer.sepolia.mantle.xyz`, faucet `https://faucet.sepolia.mantle.xyz`, gas = MNT.

## Conventions

Keep the frontend framework-free and the cyberpunk war-room aesthetic (Orbitron, orange/amber/red, scanlines). The narrative focus is **AI-enforced, on-chain spending governance on Mantle** — not the prior OWS/Purch framing.
