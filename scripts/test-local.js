#!/usr/bin/env node
/**
 * test-local.js — prove SENTINEL's core enforcement against a local EVM (ganache).
 *
 * This exercises the real deployed bytecode of all three contracts and verifies the
 * one property the project lives or dies on: funds move IF AND ONLY IF accompanied by
 * a valid, single-use, AI-signed EIP-712 approval. No Mantle faucet required.
 *
 *   npm run test:local
 */
import ganache from 'ganache';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const art = (n) => JSON.parse(readFileSync(join(root, 'build', `${n}.json`), 'utf-8'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}`); fail++; }
}
async function expectRevert(name, promise) {
  try { await promise; check(name + ' (should revert)', false); }
  catch { check(name, true); }
}

async function deploy(name, signer, args = []) {
  const { abi, bytecode } = art(name);
  const f = new ethers.ContractFactory(abi, bytecode, signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function main() {
  console.log('\n  SENTINEL — local enforcement test (ganache EVM)\n');

  const gProvider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 5003 } });
  const provider = new ethers.BrowserProvider(gProvider);
  const relayer = await provider.getSigner(0);          // pays gas, relays
  const policySigner = ethers.Wallet.createRandom();     // the AI oracle key
  const attacker = ethers.Wallet.createRandom();         // not authorized

  const usdc = await deploy('MockUSDC', relayer);
  const registry = await deploy('SentinelRegistry', relayer);
  const vault = await deploy('SentinelVault', relayer, [policySigner.address, await registry.getAddress()]);
  console.log('  deployed MockUSDC / SentinelRegistry / SentinelVault\n');

  const vaultAddr = await vault.getAddress();
  const usdcAddr = await usdc.getAddress();
  await (await usdc.mint(vaultAddr, 1_000_000_000n)).wait(); // 1,000 USDC

  const chainId = Number((await provider.getNetwork()).chainId);
  const domain = { name: 'SENTINEL', version: '2', chainId, verifyingContract: vaultAddr };
  const types = {
    Approval: [
      { name: 'token', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }, { name: 'purposeHash', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
    ]
  };
  const to = ethers.Wallet.createRandom().address;
  const amount = 42_000_000n; // 42 USDC
  const purposeHash = ethers.keccak256(ethers.toUtf8Bytes('GPU compute hour'));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce = 1n;
  const value = { token: usdcAddr, to, amount, purposeHash, nonce, deadline };

  // 1) Approved spend with a valid AI signature settles and moves USDC.
  const goodSig = await policySigner.signTypedData(domain, types, value);
  await (await vault.executeTransfer(usdcAddr, to, amount, purposeHash, nonce, deadline, goodSig)).wait();
  check('valid AI approval transfers USDC to recipient', (await usdc.balanceOf(to)) === amount);
  check('vault balance debited by the amount', (await usdc.balanceOf(vaultAddr)) === 958_000_000n);
  check('nonce burned after use', (await vault.isNonceUsed(nonce)) === true);

  // 2) Replay of the same approval is rejected.
  await expectRevert('replaying a used nonce reverts',
    vault.executeTransfer(usdcAddr, to, amount, purposeHash, nonce, deadline, goodSig));

  // 3) A signature from anyone other than the policy signer is rejected.
  const forged = await attacker.signTypedData(domain, types, { ...value, nonce: 2n });
  await expectRevert('forged signature (wrong signer) reverts',
    vault.executeTransfer(usdcAddr, to, amount, purposeHash, 2n, deadline, forged));

  // 4) An expired approval is rejected even with a valid signature.
  const past = BigInt(Math.floor(Date.now() / 1000) - 10);
  const expiredVal = { ...value, nonce: 3n, deadline: past };
  const expiredSig = await policySigner.signTypedData(domain, types, expiredVal);
  await expectRevert('expired approval reverts',
    vault.executeTransfer(usdcAddr, to, amount, purposeHash, 3n, past, expiredSig));

  // 5) The audit registry records decisions immutably.
  await (await registry.logDecision(1 /*APPROVED*/, to, amount, ethers.keccak256(ethers.toUtf8Bytes('policy')), purposeHash, 'within limits')).wait();
  await (await registry.logDecision(0 /*REJECTED*/, to, 150_000_000n, ethers.keccak256(ethers.toUtf8Bytes('policy')), purposeHash, 'blocked vendor')).wait();
  check('registry logged 2 on-chain decisions', Number(await registry.total()) === 2);

  // 6) A non-writer cannot pollute the audit log.
  const outsider = await provider.getSigner(1); // funded ganache account, but not a writer
  await expectRevert('unauthorized writer cannot log to registry',
    registry.connect(outsider).logDecision(1, to, amount, purposeHash, purposeHash, 'x'));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await gProvider.disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n  test error:', e.message, '\n'); process.exit(1); });
