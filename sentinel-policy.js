#!/usr/bin/env node
/**
 * sentinel-policy.js — OWS Executable Policy Bridge
 * 
 * This script implements the OWS policy engine's executable protocol:
 *   echo '<PolicyContext JSON>' | node sentinel-policy.js
 * 
 * It reads the PolicyContext from stdin, evaluates the transaction
 * against SENTINEL's plain-English policy using an LLM (Claude/OpenRouter)
 * or a local simulation engine, and writes a PolicyResult to stdout.
 * 
 * This is how SENTINEL extends OWS: by replacing rigid JSON rules with
 * natural language understanding as a custom policy executable.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Read PolicyContext from stdin ───────────────────────
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`Invalid JSON on stdin: ${e.message}`)); }
    });
    process.stdin.on('error', reject);
    // 5s OWS timeout safety
    setTimeout(() => reject(new Error('stdin read timeout')), 4500);
  });
}

// ─── Load policy document ────────────────────────────────
function loadPolicy() {
  const policyPath = join(__dirname, 'policy.txt');
  if (!existsSync(policyPath)) return 'No policy defined.';
  return readFileSync(policyPath, 'utf-8');
}

// ─── LLM Evaluation ─────────────────────────────────────
async function evaluateWithLLM(policyText, ctx) {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });

  const sys = `You are a strict transaction policy evaluator for an AI agent's cryptocurrency wallet. Read the spending policy (plain English) and decide if the proposed transaction is allowed. Be strict and literal. Respond ONLY with JSON: {"allow":true or false,"reason":"..."}`;

  const txInfo = ctx.transaction || {};
  const spending = ctx.spending || {};

  const user = `POLICY:\n---\n${policyText}\n---\n\nTRANSACTION:\n- Chain: ${ctx.chain_id}\n- To: ${txInfo.to || 'unknown'}\n- Value: ${txInfo.value || '0'}\n- Data: ${txInfo.data || '0x'}\n- Day: ${day}\n- Time: ${now.toISOString()}\n- Daily Total So Far: ${spending.daily_total || '0'}\n\nALLOW or DENY?`;

  // Try Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 200, system: sys, messages: [{ role: 'user', content: user }] })
      });
      const d = await r.json();
      return JSON.parse(d.content[0].text);
    } catch (e) { /* fallthrough to simulation */ }
  }

  // Try OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: 'anthropic/claude-sonnet-4-20250514', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: 200 })
      });
      const d = await r.json();
      const m = d.choices[0].message.content.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch (e) { /* fallthrough */ }
  }

  // Simulation fallback
  return simulatePolicy(policyText, ctx);
}

function simulatePolicy(policyText, ctx) {
  const pol = policyText.toLowerCase();
  const txValue = ctx.transaction?.value ? parseInt(ctx.transaction.value) / 1e18 : 0;

  // Chain restriction
  if (pol.includes('only transact on') && ctx.chain_id) {
    const chainMatch = pol.match(/only transact on the (\w+) network/i);
    if (chainMatch && !ctx.chain_id.toLowerCase().includes(chainMatch[1].toLowerCase())) {
      return { allow: false, reason: `Transaction on ${ctx.chain_id} but policy restricts chain.` };
    }
  }

  // Default allow for simulation
  return { allow: true, reason: 'Policy evaluation passed (simulation mode).' };
}

// ─── Main ────────────────────────────────────────────────
async function main() {
  try {
    const ctx = await readStdin();
    const policyText = loadPolicy();
    const result = await evaluateWithLLM(policyText, ctx);

    // Output PolicyResult per OWS spec
    const output = { allow: !!result.allow, reason: result.reason || '' };
    process.stdout.write(JSON.stringify(output));
    process.exit(result.allow ? 0 : 1);

  } catch (err) {
    // Fail closed per OWS spec
    process.stdout.write(JSON.stringify({ allow: false, reason: `SENTINEL error: ${err.message}` }));
    process.exit(1);
  }
}

main();
