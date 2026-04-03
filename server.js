import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const BACKUP_WALLET = process.env.BACKUP_WALLET || '0xBACKUP...SAFE';
const INITIAL_BALANCE = parseFloat(process.env.INITIAL_BALANCE || '100.00');
const LLM_PROVIDER = process.env.ANTHROPIC_API_KEY ? 'anthropic'
  : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'simulation';

// ─── OWS Integration ────────────────────────────────────
let owsAvailable = false;
let owsWallet = null;
let owsAccounts = {};
let ows = {};

async function initOWS() {
  try {
    const owsModule = await import('@open-wallet-standard/core');
    ows = owsModule;
    owsAvailable = true;
    console.log('  OWS:     SDK loaded (native Rust FFI)');

    // Check for existing wallet
    const wallets = ows.listWallets();
    const existing = wallets.find(w => w.name === 'sentinel-agent');

    if (existing) {
      owsWallet = existing;
      console.log(`  Wallet:  Found "${existing.name}" (${existing.id})`);
    } else {
      owsWallet = ows.createWallet('sentinel-agent');
      console.log(`  Wallet:  Created "sentinel-agent" (${owsWallet.id})`);
    }

    // Parse multi-chain accounts
    if (owsWallet.accounts) {
      for (const acct of owsWallet.accounts) {
        if (acct.chainId.startsWith('eip155')) owsAccounts.evm = acct;
        else if (acct.chainId.startsWith('solana')) owsAccounts.solana = acct;
        else if (acct.chainId.startsWith('bip122')) owsAccounts.bitcoin = acct;
        else if (acct.chainId.startsWith('cosmos')) owsAccounts.cosmos = acct;
      }
    }

    const evmAddr = owsAccounts.evm?.address || 'N/A';
    const solAddr = owsAccounts.solana?.address || 'N/A';
    const btcAddr = owsAccounts.bitcoin?.address || 'N/A';
    console.log(`  EVM:     ${evmAddr}`);
    console.log(`  Solana:  ${solAddr}`);
    console.log(`  Bitcoin: ${btcAddr}`);

  } catch (err) {
    console.log(`  OWS:     SDK not available (${err.message})`);
    console.log('  OWS:     Falling back to simulation mode');
    owsAvailable = false;
  }
}

// ─── MoonPay CLI Bridge ─────────────────────────────────
let moonpayAvailable = false;

function checkMoonPay() {
  try {
    const ver = execSync('moonpay --version 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
    moonpayAvailable = true;
    console.log(`  MoonPay: CLI v${ver}`);
    return true;
  } catch {
    console.log('  MoonPay: CLI not found');
    return false;
  }
}

function moonpayBalances(address, chain = 'base') {
  if (!moonpayAvailable) return null;
  try {
    const raw = execSync(
      `moonpay token balance list --wallet "${address}" --chain "${chain}" --json`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    return JSON.parse(raw);
  } catch { return null; }
}

function moonpayWalletList() {
  if (!moonpayAvailable) return [];
  try {
    const raw = execSync('moonpay wallet list --json', { encoding: 'utf-8', timeout: 5000 });
    return JSON.parse(raw);
  } catch { return []; }
}

// ─── State ───────────────────────────────────────────────
let walletState = {
  address: '0x7a3B1c9D...4e5F6a8B',
  addresses: {},
  balance: INITIAL_BALANCE,
  chain: 'Base',
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

wss.on('connection', ws => {
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      wallet: walletState,
      policy: policyText,
      heartbeat: hbData(),
      llmProvider: LLM_PROVIDER,
      owsStatus: {
        available: owsAvailable,
        walletName: owsWallet?.name || null,
        walletId: owsWallet?.id || null,
        accounts: owsAccounts,
        moonpay: moonpayAvailable
      }
    },
    timestamp: Date.now()
  }));
});

