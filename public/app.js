// ─── State ───────────────────────────────────────────────
let ws;
let isProcessing = false;

// ─── DOM refs ────────────────────────────────────────────
const $ = id => document.getElementById(id);
const bal = $('bal');
const wAddr = $('w-addr');
const wLast = $('w-last');
const wToday = $('w-today');
const walletTag = $('wallet-tag');
const policyEditor = $('policy-editor');
const txFeed = $('tx-feed');
const txCount = $('tx-count');
const hbDays = $('hb-days');
const hbRing = $('hb-ring');
const hbLast = $('hb-last');
const hbTag = $('hb-tag');
const llmText = $('llm-text');
const llmBadge = $('llm-badge');

// ─── WebSocket ───────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onmessage = e => {
    const { type, data } = JSON.parse(e.data);
    switch (type) {
      case 'init': initState(data); break;
      case 'wallet_update': updateWallet(data); break;
      case 'transaction': addTransaction(data); break;
      case 'heartbeat': updateHeartbeat(data); break;
      case 'policy_updated': policyEditor.value = data.text; flashSave(); break;
      case 'evaluating': addEvaluating(data); break;
      case 'dead_agent_switch': onDeadSwitch(data); break;
    }
  };

  ws.onclose = () => setTimeout(connect, 2000);
  ws.onerror = () => ws.close();
}

// ─── Init ────────────────────────────────────────────────
function initState(data) {
  updateWallet(data.wallet);
  policyEditor.value = data.policy;
  updateHeartbeat(data.heartbeat);

  // Show LLM provider
  const prov = data.llmProvider || 'simulation';
  const labels = { anthropic: 'Claude (Direct)', openrouter: 'Claude (OpenRouter)', simulation: 'Simulation Mode' };
  llmText.textContent = labels[prov] || prov;
  if (prov === 'simulation') {
    llmBadge.querySelector('.badge-dot').style.background = 'var(--amber)';
  }

  // Rebuild transaction log
  txFeed.innerHTML = '';
  if (data.wallet.transactions && data.wallet.transactions.length > 0) {
    data.wallet.transactions.forEach(tx => addTransaction(tx, false));
  } else {
    txFeed.innerHTML = '<div class="tx-empty"><div class="tx-empty-ico">⏳</div><p>No transactions yet. Use the controls below to simulate agent spending.</p></div>';
  }
}

// ─── Wallet ──────────────────────────────────────────────
function updateWallet(w) {
  const prev = parseFloat(bal.textContent);
  bal.textContent = w.balance.toFixed(2);
  if (Math.abs(prev - w.balance) > 0.001) {
    bal.classList.add('flash');
    setTimeout(() => bal.classList.remove('flash'), 500);
  }

  wToday.textContent = `$${(w.totalSpentToday || 0).toFixed(2)}`;
  if (w.lastTransaction) {
    wLast.textContent = timeAgo(w.lastTransaction);
  }

  // Wallet tag
  if (w.balance <= 0) {
    walletTag.textContent = 'EMPTY';
    walletTag.className = 'tag tag-danger';
  } else if (w.balance < 20) {
    walletTag.textContent = 'LOW';
    walletTag.className = 'tag tag-warn';
  } else {
    walletTag.textContent = 'FUNDED';
    walletTag.className = 'tag';
  }
}

// ─── Transactions ────────────────────────────────────────
function addEvaluating(data) {
  clearEmpty();
  const card = document.createElement('div');
  card.className = 'tx-card evaluating';
  card.id = `card-${data.txId}`;
  card.innerHTML = `
    <div class="tx-top">
      <span class="tx-badge evaluating">⏳ EVALUATING...</span>
      <span class="tx-time">${new Date().toLocaleTimeString()}</span>
    </div>
    <div class="tx-purpose">${data.purpose} — $${parseFloat(data.amount).toFixed(2)}</div>
    <div class="tx-reason" style="color:var(--amber)">Policy engine is reading the transaction and checking against your rules...</div>
  `;
  txFeed.prepend(card);
  animateFlow('evaluating');
}

