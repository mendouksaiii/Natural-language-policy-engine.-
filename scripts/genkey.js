#!/usr/bin/env node
/**
 * genkey.js — generate fresh throwaway keys for a Mantle Sepolia deployment.
 *
 * Produces two keys:
 *   DEPLOYER_KEY     — pays gas, deploys contracts, relays vault executions
 *   POLICY_SIGNER_KEY — the AI policy-oracle key; signs EIP-712 approvals (no gas)
 *
 * These are DEV keys for a public testnet. Never reuse them on mainnet.
 * Run once, fund the printed deployer address from https://faucet.sepolia.mantle.xyz,
 * then `npm run deploy:mantle`.
 */
import { Wallet } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

const deployer = Wallet.createRandom();
const signer = Wallet.createRandom();

let env = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';

function upsert(key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) env = env.replace(re, line);
  else env += (env.endsWith('\n') || env === '' ? '' : '\n') + line + '\n';
}

upsert('MANTLE_RPC_URL', 'https://rpc.sepolia.mantle.xyz');
upsert('MANTLE_CHAIN_ID', '5003');
upsert('DEPLOYER_KEY', deployer.privateKey);
upsert('POLICY_SIGNER_KEY', signer.privateKey);

writeFileSync(envPath, env, 'utf-8');

console.log('\n  Fresh Mantle Sepolia dev keys written to .env\n');
console.log('  DEPLOYER (fund this one with test MNT):');
console.log(`    address: ${deployer.address}`);
console.log('  POLICY SIGNER (the AI oracle — needs no gas):');
console.log(`    address: ${signer.address}`);
console.log('\n  Next:');
console.log('    1. Fund the deployer at https://faucet.sepolia.mantle.xyz');
console.log('    2. npm run deploy:mantle\n');