// ─── OWS Signing ────────────────────────────────────────
async function owsSign(tx) {
  const txSummary = `SENTINEL-TX:${tx.amount}:${tx.recipient}:${tx.purpose}:${Date.now()}`;

  if (owsAvailable && owsWallet) {
    try {
      // Sign the transaction summary using OWS SDK
      const result = ows.signMessage('sentinel-agent', 'evm', txSummary);
      return {
        signed: true,
        txHash: '0x' + result.signature.substring(0, 64),
        signature: result.signature,
        recoveryId: result.recoveryId,
        method: 'ows_sign',
        wallet: owsWallet.name
      };
    } catch (err) {
      console.error('[OWS] Sign failed:', err.message);
      // Fall through to simulation
    }
  }

  // Simulation fallback
  await new Promise(r => setTimeout(r, 400));
  return {
    signed: true,
    txHash: '0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join(''),
    signature: null,
    method: 'simulation',
    wallet: 'mock'
  };
}

// ─── LLM Policy Evaluation ──────────────────────────────
async function evaluatePolicy(tx) {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });

  const sys = `You are a strict transaction policy evaluator for an AI agent's cryptocurrency wallet. Read the spending policy (plain English) and decide if the proposed transaction is allowed. Be strict and literal. Respond ONLY with JSON: {"decision":"APPROVED" or "REJECTED","reason":"...","rule_matched":"exact rule text"}`;

  const user = `POLICY:\n---\n${policyText}\n---\n\nTRANSACTION:\n- Amount: $${tx.amount.toFixed(2)} USDC\n- Recipient: ${tx.recipient}\n- Purpose: ${tx.purpose}\n- Chain: ${tx.chain}\n- Time: ${now.toISOString()}\n- Day: ${day}\n- Balance: $${walletState.balance.toFixed(2)}\n- Spent Today: $${walletState.totalSpentToday.toFixed(2)}\n\nAPPROVED or REJECTED?`;

  if (LLM_PROVIDER === 'anthropic') return callAnthropic(sys, user, tx);
  if (LLM_PROVIDER === 'openrouter') return callOpenRouter(sys, user, tx);
  return simulate(tx);
}

async function callAnthropic(sys, user, tx) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 300, system: sys, messages: [{ role: 'user', content: user }] })
    });
    const d = await r.json();
    return JSON.parse(d.content[0].text);
  } catch (e) { console.error('[LLM]', e.message); return simulate(tx); }
}

async function callOpenRouter(sys, user, tx) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-4-20250514', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: 300 })
    });
    const d = await r.json();
    const m = d.choices[0].message.content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : simulate(tx);
  } catch (e) { console.error('[LLM]', e.message); return simulate(tx); }
}

function simulate(tx) {
  const now = new Date();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const pol = policyText.toLowerCase();

  if (isWeekend && pol.includes('weekend'))
    return { decision: 'REJECTED', reason: 'Transaction attempted on a weekend. Policy prohibits weekend transactions.', rule_matched: 'Never transact on weekends (Saturday or Sunday).' };

  const limitM = pol.match(/never spend more than \$(\d+)/i);
  if (limitM && tx.amount > parseFloat(limitM[1]))
    return { decision: 'REJECTED', reason: `$${tx.amount.toFixed(2)} exceeds the $${limitM[1]} single-transaction limit.`, rule_matched: `Never spend more than $${limitM[1]} on a single transaction.` };

  const dailyM = pol.match(/daily spending must not exceed \$(\d+)/i);
  if (dailyM && (walletState.totalSpentToday + tx.amount) > parseFloat(dailyM[1]))
    return { decision: 'REJECTED', reason: `Would push daily spending to $${(walletState.totalSpentToday + tx.amount).toFixed(2)}, exceeding $${dailyM[1]} daily limit.`, rule_matched: `Total daily spending must not exceed $${dailyM[1]}.` };

  if (pol.includes('only pay for api') || pol.includes('only pay for api services')) {
    const ok = ['api', 'data', 'cloud', 'infrastructure', 'compute', 'server'].some(t => (tx.purpose || '').toLowerCase().includes(t));
    if (!ok) return { decision: 'REJECTED', reason: `"${tx.purpose}" is not an API service, data feed, or cloud infrastructure expense.`, rule_matched: 'Only pay for API services, data feeds, and cloud infrastructure.' };
  }

  const chainM = pol.match(/only transact on the (\w+) network/i);
  if (chainM && tx.chain.toLowerCase() !== chainM[1].toLowerCase())
    return { decision: 'REJECTED', reason: `Transaction on ${tx.chain} but policy restricts to ${chainM[1]} only.`, rule_matched: `Only transact on the ${chainM[1]} network.` };

  if (tx.amount > walletState.balance)
    return { decision: 'REJECTED', reason: `Insufficient balance ($${walletState.balance.toFixed(2)} available).`, rule_matched: 'Insufficient funds.' };

  return { decision: 'APPROVED', reason: `$${tx.amount.toFixed(2)} for "${tx.purpose}" complies with all policy rules.`, rule_matched: 'Only pay for API services, data feeds, and cloud infrastructure.' };
}

