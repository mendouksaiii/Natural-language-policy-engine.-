import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import 'dotenv/config';

import {
  initMantle,
  resolveRecipient,
  txUrl,
  addrUrl,
  Decision
} from './mantle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
const LLM_PROVIDER = process.env.OPENROUTER_API_KEY ? 'openrouter'
  : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'simulation';

// Backup wallet for the dead-agent switch — must be a valid address for a real sweep.
const BACKUP_WALLET = ethers.isAddress(process.env.BACKUP_WALLET || '')
  ? ethers.getAddress(process.env.BACKUP_WALLET)
  : resolveRecipient('sentinel-backup-treasury');

// ─── Mantle on-chain layer ───────────────────────────────
let mantle = null;

// ─── State ───────────────────────────────────────────────
let walletState = {
  address: null,            // vault address on Mantle
  balance: 0,               // live on-chain USDC balance
  mnt: 0,                   // live on-chain MNT balance
  chain: 'Mantle Sepolia',
  lastTransaction: null,
  totalSpentToday: 0,
  transactions: []
};

const policyPath = join(__dirname, 'policy.txt');
let policyText = existsSync(policyPath) ? readFileSync(policyPath, 'utf-8') : 'No policy defined.';

let heartbeat = {
  lastApprovedTx: Date.now(),
  thresholdMs: 7 * 24 * 3600000,
  isTriggered: false
};

// ─── WebSocket ───────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function chainStatus() {
  const s = mantle ? mantle.status() : { enabled: false, reason: 'booting' };
  return { ...s, backupWallet: BACKUP_WALLET };
}

function initPayload() {
  return {
    wallet: walletState,
    policy: policyText,
    heartbeat: hbData(),
    llmProvider: LLM_PROVIDER,
    chain: chainStatus()
  };
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', data: initPayload(), timestamp: Date.now() }));
});

// ─── Live balance refresh ────────────────────────────────
async function refreshBalances() {
  if (!mantle?.enabled) return;
  try {
    const b = await mantle.balances();
    if (b) {
      walletState.balance = b.usdc;
      walletState.mnt = b.mnt;
    }
  } catch (e) {
    console.error('[mantle] balance refresh failed:', e.message);
  }
}

// ─── LLM Policy Evaluation ──────────────────────────────
async function evaluatePolicy(tx) {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });

  const sys = `You are SENTINEL, a strict on-chain spending-policy evaluator for an autonomous AI agent's wallet on Mantle. Read the plain-English policy and decide if the proposed transaction is allowed. Be strict and literal — when a rule is violated, REJECT. Respond ONLY with compact JSON: {"decision":"APPROVED" or "REJECTED","reason":"one sentence","rule_matched":"the exact rule text you applied"}`;

  const user = `POLICY:\n---\n${policyText}\n---\n\nTRANSACTION:\n- Amount: $${tx.amount.toFixed(2)} USDC\n- Recipient: ${tx.recipient}\n- Purpose: ${tx.purpose}\n- Chain: Mantle Sepolia\n- Time: ${now.toISOString()} (${day})\n- Vault balance: $${walletState.balance.toFixed(2)} USDC\n- Spent today: $${walletState.totalSpentToday.toFixed(2)}\n\nAPPROVED or REJECTED?`;

  if (LLM_PROVIDER === 'openrouter') return callOpenRouter(sys, user, tx);
  if (LLM_PROVIDER === 'anthropic') return callAnthropic(sys, user, tx);
  return simulate(tx);
}

async function callOpenRouter(sys, user, tx) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'X-Title': 'SENTINEL Policy Engine'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        max_tokens: 300
      })
    });
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : simulate(tx);
  } catch (e) { console.error('[LLM]', e.message); return simulate(tx); }
}

async function callAnthropic(sys, user, tx) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 300, system: sys, messages: [{ role: 'user', content: user }] })
    });
    const d = await r.json();
    const text = d.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : simulate(tx);
  } catch (e) { console.error('[LLM]', e.message); return simulate(tx); }
}

