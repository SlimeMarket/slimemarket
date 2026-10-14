import { expect } from "chai";
import hre from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs.js";

// Hardhat 2 runs mocha test files through Node's ESM loader
// (package.json "type": "module"), so CJS require() is unavailable here.
const { ethers } = hre;

describe("OperatorsGovernance", function () {
  let operatorsGovernance;
  let OperatorsGovernanceFactory;
  let owner, operator1, operator2, randomUser;

  const SECONDS_PER_DAY = 86400;
  const MIN_DAILY_LIMIT = ethers.parseEther("1"); // 1 ETH
  const MAX_DAILY_LIMIT = ethers.parseEther("100"); // 100 ETH
  const EMERGENCY_THRESHOLD = ethers.parseEther("500"); // 500 ETH

  beforeEach(async function () {
    [owner, operator1, operator2, randomUser] = await ethers.getSigners();

    // Deploy new contract for each test
    OperatorsGovernanceFactory = await ethers.getContractFactory("OperatorsGovernance");
    operatorsGovernance = await OperatorsGovernanceFactory.deploy(
      owner.address, // treasury placeholder
      MIN_DAILY_LIMIT,
      MAX_DAILY_LIMIT,
      EMERGENCY_THRESHOLD
    );
    await operatorsGovernance.waitForDeployment();
  });

  describe("Contract Initialization", function () {
    it("Should initialize with correct configuration", async function () {
      const config = await operatorsGovernance.config();
      expect(config.treasury).to.equal(owner.address);
      expect(config.minDailyLimit).to.equal(MIN_DAILY_LIMIT);
      expect(config.maxDailyLimit).to.equal(MAX_DAILY_LIMIT);
      expect(config.emergencyThreshold).to.equal(EMERGENCY_THRESHOLD);
      expect(await operatorsGovernance.SECONDS_PER_DAY()).to.equal(SECONDS_PER_DAY);
    });

    it("Should reject invalid initialization values", async function () {
      // Min limit too high
      await expect(
        OperatorsGovernanceFactory.deploy(owner.address, MAX_DAILY_LIMIT, MIN_DAILY_LIMIT, EMERGENCY_THRESHOLD)
      ).to.be.revertedWith("Max must be greater than min");

      // Zero minimum limit
      await expect(
        OperatorsGovernanceFactory.deploy(owner.address, 0, MAX_DAILY_LIMIT, EMERGENCY_THRESHOLD)
      ).to.be.revertedWith("Minimum limit must be > 0");
    });
  });

  describe("Operator Management", function () {
    const dailyLimit = ethers.parseEther("10"); // 10 ETH

    it("Should add new operator with daily limit", async function () {
      await expect(operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit))
        .to.emit(operatorsGovernance, "OperatorAdded")
        .withArgs(operator1.address, operator1.address, dailyLimit, anyValue);

      const operatorData = await operatorsGovernance.operators(operator1.address);
      expect(operatorData.wallet).to.equal(operator1.address);
      expect(operatorData.dailyLimit).to.equal(dailyLimit);
      expect(operatorData.active).to.be.true;
    });

    it("Should reject duplicate operator", async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);

      await expect(
        operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit)
      ).to.be.revertedWith("Operator already exists");
    });

    it("Should reject zero addresses", async function () {
      await expect(
        operatorsGovernance.addOperator(operator1.address, ethers.ZeroAddress, dailyLimit)
      ).to.be.revertedWith("INVALID_ZERO_ADDRESS");

      await expect(
        operatorsGovernance.addOperator(ethers.ZeroAddress, operator1.address, dailyLimit)
      ).to.be.revertedWith("INVALID_ZERO_ADDRESS");
    });

    it("Should reject limit below minimum", async function () {
      const tooLowLimit = ethers.parseEther("0.1");

      await expect(
        operatorsGovernance.addOperator(operator1.address, operator1.address, tooLowLimit)
      ).to.be.revertedWith("Limit below minimum");
    });

    it("Should reject limit above maximum", async function () {
      const tooHighLimit = ethers.parseEther("200");

      await expect(
        operatorsGovernance.addOperator(operator1.address, operator1.address, tooHighLimit)
      ).to.be.revertedWith("Limit exceeds maximum");
    });

    it("Should remove operator successfully", async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);

      await expect(operatorsGovernance.removeOperator(operator1.address))
        .to.emit(operatorsGovernance, "OperatorRemoved")
        .withArgs(operator1.address, operator1.address, 0);

      const operatorData = await operatorsGovernance.operators(operator1.address);
      expect(operatorData.active).to.be.false;
    });

    it("Should reject removing non-existent operator", async function () {
      await expect(operatorsGovernance.removeOperator(operator1.address))
        .to.be.revertedWith("Operator not found or inactive");
    });

    it("Should track operator count correctly", async function () {
      expect(await operatorsGovernance.getOperatorCount()).to.equal(0);

      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);
      expect(await operatorsGovernance.getOperatorCount()).to.equal(1);

      await operatorsGovernance.addOperator(operator2.address, operator2.address, dailyLimit);
      expect(await operatorsGovernance.getOperatorCount()).to.equal(2);

      await operatorsGovernance.removeOperator(operator1.address);
      expect(await operatorsGovernance.getOperatorCount()).to.equal(2); // Still in list but inactive
    });
  });

  describe("Budget Checking", function () {
    const dailyLimit = ethers.parseEther("100");

    beforeEach(async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);
    });

    it("Should check budget correctly when under limit", async function () {
      const result = await operatorsGovernance.checkBudget(operator1.address, ethers.parseEther("50"));
      expect(result).to.be.true;
    });

    it("Should detect exceeding budget", async function () {
      const result = await operatorsGovernance.checkBudget(operator1.address, ethers.parseEther("150"));
      expect(result).to.be.false;
    });

    it("Should reject budget check for inactive operator", async function () {
      await operatorsGovernance.removeOperator(operator1.address);

      await expect(
        operatorsGovernance.checkBudget(operator1.address, ethers.parseEther("1"))
      ).to.be.revertedWith("Operator not active");
    });
  });

  describe("Gas Spend Recording", function () {
    const dailyLimit = ethers.parseEther("100");
    const spendAmount = ethers.parseEther("10");

    beforeEach(async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);
    });

    it("Should record gas spend accurately", async function () {
      await operatorsGovernance.recordGasSpend(operator1.address, spendAmount);

      const daySpend = await operatorsGovernance.getCurrentDaySpend();
      expect(daySpend).to.equal(spendAmount);

      const operatorData = await operatorsGovernance.operators(operator1.address);
      expect(operatorData.totalSpend).to.equal(spendAmount);
    });

    it("Should enforce daily limit strictly", async function () {
      // Record spend up to limit
      await operatorsGovernance.recordGasSpend(operator1.address, dailyLimit - spendAmount);

      // Try to exceed limit (BigInt arithmetic: exceed the daily cap by 1 wei)
      await expect(
        operatorsGovernance.recordGasSpend(operator1.address, spendAmount + 1n)
      ).to.be.revertedWith("Daily limit exceeded");
    });

    it("Should emit GasSpent event with correct data", async function () {
      await expect(operatorsGovernance.recordGasSpend(operator1.address, spendAmount))
        .to.emit(operatorsGovernance, "GasSpent")
        .withArgs(
          operator1.address,
          spendAmount,
          anyValue, // dayIndex
          dailyLimit - spendAmount // remainingBudget
        );
    });

    it("Should emit BudgetWarning at 80% utilization", async function () {
      const eightyPercent = dailyLimit * 80n / 100n;

      await expect(operatorsGovernance.recordGasSpend(operator1.address, eightyPercent))
        .to.emit(operatorsGovernance, "BudgetWarning")
        .withArgs(operator1.address, eightyPercent, dailyLimit);
    });

    it("Should reject spending by inactive operator", async function () {
      await operatorsGovernance.removeOperator(operator1.address);

      await expect(
        operatorsGovernance.recordGasSpend(operator1.address, spendAmount)
      ).to.be.revertedWith("Operator not active");
    });

    it("Should reject zero amount spend", async function () {
      await expect(
        operatorsGovernance.recordGasSpend(operator1.address, 0)
      ).to.be.revertedWith("Amount must be > 0");
    });
  });

  describe("Daily Reset Logic", function () {
    const dailyLimit = ethers.parseEther("100");

    beforeEach(async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);
      await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("10"));
    });

    it("Should reset daily counter at next day", async function () {
      const currentDay = await operatorsGovernance.getCurrentDayIndex();

      // Fast-forward to next day
      await ethers.provider.send("evm_increaseTime", [SECONDS_PER_DAY + 1]);
      await ethers.provider.send("evm_mine");

      const newDay = await operatorsGovernance.getCurrentDayIndex();
      expect(newDay).to.be.gt(currentDay);

      const newDaySpend = await operatorsGovernance.getCurrentDaySpend();
      expect(newDaySpend).to.equal(0);
    });

    it("Should maintain total lifetime spend across days", async function () {
      const initialTotal = ethers.parseEther("10");

      // Fast forward and spend again
      await ethers.provider.send("evm_increaseTime", [SECONDS_PER_DAY + 1]);
      await ethers.provider.send("evm_mine");

      await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("20"));

      const operatorData = await operatorsGovernance.operators(operator1.address);
      expect(operatorData.totalSpend).to.equal(initialTotal + ethers.parseEther("20"));
    });

    it("Should handle multiple operators on same day", async function () {
      await operatorsGovernance.addOperator(operator2.address, operator2.address, dailyLimit);

      await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("30"));
      await operatorsGovernance.recordGasSpend(operator2.address, ethers.parseEther("40"));

      const totalDaySpend = await operatorsGovernance.getCurrentDaySpend();
      // dailyGasSpend tracks the GLOBAL daily cap across all operators,
      // including the 10 ETH spent by this describe block's beforeEach.
      expect(totalDaySpend).to.equal(ethers.parseEther("80"));
    });
  });

  describe("Limit Updates", function () {
    const initialLimit = ethers.parseEther("50");
    const newLimit = ethers.parseEther("100");

    beforeEach(async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, initialLimit);
    });

    it("Should update daily limit for operator", async function () {
      await expect(operatorsGovernance.updateDailyLimit(operator1.address, newLimit))
        .to.emit(operatorsGovernance, "DailyLimitUpdated")
        .withArgs(operator1.address, newLimit, initialLimit);

      const operatorData = await operatorsGovernance.operators(operator1.address);
      expect(operatorData.dailyLimit).to.equal(newLimit);
    });

    it("Should reject updates below minimum", async function () {
      const tooLow = ethers.parseEther("0.5");

      await expect(
        operatorsGovernance.updateDailyLimit(operator1.address, tooLow)
      ).to.be.revertedWith("Limit below minimum");
    });

    it("Should reject updates above maximum", async function () {
      const tooHigh = ethers.parseEther("200");

      await expect(
        operatorsGovernance.updateDailyLimit(operator1.address, tooHigh)
      ).to.be.revertedWith("Limit exceeds maximum");
    });

    it("Should reject updating inactive operator", async function () {
      await operatorsGovernance.removeOperator(operator1.address);

      await expect(
        operatorsGovernance.updateDailyLimit(operator1.address, newLimit)
      ).to.be.revertedWith("Operator not active");
    });

    it("Should only allow owner to update limits", async function () {
      await expect(
        operatorsGovernance.connect(randomUser).updateDailyLimit(operator1.address, newLimit)
      ).to.be.revertedWithCustomError(operatorsGovernance, "OwnableUnauthorizedAccount");
    });
  });

  describe("Emergency Controls", function () {
    const dailyLimit = ethers.parseEther("100");

    beforeEach(async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);
    });

    it("Should pause operations during emergency", async function () {
      await operatorsGovernance.emergencyPause("Test emergency");

      await expect(
        operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(operatorsGovernance, "EnforcedPause");
    });

    it("Should emit EmergencyPaused event", async function () {
      await expect(operatorsGovernance.emergencyPause("Security issue"))
        .to.emit(operatorsGovernance, "EmergencyPaused")
        .withArgs(owner.address, "Security issue");
    });

    it("Should resume after pause", async function () {
      await operatorsGovernance.emergencyPause("Emergency");

      // Wait a bit for safety
      await ethers.provider.send("evm_increaseTime", [1]);
      await ethers.provider.send("evm_mine");

      // FIXED (2026-08-09, ): the guard was inverted —
      // `require(!paused(), "Cannot resume yet")` made emergencyResume()
      // unreachable while paused, so the circuit breaker could never be
      // released. The guard is now `require(paused(), ...)` and resume
      // works while paused.
      await expect(operatorsGovernance.emergencyResume())
        .to.emit(operatorsGovernance, "EmergencyResumed")
        .withArgs(owner.address);

      expect(await operatorsGovernance.paused()).to.be.false;

      // Operations work again after resume
      await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("10"));
      const op = await operatorsGovernance.getOperator(operator1.address);
      expect(op.totalSpend).to.equal(ethers.parseEther("10"));
    });

    it("Should reject resume when not paused", async function () {
      expect(await operatorsGovernance.paused()).to.be.false;

      await expect(
        operatorsGovernance.emergencyResume()
      ).to.be.revertedWith("Not paused");
    });

    it("Should only allow owner to control emergency states", async function () {
      await expect(
        operatorsGovernance.connect(randomUser).emergencyPause("Unauthorized")
      ).to.be.revertedWithCustomError(operatorsGovernance, "OwnableUnauthorizedAccount");

      await expect(
        operatorsGovernance.connect(randomUser).emergencyResume()
      ).to.be.revertedWithCustomError(operatorsGovernance, "OwnableUnauthorizedAccount");
    });
  });

  describe("Treasury Configuration Updates", function () {
    it("Should update minDailyLimit", async function () {
      const newMin = ethers.parseEther("2");

      await expect(operatorsGovernance.updateTreasuryConfig("minDailyLimit", newMin))
        .to.emit(operatorsGovernance, "TreasuryConfigUpdated")
        .withArgs("minDailyLimit", MIN_DAILY_LIMIT, newMin);

      const config = await operatorsGovernance.config();
      expect(config.minDailyLimit).to.equal(newMin);
    });

    it("Should update maxDailyLimit", async function () {
      const newMax = ethers.parseEther("200");

      await expect(operatorsGovernance.updateTreasuryConfig("maxDailyLimit", newMax))
        .to.emit(operatorsGovernance, "TreasuryConfigUpdated")
        .withArgs("maxDailyLimit", MAX_DAILY_LIMIT, newMax);

      const config = await operatorsGovernance.config();
      expect(config.maxDailyLimit).to.equal(newMax);
    });

    it("Should reject invalid config updates", async function () {
      // New min greater than old min
      await expect(
        operatorsGovernance.updateTreasuryConfig("unknownParam", 100)
      ).to.be.revertedWith("Unknown parameter");
    });

    it("Should validate config constraints", async function () {
      // Try to set min higher than current max
      await expect(
        operatorsGovernance.updateTreasuryConfig("minDailyLimit", ethers.parseEther("200"))
      ).to.be.revertedWith("Must be less than max");
    });
  });

  describe("Remaining Budget Queries", function () {
    const dailyLimit = ethers.parseEther("100");

    beforeEach(async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);
    });

    it("Should return full budget initially", async function () {
      const remaining = await operatorsGovernance.getRemainingBudget(operator1.address);
      expect(remaining).to.equal(dailyLimit);
    });

    it("Should decrease budget after spending", async function () {
      await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("30"));

      const remaining = await operatorsGovernance.getRemainingBudget(operator1.address);
      expect(remaining).to.equal(ethers.parseEther("70"));
    });

    it("Should reject query for inactive operator", async function () {
      await operatorsGovernance.removeOperator(operator1.address);

      await expect(
        operatorsGovernance.getRemainingBudget(operator1.address)
      ).to.be.revertedWith("Operator not active");
    });
  });

  describe("Integration Tests", function () {
    const dailyLimit = ethers.parseEther("1000");

    // These scenarios need 1000-ETH operator limits, so redeploy with bounds
    // that allow them (the suite-wide default instance caps at 100 ETH).
    beforeEach(async function () {
      operatorsGovernance = await OperatorsGovernanceFactory.deploy(
        owner.address,
        ethers.parseEther("100"),   // minDailyLimit
        ethers.parseEther("5000"),  // maxDailyLimit
        ethers.parseEther("10000")  // emergencyThreshold
      );
      await operatorsGovernance.waitForDeployment();
    });

    it("Should handle complete operator lifecycle", async function () {
      // Add operator
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);

      // Verify operator status
      const operatorData = await operatorsGovernance.getOperator(operator1.address);
      expect(operatorData.active).to.be.true;
      expect(operatorData.dailyLimit).to.equal(dailyLimit);

      // Multiple transactions
      for (let i = 0; i < 5; i++) {
        await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("10"));
      }

      // Check total spend
      const updatedOperator = await operatorsGovernance.getOperator(operator1.address);
      expect(updatedOperator.totalSpend).to.equal(ethers.parseEther("50"));

      // Update limit
      const newLimit = ethers.parseEther("2000");
      await operatorsGovernance.updateDailyLimit(operator1.address, newLimit);

      // Remove operator
      await operatorsGovernance.removeOperator(operator1.address);

      // Verify removal
      const finalOperator = await operatorsGovernance.getOperator(operator1.address);
      expect(finalOperator.active).to.be.false;
    });

    it("Should manage multiple operators simultaneously", async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);
      await operatorsGovernance.addOperator(operator2.address, operator2.address, dailyLimit);

      // Independent spending
      await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("50"));
      await operatorsGovernance.recordGasSpend(operator2.address, ethers.parseEther("75"));

      // Each should have correct individual tracking
      const op1 = await operatorsGovernance.getOperator(operator1.address);
      const op2 = await operatorsGovernance.getOperator(operator2.address);

      expect(op1.totalSpend).to.equal(ethers.parseEther("50"));
      expect(op2.totalSpend).to.equal(ethers.parseEther("75"));

      // Total day spend should be combined
      const totalDaySpend = await operatorsGovernance.getCurrentDaySpend();
      expect(totalDaySpend).to.equal(ethers.parseEther("125"));
    });

    it("Should respect all limits in realistic scenario", async function () {
      // Setup with realistic limits
      const realisticLimit = ethers.parseEther("100"); // 100 ETH per day

      await operatorsGovernance.addOperator(operator1.address, operator1.address, realisticLimit);

      // Simulate normal operation
      for (let day = 0; day < 3; day++) {
        // Daily spend pattern
        await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("20"));

        if (day < 2) {
          // Move to next day
          await ethers.provider.send("evm_increaseTime", [SECONDS_PER_DAY + 3600]);
          await ethers.provider.send("evm_mine");
        }
      }

      // Verify day-by-day resets worked correctly
      const currentSpend = await operatorsGovernance.getCurrentDaySpend();
      expect(currentSpend).to.equal(ethers.parseEther("20")); // Last day's spend only

      // Lifetime total should accumulate
      const operator = await operatorsGovernance.getOperator(operator1.address);
      expect(operator.totalSpend).to.equal(ethers.parseEther("60"));
    });
  });

  describe("Edge Cases & Security", function () {
    const dailyLimit = ethers.parseEther("100");

    beforeEach(async function () {
      await operatorsGovernance.addOperator(operator1.address, operator1.address, dailyLimit);
    });

    it("Should handle maximum safe amounts", async function () {
      // Use near-maximum safe value
      const maxSafe = ethers.parseEther("99.999");

      await operatorsGovernance.recordGasSpend(operator1.address, maxSafe);

      const remaining = await operatorsGovernance.getRemainingBudget(operator1.address);
      expect(remaining).to.be.closeTo(ethers.parseEther("0.001"), 1);
    });

    it("Should prevent race conditions with exact limit match", async function () {
      const exactAmount = dailyLimit - ethers.parseEther("1");

      await operatorsGovernance.recordGasSpend(operator1.address, exactAmount);

      // This should work (fills exactly to limit)
      await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("1"));

      // This should fail (exceeds limit)
      await expect(
        operatorsGovernance.recordGasSpend(operator1.address, 1)
      ).to.be.revertedWith("Daily limit exceeded");
    });

    it("Should handle rapid consecutive transactions", async function () {
      const batchSize = 10;
      const batchAmount = ethers.parseEther("1");

      for (let i = 0; i < batchSize; i++) {
        await operatorsGovernance.recordGasSpend(operator1.address, batchAmount);
      }

      const total = await operatorsGovernance.getCurrentDaySpend();
      expect(total).to.equal(ethers.parseEther("10"));
    });

    it("Should maintain integrity after many day transitions", async function () {
      for (let day = 0; day < 10; day++) {
        await operatorsGovernance.recordGasSpend(operator1.address, ethers.parseEther("10"));

        if (day < 9) {
          await ethers.provider.send("evm_increaseTime", [SECONDS_PER_DAY]);
          await ethers.provider.send("evm_mine");
        }
      }

      const operator = await operatorsGovernance.getOperator(operator1.address);
      expect(operator.totalSpend).to.equal(ethers.parseEther("100"));

      const currentDaySpend = await operatorsGovernance.getCurrentDaySpend();
      expect(currentDaySpend).to.equal(ethers.parseEther("10"));
    });
  });
});
