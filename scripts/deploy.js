#!/usr/bin/env node
/**
 * deploy.js — deploy SENTINEL to Mantle Sepolia (chainId 5003).
 *
 * Deploys MockUSDC, SentinelRegistry and SentinelVault, wires roles, seeds the
 * vault with test USDC, and writes deployments/mantle-sepolia.json (consumed by the
 * backend at runtime). Idempotent-ish: re-running redeploys fresh instances.
 */
import { ethers } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function artifact(name) {
  return JSON.parse(readFileSync(join(root, 'build', `${name}.json`), 'utf-8'));
}

async function deploy(name, signer, args = []) {
  const { abi, bytecode } = artifact(name);
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${name.padEnd(18)} ${addr}`);
  return c;
}

async function main() {
  const RPC = process.env.MANTLE_RPC_URL || 'https://rpc.sepolia.mantle.xyz';
  const CHAIN_ID = Number(process.env.MANTLE_CHAIN_ID || 5003);
  if (!process.env.DEPLOYER_KEY) throw new Error('DEPLOYER_KEY missing — run `npm run genkey` first.');
  if (!process.env.POLICY_SIGNER_KEY) throw new Error('POLICY_SIGNER_KEY missing — run `npm run genkey` first.');

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  const policySigner = new ethers.Wallet(process.env.POLICY_SIGNER_KEY);

  const bal = await provider.getBalance(deployer.address);
  console.log(`\n  Network:       Mantle Sepolia (${CHAIN_ID})`);
  console.log(`  Deployer:      ${deployer.address}`);
  console.log(`  Balance:       ${ethers.formatEther(bal)} MNT`);
  console.log(`  Policy signer: ${policySigner.address}\n`);
  if (bal === 0n) {
    throw new Error('Deployer has 0 MNT. Fund it at https://faucet.sepolia.mantle.xyz and retry.');
  }

  console.log('  Deploying:');
  const usdc = await deploy('MockUSDC', deployer);
  const registry = await deploy('SentinelRegistry', deployer);
  const vault = await deploy('SentinelVault', deployer, [policySigner.address, await registry.getAddress()]);

  console.log('\n  Wiring:');
  // Allow the backend relayer (deployer) to write audit records (already owner+writer).
  // Seed the vault with 25,000 test USDC so the demo can spend immediately.
  const seed = 25_000n * 10n ** 6n;
  let tx = await usdc.mint(await vault.getAddress(), seed);
  await tx.wait();
  console.log(`  minted         25,000 USDC -> vault`);

  // Send a little MNT into the vault so native-transfer demo works too.
  const mntSeed = ethers.parseEther('0.05');
  if (bal > mntSeed * 3n) {
    tx = await deployer.sendTransaction({ to: await vault.getAddress(), value: mntSeed });
    await tx.wait();
    console.log(`  funded         0.05 MNT -> vault`);
  }

  const blockNumber = await provider.getBlockNumber();
  const out = {
    network: 'mantle-sepolia',
    chainId: CHAIN_ID,
    rpcUrl: RPC,
    explorer: 'https://explorer.sepolia.mantle.xyz',
    deployedAt: new Date().toISOString(),
    deployBlock: blockNumber,
    deployer: deployer.address,
    policySigner: policySigner.address,
    contracts: {
      MockUSDC: await usdc.getAddress(),
      SentinelRegistry: await registry.getAddress(),
      SentinelVault: await vault.getAddress()
    }
  };
  mkdirSync(join(root, 'deployments'), { recursive: true });
  writeFileSync(join(root, 'deployments', 'mantle-sepolia.json'), JSON.stringify(out, null, 2));

  console.log('\n  Saved deployments/mantle-sepolia.json');
  console.log('\n  Explorer:');
  console.log(`    vault:    https://explorer.sepolia.mantle.xyz/address/${out.contracts.SentinelVault}`);
  console.log(`    registry: https://explorer.sepolia.mantle.xyz/address/${out.contracts.SentinelRegistry}`);
  console.log(`    usdc:     https://explorer.sepolia.mantle.xyz/address/${out.contracts.MockUSDC}`);
  console.log('\n  Done. Start the app with `npm start`.\n');
}

main().catch((e) => {
  console.error('\n  Deploy failed:', e.message, '\n');
  process.exit(1);
});
