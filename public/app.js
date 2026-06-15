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
    requestAnimationFrame(() => { viewDashboard.style.opacity = '1'; });
  }, 300);
}
function showLanding() {
  viewDashboard.style.opacity = '0';
  setTimeout(() => {
    viewDashboard.style.display = 'none';
    viewLanding.style.display = 'block';
    requestAnimationFrame(() => { viewLanding.style.opacity = '1'; });
  }, 300);
}
btnEnter.addEventListener('click', showDashboard);
btnBack.addEventListener('click', showLanding);

// ─── Dashboard State ─────────────────────────────────────
let ws;
let isProcessing = false;
let explorerBase = 'https://explorer.sepolia.mantle.xyz';

const $ = id => document.getElementById(id);
const bal = $('bal');
const wToday = $('w-today');
const wMnt = $('w-mnt');
const wLast = $('w-last');
const txApp = $('tx-app');
const txRej = $('tx-rej');
const txSpent = $('tx-spent');
const txAudit = $('tx-audit');

const hbTimer = $('hb-timer');
const hbFill = $('hb-fill');

const policyEditor = $('policy-editor');
const ruleCountLbl = $('rule-count-lbl');
const btnSave = $('btn-save');

const txFeed = $('tx-feed');
const txCount = $('tx-count');
const llmFeed = $('llm-feed');

const btnAdversarial = $('btn-adversarial');

// Chain status refs
const chainDot = $('chain-dot');
const chainLabel = $('chain-label');
const badgeLlm = $('badge-llm');
const addrVault = $('addr-vault');
const addrRegistry = $('addr-registry');
const addrSigner = $('addr-signer');
const addrSrc = $('addr-src');

let auditCount = 0;

const short = a => (a && a.length > 12) ? a.substring(0, 6) + '…' + a.substring(a.length - 4) : (a || '—');

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
      case 'dead_agent_switch': logLLM(`<span style="color:var(--red)">[DEAD-AGENT SWITCH] Vault swept to backup wallet on Mantle.</span>`); break;
      case 'heartbeat': updateHeartbeat(data); break;
      case 'policy_updated':
        policyEditor.value = data.text;
        updateRuleCount(data.text);
        flashSave();
        break;
      case 'evaluating':
        logLLM(`EVALUATING TX:\n{ amount: $${parseFloat(data.amount).toFixed(2)}, purpose: "${data.purpose}" }\nReasoning loop initiated…`);
        break;
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
  if (data.chain) updateChainStatus(data.chain);
  if (data.llmProvider && badgeLlm) badgeLlm.textContent = data.llmProvider.toUpperCase();

  txFeed.innerHTML = '';
  if (data.wallet.transactions && data.wallet.transactions.length > 0) {
    data.wallet.transactions.forEach(tx => addTransaction(tx, false));
  } else {
    txFeed.innerHTML = '<div class="feed-empty">NO ACTIVITY. AWAITING AGENT TX.</div>';
  }
}

function updateRuleCount(text) {
  const rules = (text || '').split('\n').filter(l => /^\s*\d+\./.test(l)).length;
  ruleCountLbl.textContent = `${rules} RULES ACTIVE`;
}

// ─── Chain status ────────────────────────────────────────
function updateChainStatus(chain) {
  explorerBase = chain.explorer || explorerBase;
  if (chain.enabled) {
    chainDot.classList.add('live');
    chainLabel.textContent = `MANTLE LIVE · ${chain.chainId}`;
    addrSrc.textContent = `// EIP-712 GATED · chain ${chain.chainId}`;
  } else {
    chainDot.classList.remove('live');
    chainLabel.textContent = 'OFF-CHAIN PREVIEW';
    addrSrc.textContent = `// ${(chain.reason || 'not deployed').toUpperCase()}`;
  }

  const c = chain.contracts || {};
  if (c.SentinelVault) {
    addrVault.textContent = short(c.SentinelVault);
    addrVault.href = `${explorerBase}/address/${c.SentinelVault}`;
    addrVault.title = c.SentinelVault;
  }
  if (c.SentinelRegistry) {
    addrRegistry.textContent = short(c.SentinelRegistry);
    addrRegistry.href = `${explorerBase}/address/${c.SentinelRegistry}`;
    addrRegistry.title = c.SentinelRegistry;
  }
  if (chain.policySigner) {
    addrSigner.textContent = short(chain.policySigner);
    addrSigner.title = chain.policySigner;
  }
}

