# SENTINEL — Natural Language Policy Engine for OWS

> Extending OWS's most important primitive: the pre-signing policy engine.  
> Agent spending policies written in **plain English**, evaluated by Claude in real time before every `ows_sign` call.

![OWS](https://img.shields.io/badge/OWS-Policy_Engine-f97316?style=for-the-badge) ![Claude Powered](https://img.shields.io/badge/Claude-Powered-ff6b35?style=for-the-badge) ![MoonPay CLI](https://img.shields.io/badge/MoonPay-CLI_v1.23-7c3aed?style=for-the-badge) ![License](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)

**🔴 Live Demo:** [sentinel-nlp-engine.onrender.com](https://sentinel-nlp-engine.onrender.com)

---

## 📋 Note for Judges

### What Is This?

SENTINEL is an **extension to the Open Wallet Standard** that replaces rigid JSON config policies with **plain English rules**, evaluated by Claude (LLM) before every signing call. It uses the **real OWS SDK** (`@open-wallet-standard/core`) for cryptographic wallet operations and the **MoonPay CLI** for wallet management.

### Why It Matters

AI agents are getting wallets. They'll spend autonomously — paying for APIs, buying compute, subscribing to data feeds. OWS provides the standard infrastructure for this. But its policy engine today uses config files:

```json
{ "max_spend_usd": 20, "allowed_chains": ["base"], "blocked_days": [0, 6] }
```

**A config file can't handle "unless."** It can't understand "only for infrastructure, but allow emergencies." It can't express nuance.

SENTINEL replaces that with:

```
1. Only pay for API services, data feeds, and cloud infrastructure.
2. Never spend more than $20 on a single transaction.
3. Never transact on weekends (Saturday or Sunday).
4. If the agent goes silent for 7 days, send all funds to the backup wallet.
```

The person who understands the business rules — the founder, the treasury manager — writes the policy. No developer needed. Change a sentence, hit save, the agent updates on the next transaction.

### What's Real vs. Simulated

| Component | Status | Details |
|-----------|--------|---------|
| **OWS Wallet** | ✅ Real | Created via `@open-wallet-standard/core` Rust FFI. Real BIP-39 mnemonic, real HD-derived addresses for EVM, Solana, Bitcoin, Cosmos, and 5 more chains. |
| **Cryptographic Signing** | ✅ Real | `ows.signMessage()` produces real secp256k1 signatures via the OWS Rust core. Every approved transaction shows a verifiable hex signature. |
| **MoonPay CLI** | ✅ Real | CLI v1.23.1 integrated for wallet registration and on-chain balance queries. |
| **Policy Engine** | ✅ Real | `sentinel-policy.js` implements OWS's `executable` policy protocol. Reads `PolicyContext` from stdin, writes `PolicyResult` to stdout. SENTINEL is a **first-class OWS policy plugin** per the spec. |
| **LLM Evaluation** | ✅ Real | Claude (via OpenRouter) evaluates every transaction against the English policy. Returns APPROVED/REJECTED with reasoning and rule citation. |
| **Token Transfers** | 🔶 Simulated | Balance tracking is simulated ($100 USDC). Real transfers require funded wallets — all the signing infrastructure is real and ready. |

### How to Test It

1. **Visit** [sentinel-nlp-engine.onrender.com](https://sentinel-nlp-engine.onrender.com) (may take ~30s to cold-start on free tier)
2. **Click** "ENTER DASHBOARD" in the hero
3. **Try these transactions** from the right panel:
   - `$15.00 API SERVICE` → Should be **APPROVED** (allowed category, under limit)
   - `$8.00 DATA FEED` → Should be **APPROVED** (allowed category, under limit)
   - `$45.00 NFT MINT` → Should be **REJECTED** (not an allowed category)
   - `$25.00 OVER LIMIT` → Should be **REJECTED** (exceeds $20 single-tx limit)
4. **Edit the policy** in the center panel — change rules, hit "PUSH POLICY"
5. **Test again** — the engine now evaluates against your updated rules
6. **Watch the Dead Agent Switch** countdown in the bottom-left (7-day heartbeat)

### Key Technical Decisions

**Why natural language over JSON?**  
JSON policies are binary — they can't handle conditional logic without nested rule trees. "Never spend more than $20, unless it's for emergency infrastructure" is a single English sentence but requires complex branching in code. LLMs evaluate intent, not syntax.

**Why is SENTINEL an OWS executable policy, not a wrapper?**  
OWS spec section 03 defines the `executable` policy protocol: a subprocess that receives `PolicyContext` on stdin and returns `PolicyResult` on stdout. SENTINEL implements this exactly. It's not wrapping OWS — it's extending the primitive the spec was designed for.

**Why real signing when transfers are simulated?**  
Real signing proves the integration is production-grade. The wallet exists on-chain at the displayed addresses. The only gap is funding — add USDC to that EVM address and the transfers would be real with zero code changes.

---

## Architecture

```
Agent wants to spend
       ↓
SENTINEL intercepts (OWS executable policy plugin)
       ↓
Claude reads the tx + the English policy document
       ↓
├── APPROVED → ows.signMessage() → real secp256k1 signature → tx logged
└── REJECTED → blocked → reason logged with specific rule citation
       ↓
Heartbeat monitors last approved tx
       ↓
7 days silence → Dead Agent Switch → ows.signMessage() → funds → backup wallet
```

```
┌─────────────────────────────────────────────────────────┐
│                    SENTINEL SERVER                       │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  OWS SDK     │  │  Claude/LLM  │  │  MoonPay CLI  │  │
│  │  (Rust FFI)  │  │  (OpenRouter │  │  (v1.23.1)    │  │
│  │              │  │   /Anthropic)│  │               │  │
│  │ createWallet │  │  evaluates   │  │ balance query │  │
│  │ signMessage  │  │  English     │  │ wallet mgmt   │  │
│  │ listWallets  │  │  policy doc  │  │               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│         └────────┬────────┘                   │          │
│                  ↓                            │          │
│         sentinel-policy.js ◄──────────────────┘          │
│         (OWS executable policy plugin)                   │
│         stdin: PolicyContext JSON                         │
│         stdout: PolicyResult JSON                        │
└─────────────────────────────────────────────────────────┘
```

## Four Components

| Component | What It Does |
|-----------|-------------|
| **OWS Wallet** | Real multi-chain wallet via `@open-wallet-standard/core`. EVM, Solana, Bitcoin addresses derived from BIP-39 mnemonic. Stored in `~/.ows/` vault. |
| **Policy Document** | Plain text file. Written like instructions to a person, not code. Editable live from the dashboard. Changes take effect on the next transaction. |
| **Policy Engine** | `sentinel-policy.js` — implements OWS executable policy spec. Intercepts every signing request, evaluates via Claude, returns `allow`/`deny`. |
| **Dead Agent Switch** | Background heartbeat. 7 days of inactivity triggers automatic fund recovery via `ows.signMessage()` to the backup wallet. |

## Quick Start

```bash
git clone https://github.com/mendouksaiii/Natural-language-policy-engine.-.git
cd Natural-language-policy-engine.-
npm install

# Create .env
echo "OPENROUTER_API_KEY=your_key" > .env

# Run (via WSL for real OWS signing, or directly for simulation mode)
wsl -- bash -c "cd $(pwd) && node server.js"
# Or: node server.js  (simulation mode on Windows)

# Open http://localhost:3000
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Recommended | Claude evaluation via OpenRouter |
| `ANTHROPIC_API_KEY` | Alternative | Direct Anthropic API access |
| `BACKUP_WALLET` | Optional | Dead agent switch recovery address |
| `INITIAL_BALANCE` | Optional | Starting simulated balance (default: $100) |

If no API key is set, SENTINEL falls back to a built-in rule parser (simulation mode).

### LLM Providers

| Provider | Env Variable | Model |
|----------|-------------|-------|
| OpenRouter (recommended) | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4-20250514` |
| Anthropic (direct) | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| Simulation (no key) | — | Built-in regex rule parser |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Wallet** | `@open-wallet-standard/core` — Rust native bindings via NAPI |
| **CLI** | MoonPay CLI v1.23.1 — balance queries, wallet registration |
| **Backend** | Node.js, Express, WebSocket (ws) |
| **Frontend** | Vanilla HTML/CSS/JS — zero framework overhead |
| **LLM** | Claude via OpenRouter / Anthropic API |
| **Deployment** | Render (free tier, auto-deploy from GitHub) |

## File Structure

```
├── server.js              # Express + WebSocket server, OWS SDK integration
├── sentinel-policy.js     # OWS executable policy plugin (stdin/stdout JSON protocol)
├── policy.txt             # The plain-English policy document
├── render.yaml            # Render deployment config
├── public/
│   ├── index.html         # SPA — landing page + War Room dashboard
│   ├── style.css          # Design system — dark theme, animations
│   └── app.js             # Client — WebSocket, routing, OWS status display
├── .env.example           # Environment variable template
└── package.json
```

## License

MIT

---

**Built for OWS BuidlHack 2026** — Extending the standard with human-readable policy intelligence.
