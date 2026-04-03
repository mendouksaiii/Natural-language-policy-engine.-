# SENTINEL — Natural Language Policy Engine

> Extending OWS's most important primitive: the pre-signing policy engine.  
> Agent spending policies written in **plain English**, evaluated by Claude in real time before every `ows_sign` call.

![SENTINEL Dashboard](https://img.shields.io/badge/OWS-Policy_Engine-00e5ff?style=for-the-badge) ![Claude Powered](https://img.shields.io/badge/Claude-Powered-ff6b35?style=for-the-badge) ![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

## The Problem

OWS ships with a policy engine — config files and code that enforce spending limits, contract allowlists, chain restrictions. It works, but it's rigid. You need a developer to change rules. The policies look like this:

```json
{ "max_spend": 20, "allowed_chains": ["base"], "blocked_days": [0, 6] }
```

## The Solution

Replace config files with plain English:

```
AGENT SPENDING POLICY
=====================
1. Only pay for API services, data feeds, and cloud infrastructure.
2. Never spend more than $20 on a single transaction.
3. Never transact on weekends (Saturday or Sunday).
4. Total daily spending must not exceed $50.
5. Only transact on the Base network.
6. If the agent has been inactive for 7 days, send all remaining funds to the backup wallet.
```

Every transaction is intercepted before `ows_sign`. Claude reads the transaction details alongside the policy document. It returns APPROVED or REJECTED with reasoning citing specific rules. Only an approval unlocks the wallet.

**A config file can't handle "unless." An LLM can.** That's the primitive we're extending.

## Architecture

```
Agent wants to spend
       ↓
Policy Engine intercepts
       ↓
Claude reads the tx + the policy doc
       ↓
├── APPROVED → ows_sign() → transaction signed → money moves
└── REJECTED → blocked → reason logged with rule citation
       ↓
Heartbeat checks last approved tx
       ↓
7 days silence → Dead Agent Switch → funds → backup wallet
```

## Four Components

| Component | What It Does |
|-----------|-------------|
| **OWS Wallet** | Agent's wallet. Funded with USDC. Can spend, but never without policy clearance. |
| **Policy Document** | Plain text file. Written like instructions to a person, not code. Editable live. |
| **Policy Engine** | Intercepts every `ows_sign` call. Sends tx + policy to Claude. Yes or no. |
| **Heartbeat Monitor** | Background clock. 7 days of silence triggers automatic fund recovery to backup wallet. |

## Demo

The dashboard shows four panels simultaneously:

- **Agent Wallet** — live balance, chain, spending tracking
- **Policy Document** — editable textarea, changes take effect immediately
- **Transaction Log** — real-time approvals/rejections with Claude's reasoning
- **Heartbeat Monitor** — countdown to dead agent switch with fast-forward for demo

### What You See

1. Agent spends $15 on an API → **APPROVED** ✅ (policy allows API services under $20)
2. Agent tries to buy an NFT for $50 → **REJECTED** ❌ (not an allowed category + over limit)
3. You edit the policy mid-demo → behavior changes instantly
4. You fast-forward the heartbeat → agent goes silent → funds auto-route to backup wallet

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/natural-language-policy-engine.git
cd natural-language-policy-engine
npm install

# Create .env with your LLM provider
echo "OPENROUTER_API_KEY=your_key_here" > .env

# Start
node server.js
# Open http://localhost:3000
```

### LLM Providers

| Provider | Env Variable | Model |
|----------|-------------|-------|
| OpenRouter (recommended) | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4-20250514` |
| Anthropic (direct) | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| Simulation (no key) | — | Built-in rule parser |

## Why This Matters

OWS defines the standard for how AI agents interact with wallets. The policy engine is its soul — it's what stands between an autonomous agent and your money.

Right now, policies are developer-written config. Natural language policies mean:

- **Non-technical operators** can define spending rules for their agents
- **Nuance and context** — "only for infrastructure, unless it's an emergency" is a valid rule
- **Instant iteration** — change a rule in English, behavior changes immediately
- **Auditability** — every decision comes with Claude's reasoning and rule citation
- **Safety by default** — the dead agent switch is just another rule in the same document

This isn't a wrapper around OWS. It's extending its most important primitive.

## Tech Stack

- **Backend**: Node.js, Express, WebSocket (ws)
- **Frontend**: Vanilla HTML/CSS/JS — no framework overhead
- **LLM**: Claude via OpenRouter/Anthropic API
- **Protocol**: OWS (Open Wallet Standard) mock interface

## License

MIT
