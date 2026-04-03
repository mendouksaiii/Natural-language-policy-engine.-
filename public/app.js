// ─── DOM Routing ─────────────────────────────────────────
const viewLanding = document.getElementById('view-landing');
const viewDashboard = document.getElementById('view-dashboard');
const btnEnter = document.getElementById('btn-enter-dash');
const btnBack = document.getElementById('btn-back');

function showDashboard() {
  viewLanding.style.opacity = '0';
  setTimeout(() => {
    viewLanding.style.display = 'none';
    viewDashboard.style.display = 'flex';
    // Small delay to allow display flex to apply before transitioning opacity
    requestAnimationFrame(() => {
      viewDashboard.style.opacity = '1';
    });
  }, 300);
}

function showLanding() {
  viewDashboard.style.opacity = '0';
  setTimeout(() => {
    viewDashboard.style.display = 'none';
    viewLanding.style.display = 'block';
    requestAnimationFrame(() => {
      viewLanding.style.opacity = '1';
    });
  }, 300);
}

btnEnter.addEventListener('click', showDashboard);
btnBack.addEventListener('click', showLanding);

// ─── Dashboard State ─────────────────────────────────────
let ws;
let isProcessing = false;

// DOM Refs
const $ = id => document.getElementById(id);
const bal = $('bal');
const wToday = $('w-today');
const wLast = $('w-last');
const txApp = $('tx-app');
const txRej = $('tx-rej');
const txSpent = $('tx-spent');

const hbTimer = $('hb-timer');
const hbFill = $('hb-fill');

const policyEditor = $('policy-editor');
const ruleCountLbl = $('rule-count-lbl');
const btnSave = $('btn-save');

const txFeed = $('tx-feed');
const txCount = $('tx-count');
const llmFeed = $('llm-feed');

// ─── WebSocket ───────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onmessage = e => {
    const { type, data } = JSON.parse(e.data);
    switch (type) {
      case 'init': initState(data); break;
      case 'wallet_update': updateWallet(data); updateStats(data); break;
      case 'transaction': addTransaction(data); break;
      case 'heartbeat': updateHeartbeat(data); break;
      case 'policy_updated': 
        policyEditor.value = data.text; 
        updateRuleCount(data.text);
        flashSave(true); 
        break;
      case 'evaluating': addEvaluating(data); logLLM(`EVALUATING TX:\n{ amount: ${data.amount}, purpose: "${data.purpose}" }\nReasoning loop initiated...`); break;
    }
  };

  ws.onclose = () => setTimeout(connect, 2000);
  ws.onerror = () => ws.close();
}

// ─── Init ────────────────────────────────────────────────
function initState(data) {
  updateWallet(data.wallet);
  updateStats(data.wallet);
  policyEditor.value = data.policy;
  updateRuleCount(data.policy);
  updateHeartbeat(data.heartbeat);

  txFeed.innerHTML = '';
  if (data.wallet.transactions && data.wallet.transactions.length > 0) {
    data.wallet.transactions.forEach(tx => addTransaction(tx, false));
  } else {
    txFeed.innerHTML = '<div class="feed-empty">NO ACTIVITY. AWAITING AGENT TX.</div>';
  }
}

function updateRuleCount(text) {
  const rules = text.split('\n').filter(l => l.trim().length > 5).length;
  ruleCountLbl.textContent = `${rules} RULES ACTIVE`;
}

// ─── Wallet & Stats ──────────────────────────────────────
function updateWallet(w) {
  const prev = parseFloat(bal.textContent);
  bal.textContent = w.balance.toFixed(2);
  if (Math.abs(prev - w.balance) > 0.001) {
    bal.classList.add('flash');
    setTimeout(() => bal.classList.remove('flash'), 500);
  }
}

function updateStats(w) {
  let appOpts = 0; let rejOpts = 0; let spent = 0;
  if(w.transactions) {
    w.transactions.forEach(t => {
      if(t.decision === 'APPROVED' || t.isEmergency) appOpts++;
      if(t.decision === 'REJECTED') rejOpts++;
      if((t.decision === 'APPROVED' || t.isEmergency) && t.amount) spent += t.amount;
    });
  }
  
  txApp.textContent = appOpts;
  txRej.textContent = rejOpts;
  txSpent.textContent = `$${spent.toFixed(2)}`;
  wToday.textContent = spent.toFixed(2);
  
  if (w.lastTransaction) {
    wLast.textContent = timeAgo(w.lastTransaction).toUpperCase();
  }
}

// ─── Transactions ────────────────────────────────────────
function logLLM(msg) {
  const empty = llmFeed.querySelector('.feed-empty');
  if(empty) empty.remove();
  
  const div = document.createElement('div');
  div.className = 'llm-msg';
  div.innerHTML = `<span class="llm-label">></span> ${msg}`;
  llmFeed.appendChild(div);
  llmFeed.scrollTop = llmFeed.scrollHeight;
}