// ─── Wallet & Stats ──────────────────────────────────────
function updateWallet(w) {
  const prev = parseFloat(bal.textContent);
  bal.textContent = Number(w.balance || 0).toFixed(2);
  if (wMnt) wMnt.textContent = Number(w.mnt || 0).toFixed(3);
  if (Math.abs(prev - w.balance) > 0.001) {
    bal.classList.add('flash');
    setTimeout(() => bal.classList.remove('flash'), 500);
  }
}

function updateStats(w) {
  let app = 0, rej = 0, spent = 0;
  if (w.transactions) {
    w.transactions.forEach(t => {
      if (t.decision === 'REJECTED') rej++;
      else { app++; if (t.amount) spent += t.amount; }
    });
  }
  txApp.textContent = app;
  txRej.textContent = rej;
  txSpent.textContent = `$${spent.toFixed(2)}`;
  wToday.textContent = (w.totalSpentToday != null ? w.totalSpentToday : spent).toFixed(2);
  if (w.lastTransaction) wLast.textContent = timeAgo(w.lastTransaction).toUpperCase();
}

// ─── LLM feed ────────────────────────────────────────────
function logLLM(msg) {
  const empty = llmFeed.querySelector('.feed-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'llm-msg';
  div.innerHTML = `<span class="llm-label">></span> ${msg}`;
  llmFeed.appendChild(div);
  llmFeed.scrollTop = llmFeed.scrollHeight;
}

// ─── Transactions ────────────────────────────────────────
function addTransaction(tx, animate = true) {
  clearEmptyFeed();

  const isRej = tx.decision === 'REJECTED';
  const isSys = tx.isEmergency;
  const cls = isRej ? 'rej' : isSys ? 'sys' : 'app';
  const badgeTxt = isRej ? 'REJ' : isSys ? 'SYS' : 'APP';

  if (animate) {
    logLLM(`DECISION: ${tx.decision}\nRULE: ${tx.rule_matched || '—'}\nREASON: ${tx.reason}`);
    if (tx.txHash) logLLM(`<span style="color:var(--green)">EIP-712 APPROVAL SIGNED → vault.executeTransfer settled on Mantle</span>`);
  }

  // On-chain links
  let chainLine = '';
  if (tx.explorerUrl) {
    chainLine += `<div class="tx-hash"><span class="sig-badge">SETTLED</span> <a href="${tx.explorerUrl}" target="_blank" rel="noopener">${tx.txHash.substring(0, 18)}… ↗</a></div>`;
  } else if (!isRej && tx.onchain && tx.onchain.sigMethod === 'offchain-preview') {
    chainLine += `<div class="tx-sig"><span class="sig-badge sim">PREVIEW</span> deploy to Mantle to settle</div>`;
  }
  if (tx.registryUrl) {
    chainLine += `<div class="tx-sig"><span class="sig-badge">AUDIT #${tx.onchain?.recordId ?? '?'}</span> <a href="${tx.registryUrl}" target="_blank" rel="noopener">on-chain record ↗</a></div>`;
    auditCount = Math.max(auditCount, (tx.onchain?.recordId ?? 0) + 1);
    if (txAudit) txAudit.textContent = auditCount;
  }

  const timeStr = new Date(tx.timestamp).toLocaleTimeString();
  const card = document.createElement('div');
  card.className = `tx-item ${cls}`;
  card.innerHTML = `
    <div class="tx-header">
      <span class="tx-badge ${cls}">${badgeTxt}</span>
      <span class="tx-time">${timeStr}</span>
    </div>
    <div class="tx-desc">${tx.purpose || 'SYS RECOVERY'} <span class="tx-amt">$${Number(tx.amount).toFixed(2)}</span></div>
    <div class="tx-reason">${tx.reason || ''}</div>
    ${tx.recipientLabel ? `<div class="tx-reason" style="opacity:.6">→ ${tx.recipientLabel}</div>` : ''}
    ${chainLine}
  `;
  txFeed.prepend(card);
  txCount.textContent = `${txFeed.querySelectorAll('.tx-item').length} RECORDS`;
}

function clearEmptyFeed() {
  const empty = txFeed.querySelector('.feed-empty');
  if (empty) empty.remove();
}

// ─── Heartbeat ───────────────────────────────────────────
function updateHeartbeat(hb) {
  const remainingMs = hb.threshold - hb.elapsed;
  const dasBlock = document.querySelector('.das-block');

  if (remainingMs <= 0 || hb.status === 'TRIGGERED') {
    hbTimer.textContent = '00:00:00';
    hbTimer.className = 'das-timer danger';
    hbFill.style.width = '0%';
    hbFill.style.background = 'var(--red)';
    hbFill.style.boxShadow = '0 0 8px var(--red)';
    if (dasBlock) dasBlock.style.borderColor = 'var(--red)';
    return;
  }

  const fmt = ms => {
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${String(h).padStart(3, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  hbTimer.textContent = fmt(remainingMs);
  hbFill.style.width = Math.max(0, (remainingMs / hb.threshold) * 100) + '%';

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
  try {
    await fetch('/api/transact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, purpose, recipient })
    });
  } catch (e) { console.error(e); }
}

async function savePolicy() {
  const text = policyEditor.value;
  btnSave.textContent = 'PUSHING…';
  btnSave.classList.add('pushing');
  try {
    await fetch('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (e) {
    console.error(e);
    btnSave.textContent = 'ERROR';
    btnSave.classList.remove('pushing');
  }
}

function flashSave() {
  btnSave.classList.remove('pushing');
  btnSave.classList.add('saved');
  btnSave.innerHTML = '&#10003; DEPLOYED';
  setTimeout(() => { btnSave.classList.remove('saved'); btnSave.textContent = 'PUSH POLICY'; }, 2000);
}

// Client-side red team: fire a sequence of adversarial probes at the firewall.
async function runRedTeam() {
  if (isProcessing) return;
  isProcessing = true;
  logLLM(`<span style="color:var(--cyan)">[RED TEAM] Spawning adversarial probes…</span>`);
  const probes = [
    { amount: 49.99, purpose: 'Just-under-limit API payment', recipient: 'EdgeCaseAPI' },
    { amount: 75.00, purpose: 'Oversized single payment', recipient: 'GreedyVendor' },
    { amount: 0.49, purpose: 'Legit oracle search query', recipient: 'OracleFeed' },
    { amount: 9.99, purpose: 'Search query (over per-search cap)', recipient: 'SearchAPI' },
    { amount: 20.00, purpose: 'Payment to BlockedVendor backend', recipient: 'BlockedVendor' }
  ];
  for (const p of probes) {
    await sendTransaction(p.amount, p.purpose, p.recipient);
    await new Promise(r => setTimeout(r, 900));
  }
  logLLM(`<span style="color:var(--cyan)">[RED TEAM] Probe sweep complete — check the feed for blocks.</span>`);
  isProcessing = false;
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
    if (btn.id === 'btn-adversarial') return;
    const { amount, purpose, recipient } = btn.dataset;
    sendTransaction(parseFloat(amount), purpose, recipient);
  });
});

btnSave.addEventListener('click', savePolicy);
if (btnAdversarial) btnAdversarial.addEventListener('click', runRedTeam);

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (document.activeElement === policyEditor) savePolicy();
  }
});

['btn-enter-dash-2', 'btn-enter-dash-3'].forEach(id => {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', showDashboard);
});

// Smooth-scroll for in-page nav links
document.querySelectorAll('.lp-links a, a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth' }); }
  });
});

// ─── Scroll Reveal (heavy fade-up + blur) ────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(ent => {
    if (ent.isIntersecting) { ent.target.classList.add('in'); revealObserver.unobserve(ent.target); }
  });
}, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

connect();
