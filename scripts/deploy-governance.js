const { ethers } = require("hardhat");

async function main() {
  console.log("===========================================");
  console.log("🚀 Deploying OperatorsGovernance Contract");
  console.log("===========================================\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  
  const balance = await deployer.getBalance();
  console.log("Account balance:", ethers.formatEther(balance), "ETH\n");

  // Configuration parameters for the governance contract
  const treasuryAddress = deployer.address; // Placeholder - update to actual treasury address
  const minDailyLimit = ethers.parseEther("1"); // Minimum 1 ETH per day
  const maxDailyLimit = ethers.parseEther("100"); // Maximum 100 ETH per day
  const emergencyThreshold = ethers.parseEther("500"); // Emergency pause at 500 ETH total
  
  console.log("Contract Parameters:");
  console.log("- Treasury Address:", treasuryAddress);
  console.log("- Min Daily Limit:", ethers.formatEther(minDailyLimit), "ETH");
  console.log("- Max Daily Limit:", ethers.formatEther(maxDailyLimit), "ETH");
  console.log("- Emergency Threshold:", ethers.formatEther(emergencyThreshold), "ETH\n");

  try {
    // Deploy the contract
    console.log("⏳ Deploying OperatorsGovernance...");
    const OperatorsGovernance = await ethers.getContractFactory("OperatorsGovernance");
    
    const operatorsGovernance = await OperatorsGovernance.deploy(
      treasuryAddress,
      minDailyLimit,
      maxDailyLimit,
      emergencyThreshold
    );
    
    await operatorsGovernance.waitForDeployment();
    const contractAddress = await operatorsGovernance.getAddress();
    
    console.log("✅ Deployment successful!");
    console.log("Contract Address:", contractAddress);
    console.log("\n===========================================\n");

    // Verify deployment
    console.log("📋 Verification:");
    const config = await operatorsGovernance.config();
    console.log("- Treasury:", config.treasury);
    console.log("- Min Daily Limit:", ethers.formatEther(config.minDailyLimit), "ETH");
    console.log("- Max Daily Limit:", ethers.formatEther(config.maxDailyLimit), "ETH");
    console.log("- Emergency Threshold:", ethers.formatEther(config.emergencyThreshold), "ETH");
    console.log("- Owner:", await operatorsGovernance.owner());
    console.log("\n===========================================\n");

    // Print initialization instructions
    console.log("📝 Post-Deployment Instructions:");
    console.log("-------------------------------------------");
    console.log("1. Register initial operators using addOperator():");
    console.log(`   await operatorsGovernance.addOperator(`);
    console.log(`     "operatorAddress",`);
    console.log(`     "operatorWallet",`);
    console.log(`     ${ethers.parseEther("10").toString()} // Daily limit in wei`);
    console.log(`   );\n`);
    
    console.log("2. Monitor daily spending:");
    console.log(`   getCurrentDaySpend()`);
    console.log(`   getRemainingBudget(operatorAddress)\n`);
    
    console.log("3. Update limits as needed:");
    console.log(`   updateDailyLimit(operatorAddress, newLimitInWei)\n`);
    
    console.log("4. Emergency controls:");
    console.log(`   emergencyPause("reason")`);
    console.log(`   emergencyResume()\n`);
    
    console.log("===========================================");
    console.log("🎉 OperatorsGovernance deployed successfully!");
    console.log("===========================================");

    // Save deployment info
    const fs = require("fs");
    const deploymentInfo = {
      network: process.env.HARDHAT_NETWORK || "local",
      contractName: "OperatorsGovernance",
      address: contractAddress,
      deployer: deployer.address,
      timestamp: new Date().toISOString(),
      parameters: {
        treasury: treasuryAddress,
        minDailyLimit: minDailyLimit.toString(),
        maxDailyLimit: maxDailyLimit.toString(),
        emergencyThreshold: emergencyThreshold.toString()
      },
      txnHash: null // Will be filled after transaction confirmation
    };
    
    fs.writeFileSync(
      "deployment-info.json",
      JSON.stringify(deploymentInfo, null, 2)
    );
    console.log(`\n💾 Deployment info saved to deployment-info.json`);

  } catch (error) {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