function addTransaction(tx, animate = true) {
  clearEmpty();
  // Remove evaluating card if exists
  const existing = document.getElementById(`card-${tx.id}`);
  if (existing) existing.remove();

  const cls = tx.isEmergency ? 'emergency' : tx.decision === 'APPROVED' ? 'approved' : 'rejected';
  const icon = tx.isEmergency ? '🚨' : tx.decision === 'APPROVED' ? '✅' : '❌';
  const label = tx.isEmergency ? 'AUTO-EXECUTED' : tx.decision;
  const time = new Date(tx.timestamp).toLocaleTimeString();

  const card = document.createElement('div');
  card.className = `tx-card ${cls}`;
  if (!animate) card.style.animation = 'none';

  card.innerHTML = `
    <div class="tx-top">
      <span class="tx-badge ${cls}">${icon} ${label}</span>
      <span class="tx-time">${time}</span>
    </div>
    <div class="tx-purpose">${tx.purpose} — $${tx.amount.toFixed(2)}</div>
    <div class="tx-reason">${tx.reason}</div>
    ${tx.rule_matched ? `<div class="tx-rule">📌 ${tx.rule_matched}</div>` : ''}
    ${tx.txHash ? `<div class="tx-rule" style="color:var(--text2)">TX: ${tx.txHash.slice(0, 18)}...</div>` : ''}
  `;

  txFeed.prepend(card);
  const count = txFeed.querySelectorAll('.tx-card').length;
  txCount.textContent = `${count} transaction${count !== 1 ? 's' : ''}`;

  if (animate) animateFlow(cls);
}

function clearEmpty() {
  const empty = txFeed.querySelector('.tx-empty');
  if (empty) empty.remove();
}

// ─── Heartbeat ───────────────────────────────────────────
function updateHeartbeat(hb) {
  const daysIdle = Math.min(7, hb.elapsed / (24 * 3600000));
  hbDays.textContent = daysIdle.toFixed(daysIdle < 1 ? 2 : 1);

  const pct = Math.min(1, hb.elapsed / hb.threshold);
  const circumference = 2 * Math.PI * 88;
  hbRing.style.strokeDashoffset = circumference * (1 - pct);

  hbRing.classList.remove('warn', 'danger', 'triggered');
  hbTag.className = 'tag tag-active';

  if (hb.status === 'TRIGGERED') {
    hbRing.classList.add('triggered');
    hbTag.textContent = 'TRIGGERED';
    hbTag.className = 'tag tag-emergency';
  } else if (hb.status === 'CRITICAL') {
    hbRing.classList.add('danger');
    hbTag.textContent = 'CRITICAL';
    hbTag.className = 'tag tag-danger';
  } else if (hb.status === 'WARNING') {
    hbRing.classList.add('warn');
    hbTag.textContent = 'WARNING';
    hbTag.className = 'tag tag-warn';
  } else {
    hbTag.textContent = 'ACTIVE';
    hbTag.className = 'tag';
  }

  hbLast.textContent = timeAgo(hb.lastActivity);
}

function onDeadSwitch(tx) {
  // Dramatic effect
  document.body.style.transition = 'background 0.5s';
  document.body.style.background = '#1a0505';
  setTimeout(() => { document.body.style.background = ''; }, 2000);
}

