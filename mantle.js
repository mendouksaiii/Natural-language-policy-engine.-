/**
 * mantle.js — SENTINEL's on-chain layer for Mantle Sepolia.
 *
 * Responsibilities:
 *   • read the live USDC + MNT balances of the agent vault
 *   • turn an AI "APPROVED" decision into a single-use EIP-712 approval signed by the
 *     policy-signer key, then relay vault.executeTransfer() on Mantle
 *   • commit every decision (approve AND reject) to the on-chain SentinelRegistry
 *
 * If no deployment is present (deployments/mantle-sepolia.json missing) the module
 * reports `enabled: false` and the server transparently runs in off-chain preview
 * mode, so the dashboard is always demoable.
 */
import { ethers } from 'ethers';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPLORER = 'https://explorer.sepolia.mantle.xyz';
const USDC_DECIMALS = 6;

function artifactAbi(name) {
  return JSON.parse(readFileSync(join(__dirname, 'build', `${name}.json`), 'utf-8')).abi;
}

export const Decision = { REJECTED: 0, APPROVED: 1, AUTO_EXECUTED: 2 };

export function toUsdcUnits(usd) {
  // careful integer conversion to 6dp without float drift
  return BigInt(Math.round(Number(usd) * 10 ** USDC_DECIMALS));
}
export function fromUsdcUnits(units) {
  return Number(units) / 10 ** USDC_DECIMALS;
}
export function purposeHash(purpose) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(purpose || '')));
}
export function policyHash(text) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(text || '')));
}

/** Deterministic, valid checksum address for a named vendor (demo recipient). */
export function vendorAddress(name) {
  const h = ethers.keccak256(ethers.toUtf8Bytes('sentinel-vendor:' + String(name || 'unknown')));
  return ethers.getAddress('0x' + h.slice(-40));
}

/** Use a real address if one was supplied, else derive a stable demo address. */
export function resolveRecipient(recipient) {
  if (typeof recipient === 'string' && ethers.isAddress(recipient)) return ethers.getAddress(recipient);
  return vendorAddress(recipient);
}

export function txUrl(hash) {
  return `${EXPLORER}/tx/${hash}`;
}
export function addrUrl(addr) {
  return `${EXPLORER}/address/${addr}`;
}

class MantleLayer {
  constructor() {
    this.enabled = false;
    this.reason = 'not initialized';
    this.deployment = null;
  }

  async init() {
    const depPath = join(__dirname, 'deployments', 'mantle-sepolia.json');
    if (!existsSync(depPath)) {
      this.reason = 'no deployment (run npm run deploy:mantle)';
      return this;
    }
    if (!process.env.DEPLOYER_KEY || !process.env.POLICY_SIGNER_KEY) {
      this.reason = 'missing DEPLOYER_KEY / POLICY_SIGNER_KEY';
      return this;
    }

    try {
      this.deployment = JSON.parse(readFileSync(depPath, 'utf-8'));
      this.rpc = process.env.MANTLE_RPC_URL || this.deployment.rpcUrl;
      this.chainId = Number(process.env.MANTLE_CHAIN_ID || this.deployment.chainId || 5003);
      this.provider = new ethers.JsonRpcProvider(this.rpc, this.chainId);

      // relayer pays gas + writes audit log; policy signer authorizes spends
      this.relayer = new ethers.Wallet(process.env.DEPLOYER_KEY, this.provider);
      this.policySigner = new ethers.Wallet(process.env.POLICY_SIGNER_KEY);

      const c = this.deployment.contracts;
      this.usdc = new ethers.Contract(c.MockUSDC, artifactAbi('MockUSDC'), this.provider);
      this.vault = new ethers.Contract(c.SentinelVault, artifactAbi('SentinelVault'), this.relayer);
      this.registry = new ethers.Contract(c.SentinelRegistry, artifactAbi('SentinelRegistry'), this.relayer);

      // sanity: confirm the policy signer matches what the vault expects
      const onChainSigner = await this.vault.policySigner();
      if (onChainSigner.toLowerCase() !== this.policySigner.address.toLowerCase()) {
        this.reason = `policy-signer mismatch (vault expects ${onChainSigner})`;
        return this;
      }

      this.domain = {
        name: 'SENTINEL',
        version: '2',
        chainId: this.chainId,
        verifyingContract: c.SentinelVault
      };
      this.types = {
        Approval: [
          { name: 'token', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'purposeHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' }
        ]
      };

      this.enabled = true;
      this.reason = 'live';
    } catch (e) {
      this.reason = `init error: ${e.message}`;
      this.enabled = false;
    }
    return this;
  }

  status() {
    return {
      enabled: this.enabled,
      reason: this.reason,
      chainId: this.chainId || 5003,
      explorer: EXPLORER,
      contracts: this.deployment?.contracts || null,
      relayer: this.relayer?.address || null,
      policySigner: this.policySigner?.address || null
    };
  }

  /** Live vault balances. Returns { usdc: Number, mnt: Number, raw } or null. */
  async balances() {
    if (!this.enabled) return null;
    const vaultAddr = this.deployment.contracts.SentinelVault;
    const [usdcUnits, mntWei] = await Promise.all([
      this.usdc.balanceOf(vaultAddr),
      this.provider.getBalance(vaultAddr)
    ]);
    return {
      usdc: fromUsdcUnits(usdcUnits),
      mnt: Number(ethers.formatEther(mntWei)),
      raw: { usdcUnits: usdcUnits.toString(), mntWei: mntWei.toString() }
    };
  }

  _nonce() {
    return BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000));
  }

  /**
   * Sign an EIP-712 approval (the AI's on-chain authorization) and relay the transfer.
   * @returns {Promise<{txHash, blockNumber, nonce, deadline, to, signature}>}
   */
  async executeTransfer({ to, usd, purpose, native = false }) {
    if (!this.enabled) throw new Error('on-chain layer disabled');
    const token = native ? ethers.ZeroAddress : this.deployment.contracts.MockUSDC;
    const amount = native ? ethers.parseEther(String(usd)) : toUsdcUnits(usd);
    const pHash = purposeHash(purpose);
    const nonce = this._nonce();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const signature = await this.policySigner.signTypedData(this.domain, this.types, {
      token,
      to,
      amount,
      purposeHash: pHash,
      nonce,
      deadline
    });

    const tx = native
      ? await this.vault.executeNativeTransfer(to, amount, pHash, nonce, deadline, signature)
      : await this.vault.executeTransfer(token, to, amount, pHash, nonce, deadline, signature);
    const receipt = await tx.wait();

    return {
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      to,
      signature
    };
  }

  /** Commit a decision to the on-chain audit registry. Best-effort. */
  async logDecision({ decision, to, usd, purpose, policyText, reason }) {
    if (!this.enabled) return null;
    try {
      const amount = toUsdcUnits(usd || 0);
      const tx = await this.registry.logDecision(
        decision,
        to || ethers.ZeroAddress,
        amount,
        policyHash(policyText),
        purposeHash(purpose),
        String(reason || '').slice(0, 400)
      );
      const receipt = await tx.wait();
      const total = await this.registry.total();
      return { txHash: tx.hash, blockNumber: receipt.blockNumber, recordId: Number(total) - 1 };
    } catch (e) {
      return { error: e.message };
    }
  }

  async registrySize() {
    if (!this.enabled) return 0;
    try {
      return Number(await this.registry.total());
    } catch {
      return 0;
    }
  }
}

export async function initMantle() {
  return new MantleLayer().init();
}
