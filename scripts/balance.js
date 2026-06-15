#!/usr/bin/env node
/**
 * balance.js — quick MNT balance check for the deployer (pre-deploy sanity).
 */
import { ethers } from 'ethers';
import 'dotenv/config';

const RPC = process.env.MANTLE_RPC_URL || 'https://rpc.sepolia.mantle.xyz';
const CHAIN_ID = Number(process.env.MANTLE_CHAIN_ID || 5003);

if (!process.env.DEPLOYER_KEY) {
  console.error('  DEPLOYER_KEY missing — run `npm run genkey` first.');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
const bal = await provider.getBalance(wallet.address);

console.log(`  Deployer: ${wallet.address}`);
console.log(`  Balance:  ${ethers.formatEther(bal)} MNT`);
console.log(bal === 0n
  ? '\n  Empty. Fund at https://faucet.sepolia.mantle.xyz then `npm run deploy:mantle`.\n'
  : '\n  Funded. Ready to `npm run deploy:mantle`.\n');