// ─── Flow Diagram Animation ─────────────────────────────
function animateFlow(result) {
  const nodes = ['fn-engine', 'fn-llm', 'fn-ows'];
  const arrows = ['fa1', 'fa2', 'fa3'];
  const color = result === 'approved' ? 'lit-green' : result === 'rejected' ? 'lit-red' : '';

  // Reset
  nodes.forEach(n => { $(n).className = 'flow-node'; });
  arrows.forEach(a => { $(a).className = 'flow-arrow'; });

  // Animate step by step
  setTimeout(() => { $(arrows[0]).classList.add('lit'); $(nodes[0]).classList.add('active'); }, 100);
  setTimeout(() => { $(arrows[1]).classList.add('lit'); $(nodes[1]).classList.add('active'); }, 400);
  setTimeout(() => {
    $(arrows[2]).classList.add('lit');
    $(nodes[2]).classList.add(color || 'active');
    if (color) { $(nodes[1]).className = `flow-node ${color}`; $(nodes[0]).className = `flow-node ${color}`; }
  }, 700);

  // Clear after 3s
  setTimeout(() => {
    nodes.forEach(n => { $(n).className = 'flow-node'; });
    arrows.forEach(a => { $(a).className = 'flow-arrow'; });
  }, 3000);
}

// ─── API calls ───────────────────────────────────────────
async function sendTransaction(amount, purpose, recipient, chain) {
  if (isProcessing) return;
  isProcessing = true;
  disableButtons(true);

  try {
    await fetch('/api/transact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, purpose, recipient: recipient || 'Service Provider', chain: chain || 'Base' })
    });
  } catch (e) {
    console.error('Transaction error:', e);
  }

  isProcessing = false;
  disableButtons(false);
}

async function savePolicy() {
  const text = policyEditor.value;
  try {
    await fetch('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    flashSave();
  } catch (e) { console.error('Policy save error:', e); }
}

async function fastForward() {
  $('btn-ff').disabled = true;
  $('btn-ff').textContent = '⏩ Forwarding...';
  try {
    await fetch('/api/heartbeat/fast-forward', { method: 'POST' });
  } catch (e) { console.error('Fast forward error:', e); }
  setTimeout(() => {
    $('btn-ff').disabled = false;
    $('btn-ff').textContent = '⏩ Fast Forward 7 Days';
  }, 4000);
}

async function resetDemo() {
  try {
    await fetch('/api/reset', { method: 'POST' });
  } catch (e) { console.error('Reset error:', e); }
}

// ─── Helpers ─────────────────────────────────────────────
function flashSave() {
  const btn = $('btn-save');
  btn.textContent = '✓ Saved';
  btn.classList.add('saved');
  setTimeout(() => { btn.textContent = 'Save'; btn.classList.remove('saved'); }, 1500);
}

function disableButtons(disabled) {
  document.querySelectorAll('.tx-btn').forEach(b => b.disabled = disabled);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 5000) return 'Just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ─── Event Listeners ─────────────────────────────────────
document.querySelectorAll('.tx-btn:not(.custom)').forEach(btn => {
  btn.addEventListener('click', () => {
    const { amount, purpose, recipient } = btn.dataset;
    sendTransaction(parseFloat(amount), purpose, recipient, 'Base');
  });
});

$('btn-custom').addEventListener('click', () => $('modal-bg').classList.add('open'));
$('modal-x').addEventListener('click', () => $('modal-bg').classList.remove('open'));
$('modal-bg').addEventListener('click', e => { if (e.target === $('modal-bg')) $('modal-bg').classList.remove('open'); });

$('btn-submit-custom').addEventListener('click', () => {
  const amount = parseFloat($('c-amount').value);
  const purpose = $('c-purpose').value;
  const recipient = $('c-recipient').value;
  const chain = $('c-chain').value;
  if (!amount || !purpose) return alert('Amount and purpose required');
  $('modal-bg').classList.remove('open');
  sendTransaction(amount, purpose, recipient, chain);
});

$('btn-save').addEventListener('click', savePolicy);
$('btn-ff').addEventListener('click', fastForward);
$('btn-reset').addEventListener('click', resetDemo);

// Ctrl+S to save policy
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (document.activeElement === policyEditor) savePolicy();
  }
});

// ─── Boot ────────────────────────────────────────────────
connect();
