#!/usr/bin/env node
/**
 * compile.js — compile the SENTINEL contracts with solc and emit artifacts
 * (abi + bytecode) to build/<Name>.json. No Hardhat/Foundry required; the only
 * build dependency is the pinned solc 0.8.24 npm package.
 */
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(__dirname, '..', 'contracts');
const buildDir = join(__dirname, '..', 'build');
mkdirSync(buildDir, { recursive: true });

const sources = {};
for (const file of readdirSync(contractsDir).filter((f) => f.endsWith('.sol'))) {
  sources[file] = { content: readFileSync(join(contractsDir, file), 'utf-8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', // Mantle is EVM-equivalent; paris avoids PUSH0 edge cases
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  }
};

console.log('  solc:', solc.version());
const out = JSON.parse(solc.compile(JSON.stringify(input)));

if (out.errors) {
  let fatal = false;
  for (const e of out.errors) {
    console.log(e.formattedMessage);
    if (e.severity === 'error') fatal = true;
  }
  if (fatal) {
    console.error('\n  Compilation failed.');
    process.exit(1);
  }
}

let count = 0;
for (const file of Object.keys(out.contracts || {})) {
  for (const [name, c] of Object.entries(out.contracts[file])) {
    writeFileSync(
      join(buildDir, `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2)
    );
    count++;
    console.log(`  built  ${name}  (${(c.evm.bytecode.object.length / 2).toLocaleString()} bytes)`);
  }
}
console.log(`\n  ${count} contract(s) -> build/\n`);