// Deterministic fallback so the demo always runs without an API key.
function simulate(tx) {
  const pol = policyText.toLowerCase();

  const searchLimitM = pol.match(/max cost \$([\d.]+) usdc per search/i);
  if (searchLimitM && (tx.purpose || '').toLowerCase().includes('search') && tx.amount > parseFloat(searchLimitM[1]))
    return { decision: 'REJECTED', reason: `Search cost $${tx.amount.toFixed(2)} exceeds the $${searchLimitM[1]} per-search limit.`, rule_matched: `max cost $${searchLimitM[1]} USDC per search` };

  const limitM = pol.match(/never exceed \$(\d+) on a single (?:item|transaction|payment)/i);
  if (limitM && tx.amount > parseFloat(limitM[1]))
    return { decision: 'REJECTED', reason: `$${tx.amount.toFixed(2)} exceeds the $${limitM[1]} single-transaction limit.`, rule_matched: limitM[0] };

  const blockedM = pol.match(/never (?:pay|purchase|transact)[^"]*"([^"]+)"/i);
  if (blockedM && (`${tx.purpose} ${tx.recipient}`).toLowerCase().includes(blockedM[1].toLowerCase()))
    return { decision: 'REJECTED', reason: `Recipient "${blockedM[1]}" is explicitly blocked by policy.`, rule_matched: blockedM[0] };

  const dailyM = pol.match(/daily spending must not exceed \$(\d+)/i);
  if (dailyM && (walletState.totalSpentToday + tx.amount) > parseFloat(dailyM[1]))
    return { decision: 'REJECTED', reason: `Would push today's spend to $${(walletState.totalSpentToday + tx.amount).toFixed(2)}, over the $${dailyM[1]} daily cap.`, rule_matched: dailyM[0] };

  if (tx.amount > walletState.balance)
    return { decision: 'REJECTED', reason: `Insufficient vault balance ($${walletState.balance.toFixed(2)} available).`, rule_matched: 'Cannot spend more than the vault holds.' };

  return { decision: 'APPROVED', reason: `$${tx.amount.toFixed(2)} for "${tx.purpose}" satisfies every policy rule.`, rule_matched: 'Transaction within all policy limits.' };
}

// ─── Execute an approved transaction on Mantle ──────────
async function settleOnChain(tx, decision) {
  // Always commit the decision to the on-chain audit registry.
  const to = resolveRecipient(tx.recipient);
  let onchain = { settled: false };

  if (decision.decision === 'APPROVED') {
    if (mantle?.enabled) {
      const exec = await mantle.executeTransfer({ to, usd: tx.amount, purpose: tx.purpose });
      onchain = {
        settled: true,
        recipient: to,
        txHash: exec.txHash,
        explorerUrl: txUrl(exec.txHash),
        block: exec.blockNumber,
        nonce: exec.nonce,
        signature: exec.signature,
        sigMethod: 'eip712_policy_signature'
      };
    } else {
      onchain = { settled: false, recipient: to, sigMethod: 'offchain-preview', note: 'On-chain layer disabled — deploy to Mantle to settle for real.' };
    }
  }

  // Audit log (best-effort) for BOTH approve and reject.
  if (mantle?.enabled) {
    const rec = await mantle.logDecision({
      decision: decision.decision === 'APPROVED' ? Decision.APPROVED : Decision.REJECTED,
      to, usd: tx.amount, purpose: tx.purpose, policyText, reason: decision.reason
    });
    if (rec && rec.txHash) {
      onchain.registryTxHash = rec.txHash;
      onchain.registryUrl = txUrl(rec.txHash);
      onchain.recordId = rec.recordId;
    }
  }
  return onchain;
}

// ─── Heartbeat / Dead-Agent Switch ──────────────────────
function hbData() {
  const elapsed = Date.now() - heartbeat.lastApprovedTx;
  const remaining = Math.max(0, heartbeat.thresholdMs - elapsed);
  return {
    lastActivity: heartbeat.lastApprovedTx, elapsed, remaining, threshold: heartbeat.thresholdMs,
    status: heartbeat.isTriggered ? 'TRIGGERED' : remaining <= 0 ? 'CRITICAL' : remaining < heartbeat.thresholdMs * 0.25 ? 'WARNING' : 'ACTIVE',
    isTriggered: heartbeat.isTriggered
  };
}

async function triggerDeadSwitch() {
  if (heartbeat.isTriggered) return;
  await refreshBalances();
  if (walletState.balance <= 0) return;
  heartbeat.isTriggered = true;

  const amount = walletState.balance;
  const tx = { amount, recipient: BACKUP_WALLET, purpose: 'Dead Agent Switch — automatic fund recovery' };
  const decision = {
    decision: 'APPROVED',
    reason: 'Heartbeat threshold exceeded; sweeping vault to the backup wallet per policy.',
    rule_matched: 'If the agent is inactive for 7 days, send all remaining funds to the backup wallet.'
  };
  const onchain = await settleOnChain(tx, decision);

  const rec = buildRecord(`tx_${Date.now()}`, tx, { ...decision, decision: 'AUTO-EXECUTED' }, onchain, true);
  walletState.transactions.push(rec);
  walletState.lastTransaction = Date.now();
  await refreshBalances();

  broadcast('dead_agent_switch', rec);
  broadcast('transaction', rec);
  broadcast('wallet_update', walletState);
  broadcast('heartbeat', hbData());
}

setInterval(() => {
  const hb = hbData();
  broadcast('heartbeat', hb);
  if (hb.remaining <= 0 && !heartbeat.isTriggered) triggerDeadSwitch();
}, 2000);

// Periodically refresh on-chain balances into the dashboard.
setInterval(async () => {
  if (!mantle?.enabled) return;
  const before = walletState.balance;
  await refreshBalances();
  if (walletState.balance !== before) broadcast('wallet_update', walletState);
}, 15000);

// ─── Record builder ──────────────────────────────────────
function buildRecord(id, tx, evaluation, onchain, isEmergency = false) {
  return {
    id,
    amount: tx.amount,
    recipient: onchain.recipient || tx.recipient,
    recipientLabel: tx.recipient,
    purpose: tx.purpose,
    chain: 'Mantle Sepolia',
    decision: evaluation.decision,
    reason: evaluation.reason,
    rule_matched: evaluation.rule_matched,
    timestamp: new Date().toISOString(),
    onchain,
    txHash: onchain.txHash || null,
    explorerUrl: onchain.explorerUrl || null,
    registryTxHash: onchain.registryTxHash || null,
    registryUrl: onchain.registryUrl || null,
    isEmergency
  };
}

// ─── Routes ──────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

app.get('/api/state', (_, res) => res.json(initPayload()));

app.get('/api/chain', (_, res) => res.json(chainStatus()));

app.post('/api/policy', (req, res) => {
  policyText = req.body.text;
  writeFileSync(policyPath, policyText, 'utf-8');
  broadcast('policy_updated', { text: policyText });
  res.json({ success: true });
});

async function handleTransaction(req, res) {
  const { amount, recipient, purpose } = req.body;
  const tx = { amount: parseFloat(amount), recipient: recipient || 'Unknown vendor', purpose: purpose || 'unspecified' };
  const txId = `tx_${Date.now()}`;
  broadcast('evaluating', { txId, amount: tx.amount, purpose: tx.purpose });

  const evaluation = await evaluatePolicy(tx);
  const onchain = await settleOnChain(tx, evaluation);

  if (evaluation.decision === 'APPROVED' && onchain.settled) {
    walletState.totalSpentToday += tx.amount;
    walletState.lastTransaction = Date.now();
    heartbeat.lastApprovedTx = Date.now();
    heartbeat.isTriggered = false;
    await refreshBalances();
  }

  const rec = buildRecord(txId, tx, evaluation, onchain);
  walletState.transactions.push(rec);

  broadcast('transaction', rec);
  broadcast('wallet_update', walletState);
  broadcast('heartbeat', hbData());

  if (evaluation.decision === 'REJECTED') return res.status(403).json(rec);
  res.json(rec);
}

app.post('/api/transact', handleTransaction);

app.post('/api/heartbeat/fast-forward', (_, res) => {
  heartbeat.lastApprovedTx = Date.now() - heartbeat.thresholdMs - 1000;
  broadcast('heartbeat', hbData());
  setTimeout(() => { if (!heartbeat.isTriggered) triggerDeadSwitch(); }, 1500);
  res.json({ success: true });
});

app.post('/api/reset', async (_, res) => {
  heartbeat = { lastApprovedTx: Date.now(), thresholdMs: 7 * 24 * 3600000, isTriggered: false };
  walletState.transactions = [];
  walletState.totalSpentToday = 0;
  walletState.lastTransaction = null;
  await refreshBalances();
  policyText = existsSync(policyPath) ? readFileSync(policyPath, 'utf-8') : policyText;
  broadcast('init', initPayload());
  res.json({ success: true });
});

// ─── Boot ────────────────────────────────────────────────
async function boot() {
  console.log(`\n  SENTINEL — On-chain AI Policy Firewall (Mantle)`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  Server: http://localhost:${PORT}`);
  console.log(`  LLM:    ${LLM_PROVIDER}${LLM_PROVIDER === 'openrouter' ? ` (${OPENROUTER_MODEL})` : ''}`);

  mantle = await initMantle();
  const s = mantle.status();
  if (s.enabled) {
    walletState.address = s.contracts.SentinelVault;
    await refreshBalances();
    console.log(`  Mantle: LIVE on chain ${s.chainId}`);
    console.log(`    vault:    ${addrUrl(s.contracts.SentinelVault)}`);
    console.log(`    registry: ${addrUrl(s.contracts.SentinelRegistry)}`);
    console.log(`    signer:   ${s.policySigner}`);
    console.log(`    balance:  $${walletState.balance.toFixed(2)} USDC / ${walletState.mnt} MNT`);
  } else {
    console.log(`  Mantle: OFF-CHAIN PREVIEW (${s.reason})`);
    console.log(`          run "npm run genkey" -> fund -> "npm run deploy:mantle"`);
  }
  console.log(`  ────────────────────────────────────────────\n`);

  server.listen(PORT, () => console.log(`  Listening on http://localhost:${PORT}\n`));
}

boot();
