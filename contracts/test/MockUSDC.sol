// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice Minimal 6-decimal USDC stand-in with EIP-2612 permit support.
///         Used ONLY by the Hardhat test suite (test/MarketEscrow.test.js)
///         to exercise MarketEscrow's safeTransferFrom + permit paths.
///         NOT a production contract — never deploy.
/// @dev Hand-rolled (no OpenZeppelin imports): OZ 5.6.x pulls in Bytes.sol
///      which uses `mcopy` (Cancun), incompatible with the paris evm target
///      pinned in hardhat.config.cjs.
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";

    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event Transfer(address indexed from, address to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // Error name mirrors OZ ERC20 so tests can use the same matcher.
    error ERC20InsufficientAllowance(address spender, uint256 allowance_, uint256 needed);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Permissionless mint for test funding.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        unchecked {
            balanceOf[msg.sender] -= value;
        }
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) {
            revert ERC20InsufficientAllowance(msg.sender, allowed, value);
        }
        require(balanceOf[from] >= value, "balance");
        unchecked {
            allowance[from][msg.sender] = allowed - value;
            balanceOf[from] -= value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }

    /// @notice EIP-2612 permit (name/version match the test's signTypedData domain).
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(deadline >= block.timestamp, "expired");
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline)
        );
        bytes32 hash = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0) && signer == owner, "invalid signer");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}
