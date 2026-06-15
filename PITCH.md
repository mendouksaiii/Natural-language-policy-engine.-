# SENTINEL — Project Pitch

**Mantle Turing Hackathon · AI × on-chain**

## One line

SENTINEL turns a plain-English spending policy into a smart contract on Mantle: an AI reads the policy, and its approval becomes the cryptographic key that lets an autonomous agent's vault move money — no approval, no spend.

## The problem

AI agents now hold and spend their own crypto. The guardrails around that money are JSON config files evaluated **off-chain**, in the same backend an attacker would compromise. Own the process, own the policy, drain the wallet. As agents scale, "trust the off-chain check" is not a security model.

## What we built

A firewall that sits between an agent and its on-chain treasury, in two halves:

1. **Policy in English.** A treasury manager writes rules as sentences ("never exceed $50 on a single transaction"; "never pay BlockedVendor"; "sweep to backup if idle 7 days"). Editable live — change a sentence, the next transaction obeys it. No redeploy.
2. **Enforcement on Mantle.** An LLM judges each spend against the policy. On approval it signs a single-use **EIP-712** authorization. Our `SentinelVault` contract on Mantle verifies that signature on-chain before releasing funds. Every decision — approve *and* reject — is committed to an on-chain `SentinelRegistry` as a tamper-evident audit trail.

The key property: **the AI's decision is a cryptographic precondition enforced by the EVM.** Not the agent, not the relayer, not a hacked backend can move funds without a valid AI approval.

## Why it's novel

It reframes the LLM as an **on-chain co-signer** of an agent's treasury, and pairs it with a public, immutable log of how autonomous capital was governed. That's a new AI × Web3 primitive, not a wrapper.

## Why Mantle

Deployed natively on Mantle Sepolia (chainId 5003), MNT for gas, real on-chain settlement with explorer-verifiable transactions. The `PolicyGuard` + `Registry` pattern is reusable: any agent treasury on Mantle can drop a human-readable, AI-enforced firewall in front of its money. As the agentic economy lands on Mantle, every autonomous wallet needs exactly this.

## Status

- 3 Solidity contracts (vault with manual ECDSA/EIP-712 verification + replay-safe nonces, audit registry, test USDC), dependency-light solc build.
- Full Node backend: live balance reads, LLM evaluation (OpenRouter/Claude) with a no-API-key fallback, EIP-712 signing, on-chain relaying.
- Live WebSocket "war-room" dashboard with real explorer links, policy editor, red-team mode, and a working dead-agent switch.
- One-command run; one-command deploy (`npm run genkey` → faucet → `npm run deploy:mantle`).

## Ask / roadmap

Production hardening: per-agent vault factory, multi-sig over the policy-signer key, native USDC on Mantle mainnet, and a published `PolicyGuard` module + SDK so any Mantle agent team can adopt the firewall in an afternoon.
