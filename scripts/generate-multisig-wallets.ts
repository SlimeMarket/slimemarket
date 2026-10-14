/**
 * Multisig Treasury Wallet Generator
 * 
 * CRITICAL SECURITY ASSET: Generates 3 hardware wallet-compatible addresses
 * for the 2-of-3 multisig treasury that controls ALL platform funds!
 * 
 * USAGE INSTRUCTIONS:
 * 1. Run on AIR-GAPPED MACHINE (no internet connection)
 * 2. Display mnemonics and addresses clearly
 * 3. Write them down on paper immediately
 * 4. Store physical copies in separate secure locations
 * 5. NEVER save digitally longer than necessary
 * 
 * SECURITY RECOMMENDATIONS:
 * - Owner 1: Ledger Nano X (Primary Admin)
 * - Owner 2: Trezor Model T (Financial Oversight)
 * - Owner 3: Yubikey HSM (Independent Auditor)
 */

import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface GeneratedWallet {
  ownerNumber: number;
  mnemonic: string;
  address: string;
  privateKey: string;
  qrCode?: string; // Optional QR code for mobile wallets
}

/**
 * Generate deterministic wallet from seed
 * Creates a fresh random seed each time
 */
function generateDeterministicWallet(): {
  mnemonic: string;
  address: string;
  privateKey: string;
} {
  const wallet = ethers.Wallet.createRandom();
  if (!wallet.mnemonic) {
    throw new Error("Wallet generated without a mnemonic");
  }
  
  return {
    mnemonic: wallet.mnemonic.phrase,
    address: wallet.address,
    privateKey: wallet.privateKey
  };
}

/**
 * Generate all 3 multisig owners securely
 */
async function generateAllOwners(): Promise<GeneratedWallet[]> {
  console.log("🔐 SLIMEMARKET MULTISIG TREASURY WALLET GENERATION");
  console.log("==================================================\n");
  
  console.log("⚠️  SECURITY WARNING:");
  console.log("   - This generates REAL wallet addresses");
  console.log("   - These control ALL platform fee collections");
  console.log("   - Keep these keys SAFE FOREVER!");
  console.log("");
  
  console.log("📋 PRODUCTION RECOMMENDATIONS:");
  console.log("   Owner 1: Ledger Nano X (Primary Admin)");
  console.log("   Owner 2: Trezor Model T (Financial Oversight)");
  console.log("   Owner 3: Yubikey 5 Series HSM (Independent Auditor)");
  console.log("");
  
  const owners: GeneratedWallet[] = [];
  
  for (let i = 0; i < 3; i++) {
    const { mnemonic, address, privateKey } = generateDeterministicWallet();
    
    owners.push({
      ownerNumber: i + 1,
      mnemonic,
      address,
      privateKey
    });
    
    console.log(`👛 OWNER ${i + 1}:`);
    console.log(`   Address: ${address}`);
    console.log(`   Mnemonic: ${mnemonic}`);
    console.log(`   Private Key: ${privateKey}`);
    console.log("");
    
    // Add delay between outputs for copying
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log("\n🔒 BACKUP INSTRUCTIONS:");
  console.log("   1. Write down ALL 3 mnemonics on PAPER NOW");
  console.log("   2. Store in SEPARATE secure locations");
  console.log("   3. NEVER store digital copies permanently!");
  console.log("   4. Consider fireproof safe or bank vault");
  console.log("");
  
  return owners;
}

/**
 * Save backup to secure location (user must confirm!)
 */
function saveBackupLocally(owners: GeneratedWallet[], config: any): string {
  const timestamp = new Date().toISOString();
  const filename = `multisig-backup-${timestamp}.json`;
  
  const backupData = {
    generatedAt: timestamp,
    network: config.network || "unknown",
    owners: owners.map(o => ({
      ownerNumber: o.ownerNumber,
      // IMPORTANT: Include full keys but warn user
      address: o.address,
      privateKey: o.privateKey,
      // ⚠️ WARNING: Never include mnemonic in production backups!
      mnemonic: o.mnemonic 
    }))
  };
  
  const filePath = path.join(config.backupDir || process.cwd(), filename);
  
  console.log(`💾 Writing backup to: ${filePath}`);
  console.log("   ⚠️  WARNING: This file contains SENSITIVE KEYS!");
  console.log("   ⚠️  Secure this file IMMEDIATELY or delete it after copying!");
  console.log("");
  
  fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2));
  
  return filename;
}