function addEvaluating(data) {
  clearEmptyFeed();
  const card = document.createElement('div');
  card.className = 'tx-item eval';
  card.id = `card-${data.txId}`;
  card.innerHTML = `
    <div class="tx-header">
      <span class="tx-badge eval">EVAL</span>
      <span class="tx-time">${new Date().toLocaleTimeString()}</span>
    </div>
    <div class="tx-desc">${data.purpose} <span class="tx-amt">$${parseFloat(data.amount).toFixed(2)}</span></div>
    <div class="tx-reason">CLAUDE EVALUATING AGAINST POLICY...</div>
  `;
  txFeed.prepend(card);
}

function addTransaction(tx, animate = true) {
  clearEmptyFeed();
  const existing = document.getElementById(`card-${tx.id}`);
  if (existing) existing.remove();

  const isApp = tx.decision === 'APPROVED';
  const isRej = tx.decision === 'REJECTED';
  const isSys = tx.isEmergency;
  
  let cls = isRej ? 'rej' : isSys ? 'sys' : 'app';
  let badgeTxt = isRej ? 'REJ' : isSys ? 'SYS' : 'APP';
  
  if (animate) {
    logLLM(`DECISION: ${tx.decision}\nREASON: ${tx.reason}`);
  }

  const timeStr = new Date(tx.timestamp).toLocaleTimeString();

  const card = document.createElement('div');
  card.className = `tx-item ${cls}`;
  
  card.innerHTML = `
    <div class="tx-header">
      <span class="tx-badge ${cls}">${badgeTxt}</span>
      <span class="tx-time">${timeStr}</span>
    </div>
    <div class="tx-desc">${tx.purpose || 'SYS RECOVERY'} <span class="tx-amt">$${tx.amount.toFixed(2)}</span></div>
    <div class="tx-reason">${tx.reason}</div>
    ${tx.txHash ? `<div class="tx-hash">HASH: ${tx.txHash.substring(0, 16)}...</div>` : ''}
  `;

  txFeed.prepend(card);
  
  const count = txFeed.querySelectorAll('.tx-item').length;
  txCount.textContent = `${count} RECORDS`;
}

function clearEmptyFeed() {
  const empty = txFeed.querySelector('.feed-empty');
  if (empty) empty.remove();
}

// ─── Heartbeat ───────────────────────────────────────────
function updateHeartbeat(hb) {
  const thresholdDays = hb.threshold / (24 * 3600000);
  const elapsedDays = Math.min(thresholdDays, hb.elapsed / (24 * 3600000));
  const remainingMs = hb.threshold - hb.elapsed;
  
  if (remainingMs <= 0 || hb.status === 'TRIGGERED') {
    hbTimer.textContent = "00:00:00";
    hbTimer.className = 'das-timer danger';
    hbFill.style.width = '0%';
    hbFill.style.background = 'var(--red)';
    hbFill.style.boxShadow = '0 0 8px var(--red)';
    document.querySelector('.das-block').style.borderColor = 'var(--red)';
    return;
  }

  // Format countdown HH:MM:SS
  const formatTime = (ms) => {
    let totalSecs = Math.floor(ms / 1000);
    let h = Math.floor(totalSecs / 3600);
    let m = Math.floor((totalSecs % 3600) / 60);
    let s = totalSecs % 60;
    return `${h.toString().padStart(3, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  hbTimer.textContent = formatTime(remainingMs);
  
  const pct = Math.max(0, (remainingMs / hb.threshold) * 100);
  hbFill.style.width = pct + '%';
  
  if (hb.status === 'CRITICAL' || remainingMs < 30 * 60 * 1000) {
    hbTimer.className = 'das-timer danger';
    hbFill.style.background = 'var(--red)';
    hbFill.style.boxShadow = '0 0 8px var(--red)';
  } else {
    hbTimer.className = 'das-timer';
    hbFill.style.background = 'var(--amber)';
    hbFill.style.boxShadow = '0 0 8px var(--amber)';
  }
}

// ─── Actions ─────────────────────────────────────────────
async function sendTransaction(amount, purpose, recipient) {
  if (isProcessing) return;
  isProcessing = true;

  try {
    await fetch('/api/transact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, purpose, recipient, chain: 'Base' })
    });
  } catch (e) { console.error(e); }
  isProcessing = false;
}

async function savePolicy() {
  const text = policyEditor.value;
  btnSave.textContent = "PUSHING...";
  btnSave.classList.add('pushing');
  
  try {
    await fetch('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (e) { 
    console.error(e); 
    btnSave.textContent = "ERROR";
    btnSave.classList.remove('pushing');
  }
}

function flashSave(remote = false) {
  btnSave.classList.remove('pushing');
  btnSave.classList.add('saved');
  btnSave.innerHTML = "&#10003; DEPLOYED";
  setTimeout(() => { 
    btnSave.classList.remove('saved'); 
    btnSave.textContent = "PUSH POLICY"; 
  }, 2000);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 5000) return 'JUST NOW';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s AGO`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m AGO`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h AGO`;
  return `${Math.floor(diff / 86400000)}d AGO`;
}

// Listeners
document.querySelectorAll('.sim-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const { amount, purpose, recipient } = btn.dataset;
    sendTransaction(parseFloat(amount), purpose, recipient);
  });
});

btnSave.addEventListener('click', savePolicy);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (document.activeElement === policyEditor) savePolicy();
  }
});

// Boot
connect();
