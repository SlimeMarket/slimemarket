/**
 * Compile one or more Solidity contracts using solc.
 * Outputs ABI + bytecode to contracts/<Name>.json
 *
 * Usage:
 *   node scripts/compile-contract.mjs                  # default: MarketEscrow.sol
 *   node scripts/compile-contract.mjs MultisigTreasury # MultisigTreasury.sol
 *   node scripts/compile-contract.mjs MarketEscrow MultisigTreasury  # both
 */
import solc from "solc";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["MarketEscrow"];

function findImports(importPath) {
  const ozPath = resolve(ROOT, "node_modules", importPath);
  try {
    return { contents: readFileSync(ozPath, "utf8") };
  } catch {
    return { error: `File not found: ${importPath}` };
  }
}

let totalErrors = 0;

for (const name of names) {
  const sourceFile = `contracts/${name}.sol`;
  const sourcePath = resolve(ROOT, sourceFile);
  const outputPath = resolve(ROOT, `contracts/${name}.json`);

  let source;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch (e) {
    console.error(`✗ ${name}: source not found (${sourcePath})`);
    totalErrors++;
    continue;
  }

  const input = {
    language: "Solidity",
    sources: {
      [`${name}.sol`]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  console.log(`Compiling ${name}.sol...`);
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  if (output.errors) {
    const errors = output.errors.filter((e) => e.severity === "error");
    if (errors.length > 0) {
      console.error(`✗ ${name}: compilation errors:`);
      errors.forEach((e) => console.error("  " + e.formattedMessage));
      totalErrors += errors.length;
      continue;
    }
    output.errors.filter((e) => e.severity === "warning").forEach((w) => {
      console.warn(`  [${name}] warning: ${w.message}`);
    });
  }

  const contract = output.contracts[`${name}.sol`][name];
  if (!contract) {
    console.error(`✗ ${name}: contract not found in output`);
    totalErrors++;
    continue;
  }
  const abi = contract.abi;
  const bytecode = "0x" + contract.evm.bytecode.object;

  writeFileSync(outputPath, JSON.stringify({ abi, bytecode }, null, 2));
  console.log(`✓ ${name} → ${outputPath}  (ABI: ${abi.length}, bytecode: ${bytecode.length} chars)`);
}

if (totalErrors > 0) {
  console.error(`\n${totalErrors} error(s).`);
  process.exit(1);
}
console.log("\nDone.");