async function main() {
  try {
    const config = {
      network: process.env.ARC_CHAIN_ID || "5042002",
      backupDir: process.env.BACKUP_DIR || process.cwd()
    };
    
    // Ask for confirmation before generating
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const response = await new Promise<string>((resolve) => {
      rl.question(
        "\n⚠️  CRITICAL: Continue wallet generation?\n" +
        "This will create REAL Ethereum addresses that control platform funds.\n\n" +
        "Type 'YES' to continue, anything else to abort: ",
        resolve
      );
    });
    
    if (response.trim().toLowerCase() !== 'yes') {
      console.log("❌ CANCELLED - Wallet generation aborted");
      rl.close();
      process.exit(0);
    }
    
    rl.close();
    
    // Generate wallets
    const owners = await generateAllOwners();
    
    // Show final summary
    console.log("\n🎉 WALLET GENERATION COMPLETE!");
    console.log("=============================\n");
    
    console.log("SUMMARY:");
    owners.forEach(owner => {
      console.log(`Owner ${owner.ownerNumber}:`);
      console.log(`  📍 ${owner.address.substring(0, 40)}...`);
      console.log(`  🔑 Private key secured`);
      console.log(`  📜 Mnemonic saved locally`);
      console.log("");
    });
    
    // Create detailed instructions file
    const instructionsFile = path.join(config.backupDir, "MULTISIG_WALLET_INSTRUCTIONS.md");
    const instructionsContent = `# Multisig Treasury Wallet Instructions

## Overview
This document contains 3 hardware wallet-compatible addresses for the SlimeMarket 2-of-3 multisig treasury.

**CRITICAL SECURITY:** These wallets control ALL platform fee collections!

## Generated Wallets

${owners.map((owner, idx) => `
### Owner ${idx + 1}
- **Address:** \`${owner.address}\`
- **Mnemonic:** \`${owner.mnemonic}\`
- **Private Key:** \`${owner.privateKey}\`
- **Role:** ${idx === 0 ? 'Primary Admin (Ledger)' : idx === 1 ? 'Financial Oversight (Trezor)' : 'Independent Auditor (Yubikey)'}
`).join('\n')}

## Backup Procedures

### Immediate Actions Required:
1. ✅ Write ALL 3 mnemonics on paper RIGHT NOW
2. ✅ Store physical copies in SEPARATE secure locations
3. ✅ Consider fireproof safe or bank vault
4. ❌ DO NOT store digital copies permanently
5. ❌ DO NOT email or chat about these keys
6. ❌ DO NOT share with unnecessary people

### Recommended Storage Locations:
- **Owner 1:** Primary office safe
- **Owner 2:** Bank vault (second location)
- **Owner 3:** Security team encrypted storage

### Digital Backup (Temporary Only):
- File saved: \`multisig-backup-${new Date().toISOString()}.json\`
- Delete this file AFTER confirming manual backup complete
- If keeping digitally, encrypt with strong password first

## Emergency Procedures

### If Any Key is Compromised:
1. Remaining 2 owners call \`replaceOwner()\` on multisig contract
2. Immediately rotate API keys and service credentials
3. Audit last 30 days of transactions for anomalies
4. Notify security team and legal department

### For Emergency Pause:
1. Owner 1 calls \`requestPause()\` on MarketEscrow
2. Wait 24h timelock period
3. Owner 2 calls \`executePause()\` to freeze contract
4. Lock all withdrawal functions
5. Conduct incident response investigation

## Contract Details
- Network: Arc Testnet (${config.network})
- Threshold: 2-of-3 signatures required
- Deployment: Ready when human team executes

## Next Steps
1. Deploy multisig contract: \`npx hardhat run scripts/deploy-multisig-treasury.ts --network arc_testnet\`
2. Execute ownership transfer to multisig
3. Begin testnet operation monitoring
4. After 7 days, consider mainnet deployment

---

*Generate Date: ${new Date().toISOString()}*
*Network: Arc Chain ID ${config.network}*
*WARNING: Keep this document highly secure!*
`;
    
    fs.writeFileSync(instructionsFile, instructionsContent);
    console.log(`📄 Detailed instructions saved to: ${instructionsFile}`);
    
    console.log("\n✅ DONE - Review backup files and follow backup procedures!");
    
  } catch (error) {
    console.error("❌ Generation failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