// ─── Heartbeat ───────────────────────────────────────────
function hbData() {
  const elapsed = Date.now() - heartbeat.lastApprovedTx;
  const remaining = Math.max(0, heartbeat.thresholdMs - elapsed);
  return { lastActivity: heartbeat.lastApprovedTx, elapsed, remaining, threshold: heartbeat.thresholdMs, status: heartbeat.isTriggered ? 'TRIGGERED' : remaining <= 0 ? 'CRITICAL' : remaining < heartbeat.thresholdMs * 0.25 ? 'WARNING' : 'ACTIVE', isTriggered: heartbeat.isTriggered };
}

async function triggerDeadSwitch() {
  if (heartbeat.isTriggered || walletState.balance <= 0) return;
  heartbeat.isTriggered = true;
  const amount = walletState.balance;
  const owsResult = await owsSign({ amount, recipient: BACKUP_WALLET, purpose: 'Dead Agent Switch', chain: 'Base' });

  walletState.balance = 0;
  walletState.lastTransaction = Date.now();

  const rec = {
    id: `tx_${Date.now()}`, amount, recipient: BACKUP_WALLET,
    purpose: 'Dead Agent Switch — Automatic fund recovery', chain: 'Base',
    decision: 'AUTO-EXECUTED',
    reason: 'Heartbeat threshold exceeded. Funds routed to backup wallet per policy.',
    rule_matched: 'If the agent has been inactive for 7 days, send all remaining funds to the backup wallet.',
    timestamp: new Date().toISOString(),
    txHash: owsResult.txHash,
    signature: owsResult.signature || null,
    sigMethod: owsResult.method,
    isEmergency: true
  };

  walletState.transactions.push(rec);
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

// ─── Routes ──────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

app.get('/api/state', (_, res) => res.json({
  wallet: walletState, policy: policyText, heartbeat: hbData(),
  llmProvider: LLM_PROVIDER,
  owsStatus: { available: owsAvailable, walletName: owsWallet?.name, walletId: owsWallet?.id, accounts: owsAccounts, moonpay: moonpayAvailable }
}));

app.post('/api/policy', (req, res) => {
  policyText = req.body.text;
  writeFileSync(policyPath, policyText, 'utf-8');
  broadcast('policy_updated', { text: policyText });
  res.json({ success: true });
});

app.post('/api/transact', async (req, res) => {
  const { amount, recipient, purpose, chain } = req.body;
  const txId = `tx_${Date.now()}`;
  broadcast('evaluating', { txId, amount, purpose });

  const evaluation = await evaluatePolicy({ amount: parseFloat(amount), recipient: recipient || 'Unknown', purpose, chain: chain || 'Base' });
  let txHash = null;
  let signature = null;
  let sigMethod = 'none';

  if (evaluation.decision === 'APPROVED') {
    const owsResult = await owsSign({ amount: parseFloat(amount), recipient, purpose, chain: chain || 'Base' });
    txHash = owsResult.txHash;
    signature = owsResult.signature || null;
    sigMethod = owsResult.method;
    walletState.balance -= parseFloat(amount);
    walletState.totalSpentToday += parseFloat(amount);
    walletState.lastTransaction = Date.now();
    heartbeat.lastApprovedTx = Date.now();
    heartbeat.isTriggered = false;
  }

  const rec = {
    id: txId, amount: parseFloat(amount), recipient: recipient || 'Service Provider',
    purpose, chain: chain || 'Base', ...evaluation,
    timestamp: new Date().toISOString(), txHash,
    signature, sigMethod,
    isEmergency: false
  };

  walletState.transactions.push(rec);
  broadcast('transaction', rec);
  broadcast('wallet_update', walletState);
  broadcast('heartbeat', hbData());
  res.json(rec);
});

app.get('/api/wallet/balance', async (req, res) => {
  const chain = req.query.chain || 'base';
  const addr = owsAccounts.evm?.address;
  if (!addr) return res.json({ balance: null, source: 'no-wallet' });

  const balances = moonpayBalances(addr, chain);
  res.json({ address: addr, chain, balances, source: balances ? 'moonpay' : 'unavailable' });
});

app.get('/api/ows/status', (_, res) => {
  res.json({
    available: owsAvailable,
    wallet: owsWallet ? { name: owsWallet.name, id: owsWallet.id, accounts: owsWallet.accounts } : null,
    moonpay: moonpayAvailable,
    moonpayWallets: moonpayWalletList()
  });
});

app.post('/api/heartbeat/fast-forward', (_, res) => {
  heartbeat.lastApprovedTx = Date.now() - heartbeat.thresholdMs - 1000;
  broadcast('heartbeat', hbData());
  setTimeout(() => { if (!heartbeat.isTriggered) triggerDeadSwitch(); }, 2000);
  res.json({ success: true });
});

app.post('/api/reset', (_, res) => {
  walletState = {
    address: owsAccounts.evm?.address || '0x7a3B1c9D...4e5F6a8B',
    addresses: owsAccounts,
    balance: INITIAL_BALANCE, chain: 'Base',
    lastTransaction: null, totalSpentToday: 0, transactions: []
  };
  heartbeat = { lastApprovedTx: Date.now(), thresholdMs: 7 * 24 * 3600000, isTriggered: false };
  policyText = readFileSync(policyPath, 'utf-8');
  broadcast('init', {
    wallet: walletState, policy: policyText, heartbeat: hbData(),
    llmProvider: LLM_PROVIDER,
    owsStatus: { available: owsAvailable, walletName: owsWallet?.name, walletId: owsWallet?.id, accounts: owsAccounts, moonpay: moonpayAvailable }
  });
  res.json({ success: true });
});

// ─── Boot ────────────────────────────────────────────────
async function boot() {
  console.log(`\n  SENTINEL — Natural Language Policy Engine`);
  console.log(`  Extending OWS with human-readable policies\n`);
  console.log(`  Server:  http://localhost:${PORT}`);
  console.log(`  LLM:     ${LLM_PROVIDER}`);
  console.log(`  Balance: $${INITIAL_BALANCE.toFixed(2)} USDC (simulated)`);

  await initOWS();
  checkMoonPay();

  // Set wallet address from OWS if available
  if (owsAccounts.evm) {
    walletState.address = owsAccounts.evm.address;
    walletState.addresses = owsAccounts;
  }

  console.log(`\n  ─────────────────────────────────────`);
  console.log(`  Mode: ${owsAvailable ? 'OWS LIVE (real signatures)' : 'SIMULATION (mock signatures)'}`);
  console.log(`  ─────────────────────────────────────\n`);

  server.listen(PORT, () => {
    console.log(`  Listening on http://localhost:${PORT}\n`);
  });
}

boot();
