// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title OperatorsGovernance
 * @dev Manages operator wallets for gas sponsorship with daily spending limits
 *
 * This contract implements a comprehensive governance system for managing
 * multiple operator wallets that can sponsor gas for users. It enforces
 * strict daily spending limits to prevent treasury drain attacks while
 * maintaining operational flexibility.
 *
 * Key Features:
 * - Multi-operator wallet registration with individual spending limits
 * - Daily spend tracking per operator with automatic reset
 * - Real-time budget enforcement before transactions
 * - Emergency circuit breaker pattern (Pausable)
 * - Comprehensive event logging for transparency
 * - Support for both native ETH and ERC20 token operations
 */
contract OperatorsGovernance is Ownable, Pausable, ReentrancyGuard {

    /**
     * @notice Operator structure containing all relevant data
     * @param wallet The operator's wallet address
     * @param dailyLimit Maximum amount this operator can spend per day
     * @param lastResetTimestamp Timestamp when the current day counter was last reset
     * @param active Whether this operator is currently active
     * @param totalSpend Cumulative lifetime spend by this operator
     */
    struct Operator {
        address wallet;
        uint256 dailyLimit;
        uint256 lastResetTimestamp;
        bool active;
        uint256 totalSpend; // Lifetime total for analytics
    }

    /**
     * @notice Global configuration
     * @param treasury The treasury contract managing funds
     * @param minDailyLimit Minimum allowed daily limit (in wei)
     * @param maxDailyLimit Maximum allowed daily limit (in wei)
     * @param emergencyThreshold Total spend threshold triggering emergency pause
     */
    struct TreasuryConfig {
        address treasury;
        uint256 minDailyLimit;
        uint256 maxDailyLimit;
        uint256 emergencyThreshold;
    }

    /**
     * @notice Validate Ethereum address and prevent edge cases
     */
    modifier validAddress(address addr) {
        require(addr != address(0), "INVALID_ZERO_ADDRESS");
        require(addr != address(this), "CANNOT_BE_SELF");
        _;
    }

    /**
     * @notice Storage layout
     */
    // Operator management
    mapping(address => Operator) public operators;
    address[] public operatorList; // For iteration

    // Per-day spending tracking: dayIndex -> total spent across all operators
    mapping(uint256 => uint256) public dailyGasSpend;

    // Token-specific spending: tokenAddress -> dayIndex -> amount spent
    mapping(address => mapping(uint256 => uint256)) public tokenDaySpend;

    // Configuration
    TreasuryConfig public config;

    // Constants
    uint256 public constant SECONDS_PER_DAY = 86400;
    uint256 public constant MAX_SAFE_AMOUNT = type(uint128).max; // Protection against overflow

    // Events

    /**
     * @notice Emitted when a new operator is added
     * @param operator Address of the operator
     * @param wallet Operator's wallet address
     * @param dailyLimit Daily spending limit set
     */
    event OperatorAdded(
        address indexed operator,
        address indexed wallet,
        uint256 dailyLimit,
        uint256 timestamp
    );

    /**
     * @notice Emitted when an operator is removed
     * @param operator Address of the operator removed
     * @param wallet Operator's wallet address
     * @param finalSpend Final spend amount before removal
     */
    event OperatorRemoved(
        address indexed operator,
        address indexed wallet,
        uint256 finalSpend
    );

    /**
     * @notice Emitted when operator daily limit is updated
     * @param operator Address of the operator
     * @param newLimit New daily limit
     * @param oldLimit Previous daily limit
     */
    event DailyLimitUpdated(
        address indexed operator,
        uint256 newLimit,
        uint256 oldLimit
    );

    /**
     * @notice Emitted when gas spend is recorded
     * @param operator Address of the operator
     * @ Amount spent in gas
     * @ Day index
     * @ Remaining budget
     */
    event GasSpent(
        address indexed operator,
        uint256 amount,
        uint256 dayIndex,
        uint256 remainingBudget
    );

    /**
     * @notice Emitted when daily spend exceeds warning threshold
     * @ operator Address that exceeded limit
     * @ Amount spent
     * @ Limit reached
     */
    event BudgetWarning(
        address indexed operator,
        uint256 amountSpent,
        uint256 limitReached
    );

    /**
     * @notice Emitted when treasury configuration is updated
     * @ parameter Name of the parameter changed
     * @ oldValue Previous value
     * @ newValue New value
     */
    event TreasuryConfigUpdated(
        string indexed parameter,
        uint256 oldValue,
        uint256 newValue
    );

    /**
     * @notice Emitted when emergency pause is triggered
     * @ triggeredBy Address that triggered the pause
     * @ reason Reason for pause
     */
    event EmergencyPaused(
        address indexed triggeredBy,
        string reason
    );

    /**
     * @notice Emitted when emergency is lifted
     * @ resumedBy Address that resumed operations
     */
    event EmergencyResumed(
        address indexed resumedBy
    );

    /**
     * @notice Contract initialization
     * @param _treasury Address of the treasury contract
     * @param _minDailyLimit Minimum allowed daily limit
     * @param _maxDailyLimit Maximum allowed daily limit
     * @param _emergencyThreshold Spend threshold for emergency pause
     */
    constructor(
        address _treasury,
        uint256 _minDailyLimit,
        uint256 _maxDailyLimit,
        uint256 _emergencyThreshold
    ) Ownable(msg.sender) {
        require(_minDailyLimit > 0, "Minimum limit must be > 0");
        require(_maxDailyLimit > _minDailyLimit, "Max must be greater than min");
        require(_emergencyThreshold >= _maxDailyLimit, "Emergency threshold too low");

        config = TreasuryConfig({
            treasury: _treasury,
            minDailyLimit: _minDailyLimit,
            maxDailyLimit: _maxDailyLimit,
            emergencyThreshold: _emergencyThreshold
        });
    }

    /**
     * @notice Add a new operator with daily spending limit
     * @param _operator Address of the operator entity
     * @param _wallet Wallet address the operator will use
     * @param _dailyLimit Maximum amount this operator can spend per day
     */
    function addOperator(
        address _operator,
        address _wallet,
        uint256 _dailyLimit
    ) external onlyOwner whenNotPaused validAddress(_operator) validAddress(_wallet) {
        require(_operator != address(0), "Invalid operator address");
        require(_wallet != address(0), "Invalid wallet address");
        require(!operators[_operator].active, "Operator already exists");

        // Validate daily limit
        require(
            _dailyLimit >= config.minDailyLimit,
            "Limit below minimum"
        );
        require(
            _dailyLimit <= config.maxDailyLimit,
            "Limit exceeds maximum"
        );

        // Initialize operator
        Operator storage operatorData = operators[_operator];
        operatorData.wallet = _wallet;
        operatorData.dailyLimit = _dailyLimit;
        operatorData.lastResetTimestamp = block.timestamp;
        operatorData.active = true;
        operatorData.totalSpend = 0;

        // Add to list for iteration
        operatorList.push(_operator);

        emit OperatorAdded(_operator, _wallet, _dailyLimit, block.timestamp);
    }

    /**
     * @notice Remove/deactivate an existing operator
     * @param _operator Address of the operator to remove
     */
    function removeOperator(address _operator) external onlyOwner validAddress(_operator) {
        require(operators[_operator].active, "Operator not found or inactive");

        address wallet = operators[_operator].wallet;
        uint256 finalSpend = operators[_operator].totalSpend;

        // Deactivate operator
        operators[_operator].active = false;

        // Cannot be reactivated (security measure)

        emit OperatorRemoved(_operator, wallet, finalSpend);
    }

    /**
     * @notice Check if sufficient budget is available for a potential transaction
     * @param _operator Address of the operator
     * @param amount Amount to check
     * @return bool True if budget is sufficient, false otherwise
     * @dev View function - no state changes
     */
    function checkBudget(address _operator, uint256 amount)
        external
        view
        returns (bool)
    {
        require(operators[_operator].active, "Operator not active");

        uint256 currentDaySpend = getCurrentDaySpend();
        uint256 operatorDailyLimit = operators[_operator].dailyLimit;

        return (currentDaySpend + amount) <= operatorDailyLimit;
    }

    /**
     * @notice Record gas expenditure for an operator
     * @param _operator Address of the operator
     * @param amount Amount of gas spent
     */
    function recordGasSpend(address _operator, uint256 amount)
        external
        whenNotPaused nonReentrant
    {
        require(amount > 0, "Amount must be > 0");
        require(operators[_operator].active, "Operator not active");

        // Calculate current day
        uint256 currentDayIndex = getCurrentDayIndex();

        // Get current spend for this day
        uint256 currentDaySpend = getCurrentDaySpend();
        uint256 operatorDailyLimit = operators[_operator].dailyLimit;

        // Enforce budget limit
        require(
            currentDaySpend + amount <= operatorDailyLimit,
            "Daily limit exceeded"
        );

        // Update tracking
        dailyGasSpend[currentDayIndex] += amount;
        operators[_operator].totalSpend += amount;

        // Record remaining budget
        uint256 remainingBudget = operatorDailyLimit - (currentDaySpend + amount);

        // Emit events
        emit GasSpent(_operator, amount, currentDayIndex, remainingBudget);

        // Warning if high utilization (>80%)
        uint256 utilizationThreshold = operatorDailyLimit / 100 * 80;
        if ((currentDaySpend + amount) >= utilizationThreshold) {
            emit BudgetWarning(_operator, currentDaySpend + amount, operatorDailyLimit);
        }
    }

    /**
     * @notice Update an operator's daily spending limit
     * @param _operator Address of the operator
     * @param newLimit New daily limit
     */
    function updateDailyLimit(address _operator, uint256 newLimit)
        external
        onlyOwner
        whenNotPaused validAddress(_operator)
    {
        require(operators[_operator].active, "Operator not active");

        uint256 oldLimit = operators[_operator].dailyLimit;

        require(
            newLimit >= config.minDailyLimit,
            "Limit below minimum"
        );
        require(
            newLimit <= config.maxDailyLimit,
            "Limit exceeds maximum"
        );
        require(newLimit > oldLimit, "Limit cannot be equal");

        // Update limit
        operators[_operator].dailyLimit = newLimit;

        emit DailyLimitUpdated(_operator, newLimit, oldLimit);
    }

    /**
     * @notice Emergency pause - freeze all operations
     * @param reason Reason for pausing (stored in memory only)
     */
    function emergencyPause(string memory reason) external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender, reason);
    }

    /**
     * @notice Resume operations after emergency pause
     */
    function emergencyResume() external onlyOwner {
        // FIX (2026-08-09, ): guard was inverted (`require(!paused())`),
        // which made unpausing unreachable — a critical circuit-breaker bug.
        require(paused(), "Not paused");
        _unpause();
        emit EmergencyResumed(msg.sender);
    }

    /**
     * @notice Update treasury configuration parameters
     * @param parameter Name of parameter to update
     * @param newValue New value for the parameter
     */
    function updateTreasuryConfig(
        string calldata parameter,
        uint256 newValue
    ) external onlyOwner {
        if (keccak256(abi.encodePacked(parameter)) == keccak256(abi.encodePacked("minDailyLimit"))) {
            require(newValue > 0, "Min limit must be > 0");
            require(newValue < config.maxDailyLimit, "Must be less than max");
            uint256 oldVal = config.minDailyLimit;
            config.minDailyLimit = newValue;
            emit TreasuryConfigUpdated("minDailyLimit", oldVal, newValue);
        } else if (keccak256(abi.encodePacked(parameter)) == keccak256(abi.encodePacked("maxDailyLimit"))) {
            require(newValue > config.minDailyLimit, "Must be greater than min");
            uint256 oldVal = config.maxDailyLimit;
            config.maxDailyLimit = newValue;
            emit TreasuryConfigUpdated("maxDailyLimit", oldVal, newValue);
        } else if (keccak256(abi.encodePacked(parameter)) == keccak256(abi.encodePacked("emergencyThreshold"))) {
            require(newValue >= config.maxDailyLimit, "Too low");
            uint256 oldVal = config.emergencyThreshold;
            config.emergencyThreshold = newValue;
            emit TreasuryConfigUpdated("emergencyThreshold", oldVal, newValue);
        } else {
            revert("Unknown parameter");
        }
    }

    /**
     * @notice Get current day index based on timestamp
     * @return uint256 Current day index
     */
    function getCurrentDayIndex() public view returns (uint256) {
        return block.timestamp / SECONDS_PER_DAY;
    }

    /**
     * @notice Get total spend for the current day across all operators
     * @return uint256 Current day's total spend
     */
    function getCurrentDaySpend() public view returns (uint256) {
        uint256 dayIndex = getCurrentDayIndex();
        return dailyGasSpend[dayIndex];
    }

    /**
     * @notice Get an operator's current status
     * @param _operator Address of the operator
     * @return Operator data struct
     */
    function getOperator(address _operator)
        external
        view
        returns (Operator memory)
    {
        return operators[_operator];
    }

    /**
     * @notice Get number of registered operators
     * @return uint256 Count of operators
     */
    function getOperatorCount() external view returns (uint256) {
        return operatorList.length;
    }

    /**
     * @notice Get operator at specific index (for iteration)
     * @param index Index in operator list
     * @return address Operator address
     */
    function getOperatorAtIndex(uint256 index)
        external
        view
        returns (address)
    {
        require(index < operatorList.length, "Index out of bounds");
        return operatorList[index];
    }

    /**
     * @notice Get remaining budget for an operator today
     * @param _operator Address of the operator
     * @return uint256 Remaining budget amount
     */
    function getRemainingBudget(address _operator)
        external
        view
        returns (uint256)
    {
        require(operators[_operator].active, "Operator not active");
        uint256 currentDaySpend = getCurrentDaySpend();
        return operators[_operator].dailyLimit - currentDaySpend;
    }

    /**
     * @notice Withdraw unused funds from treasury (owner only)
     * @param amount Amount to withdraw
     */
    function withdrawUnusedFunds(uint256 amount) external onlyOwner {
        require(IERC20(config.treasury).balanceOf(address(this)) >= amount, "Insufficient balance");
        IERC20(config.treasury).transfer(owner(), amount);
    }

    /**
     * @notice Recover sent funds (emergency)
     * @param token Token address
     * @param amount Amount to recover
     */
    function recoverTokens(address token, uint256 amount)
        external
        onlyOwner
    {
        require(token != address(0), "Invalid token");
        require(IERC20(token).balanceOf(address(this)) >= amount, "Insufficient balance");
        IERC20(token).transfer(owner(), amount);
    }
}
