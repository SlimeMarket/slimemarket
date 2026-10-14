// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title MultisigTreasury
 * @notice Simple 2-of-3 multisig wallet for SlimeMarket treasury operations.
 *
 * ============================================================================
 * NOT DEPLOYED — NOT USED. KEPT AS A MAINNET CANDIDATE. *
 * The testnet MVP deliberately runs ONE wallet as treasury: the platform DCW,
 * which is also the escrow owner/operator/middleman. `contracts/deploy.ts`
 * deploys MarketEscrow with `_treasury = _platform = <platform DCW address>` and
 * does NOT deploy this contract. `MarketEscrow.collectFees()` only checks
 * `msg.sender == treasury`, so the DCW sweeps fees directly
 * (`collectFeesOnChain()` in lib/contracts/escrow-client.ts).
 *
 * Everything that used to drive this contract has been deleted — the
 * submit/confirm/execute client trio, `scripts/deploy-multisig-treasury.ts`,
 * `scripts/verify-multisig-deployment.ts`, `scripts/test-multisig.ts` — because
 * none of it could work (the two deploy scripts also called
 * `getRequiredConfirmations()` and `getOwners(uint256)`, neither of which exists
 * on this contract).
 *
 * Moving to this on mainnet means: deploy with 3 distinct owner EOAs, set it as
 * the escrow treasury AND owner, and re-introduce the 3-step signing flow with
 * each owner signing from their own device.
 * ============================================================================
 *
 * Used as the `treasury` recipient for `MarketEscrow.collectFees()`. With a
 * single-owner DCW as treasury, a compromised key could drain all accrued
 * fees. A 2-of-3 multisig requires two of three trusted owners to confirm
 * any outgoing transaction.
 *
 * Flow:
 *   1. Any owner calls `submitTx(to, value, data)` → creates a pending tx.
 *   2. Other owners call `confirmTx(txId)` to add their confirmation.
 *   3. Once `required` (2) confirmations are reached, anyone can call
 *      `executeTx(txId)` to broadcast the transaction.
 *
 * For `collectFees()`, the multisig IS the treasury (msg.sender == treasury).
 * So the multisig doesn't need to call collectFees itself — the escrow contract
 * sends fees TO the multisig address. The multisig is then used to spend
 * those fees (e.g. pay MM salary, fund platform operations).
 *
 * For `transferOwnership` / `setTreasury` / `requestPause` on MarketEscrow,
 * the multisig calls those directly (it's the owner of the escrow after F6).
 *
 * Security:
 *   - Owners are set at construction; cannot be added or removed without a
 *     multisig tx calling `replaceOwner` (a tx itself requires 2 confirmations).
 *   - Reverts on double-confirmation by the same owner.
 *   - `executeTx` is permissionless once threshold is met (anyone can broadcast).
 *   - No reentrancy on execute (single external call, state cleared before).
 *
 * Limitations:
 *   - No timelock on multisig txs (the 2-of-3 requirement IS the timelock).
 *   - No delegatecall (only `call` to prevent storage collision attacks).
 *   - Owners are stored in an array + mapping for O(1) membership checks.
 */
contract MultisigTreasury {
    uint256 public constant REQUIRED = 2;
    uint256 public constant MAX_OWNERS = 3;

    address[] public owners;
    mapping(address => bool) public isOwner;
    mapping(uint256 => mapping(address => bool)) public confirmed;

    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
    }

    Transaction[] public transactions;

    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event TransactionSubmitted(uint256 indexed txId, address indexed submitter, address to, uint256 value, bytes data);
    event TransactionConfirmed(uint256 indexed txId, address indexed owner);
    event TransactionExecuted(uint256 indexed txId, address indexed executor);
    event TransactionRevoked(uint256 indexed txId, address indexed owner);
    event Received(address indexed from, uint256 value);

    modifier onlyOwner() {
        require(isOwner[msg.sender], "!owner");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < transactions.length, "tx does not exist");
        _;
    }

    modifier notExecuted(uint256 txId) {
        require(!transactions[txId].executed, "tx already executed");
        _;
    }

    constructor(address[3] memory _owners) {
        require(_owners[0] != address(0) && _owners[1] != address(0) && _owners[2] != address(0), "zero owner");
        require(_owners[0] != _owners[1] && _owners[0] != _owners[2] && _owners[1] != _owners[2], "duplicate owner");
        for (uint256 i = 0; i < MAX_OWNERS; i++) {
            owners.push(_owners[i]);
            isOwner[_owners[i]] = true;
            emit OwnerAdded(_owners[i]);
        }
    }

    /// @notice Receive USDC (or native) sent to the multisig (e.g. collectFees payout).
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Submit a transaction for confirmation by other owners.
    /// @return txId The id of the submitted transaction.
    function submitTx(address to, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 txId)
    {
        require(to != address(0), "invalid to");
        transactions.push(Transaction({ to: to, value: value, data: data, executed: false }));
        txId = transactions.length - 1;
        emit TransactionSubmitted(txId, msg.sender, to, value, data);
        // Submitter auto-confirms.
        _confirm(txId, msg.sender);
    }

    /// @notice Confirm a pending transaction.
    function confirmTx(uint256 txId)
        external
        onlyOwner
        txExists(txId)
        notExecuted(txId)
    {
        _confirm(txId, msg.sender);
    }

    /// @notice Revoke a confirmation (e.g. if the tx was found to be wrong).
    function revokeConfirmation(uint256 txId)
        external
        onlyOwner
        txExists(txId)
        notExecuted(txId)
    {
        require(confirmed[txId][msg.sender], "not confirmed");
        confirmed[txId][msg.sender] = false;
        emit TransactionRevoked(txId, msg.sender);
    }

    /// @notice Execute a transaction once `REQUIRED` confirmations are reached.
    ///         Permissionless — anyone can broadcast once threshold is met.
    function executeTx(uint256 txId)
        external
        txExists(txId)
        notExecuted(txId)
    {
        require(_confirmationCount(txId) >= REQUIRED, "insufficient confirmations");
        Transaction storage txn = transactions[txId];
        txn.executed = true;
        (bool ok, bytes memory ret) = txn.to.call{value: txn.value}(txn.data);
        require(ok, _revertMsg(ret));
        emit TransactionExecuted(txId, msg.sender);
    }

    /// @notice Replace an owner (requires a multisig tx calling this function).
    function replaceOwner(address oldOwner, address newOwner)
        external
        onlyOwner
    {
        require(isOwner[oldOwner], "old owner not found");
        require(newOwner != address(0) && !isOwner[newOwner], "invalid new owner");
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == oldOwner) {
                owners[i] = newOwner;
                break;
            }
        }
        isOwner[oldOwner] = false;
        isOwner[newOwner] = true;
        emit OwnerRemoved(oldOwner);
        emit OwnerAdded(newOwner);
    }

    /// @notice Count confirmations for a tx.
    function confirmationCount(uint256 txId) external view txExists(txId) returns (uint256 count) {
        return _confirmationCount(txId);
    }

    function _confirm(uint256 txId, address owner) internal {
        require(!confirmed[txId][owner], "already confirmed");
        confirmed[txId][owner] = true;
        emit TransactionConfirmed(txId, owner);
    }

    function _confirmationCount(uint256 txId) internal view returns (uint256 count) {
        for (uint256 i = 0; i < owners.length; i++) {
            if (confirmed[txId][owners[i]]) count++;
        }
    }

    /// @notice Extract a revert reason from a call's return data.
    function _revertMsg(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 68) return "call failed";
        // 4-byte selector + 32-byte offset + 32-byte length + data
        assembly {
            ret := add(ret, 68)
        }
        return abi.decode(ret, (string));
    }

    /// @notice Owners list getter.
    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    /// @notice Transaction count.
    function transactionCount() external view returns (uint256) {
        return transactions.length;
    }

    /// @notice Get a transaction by id.
    function getTransaction(uint256 txId)
        external
        view
        txExists(txId)
        returns (address to, uint256 value, bytes memory data, bool executed)
    {
        Transaction storage txn = transactions[txId];
        return (txn.to, txn.value, txn.data, txn.executed);
    }
}
