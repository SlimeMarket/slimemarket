// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MarketEscrow
 * @notice Non-custodial escrow for two flows on Arc:
 *
 *   1. MARKETPLACE ORDERS  — buyer pays, seller ships, buyer confirms.
 *      Platform take = buyer fee (2%) + seller fee (2%) = 4%.
 *
 *   2. WL / OTC ESCROW DEALS — peer-to-peer deals for high-risk digital goods
 *      (mint services, wallet/Discord surrender, whitelist spots, ...).
 *      Platform take = buyer fee (2%) only; the seller receives 100% of `price`.
 *      An optional seller collateral acts as FRAUD INSURANCE for the buyer.
 *
 * SETTLEMENT IS DETERMINISTIC. Every deal is driven by two independent clocks,
 * never by "whoever calls first":
 *
 *   createdAt ──▶ deliveryDeadline ──▶ (seller marks delivered)
 *                                          │
 *                                          ▼
 *                                    confirmDeadline ──▶ release to seller
 *
 *   - Seller misses `deliveryDeadline` and never marks delivered
 *       ⇒ anyone may refund the buyer (seller failed to deliver).
 *   - Seller marks delivered, buyer stays silent past `confirmDeadline`
 *       ⇒ anyone may release to the seller (delivery presumed accepted).
 *   - Either party raises a dispute
 *       ⇒ the escape hatches are FROZEN; the middleman (platform admin)
 *         arbitrates. If the platform never resolves, a backstop refunds the
 *         buyer after `DISPUTE_BACKSTOP` so funds can never be stuck forever.
 *
 * The platform admin is the middleman: `addMiddleman` is `onlyOwner`, so the
 * platform designates its own operator wallet. No third-party human is needed.
 *
 * @dev Money is USDC in micro-units (6 decimals) unless stated otherwise.
 */
contract MarketEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public usdc;
    address public treasury;
    address public owner;
    address public platform;
    bool public paused;

    mapping(uint256 => Order) public orders;
    mapping(uint256 => EscrowDeal) public deals;
    mapping(address => bool) public middlemen;

    uint256 public orderCounter;
    uint256 public dealCounter;
    uint256 public pendingFees;

    /// @notice Buyer-side platform fee in basis points (200 = 2%). Charged on
    ///         BOTH flows (marketplace orders and WL escrow deals) and collected
    ///         at creation time into `pendingFees`. Non-refundable: it stays with
    ///         the platform on release AND on refund.
    uint256 public constant FEE_BPS = 200; // 2%

    /// @notice Seller-side platform fee in basis points (200 = 2%). Applies to
    ///         MARKETPLACE ORDERS ONLY — it is deducted from the seller's payout
    ///         at release time, so the seller receives 98% of the item amount.
    ///         WL escrow deals deliberately do NOT charge a seller fee (the
    ///         seller still receives 100% of `price`).
    uint256 public constant SELLER_FEE_BPS = 200; // 2%

    /// @notice Total platform take on a marketplace order = buyer fee + seller
    ///         fee = 4% of the item amount. WL deals take only the buyer fee.

    // ---------------------------------------------------------------------
    // Timing windows
    // ---------------------------------------------------------------------

    /// @notice Floor for a deal's delivery window. Prevents a seller from
    ///         setting a window so short that the buyer can never realistically
    ///         receive anything before the refund path opens.
    uint256 public constant MIN_DELIVERY_WINDOW = 1 hours;

    /// @notice Ceiling for a deal's delivery window. OTC deals legitimately run
    ///         long (e.g. an airdrop-eligible wallet whose claim unlocks months
    ///         later), but an unbounded window would lock the buyer's funds
    ///         indefinitely. One year is the hard cap.
    uint256 public constant MAX_DELIVERY_WINDOW = 365 days;

    /// @notice How long the buyer has to confirm AFTER the seller marks the deal
    ///         delivered. Staying silent past this is treated as acceptance, so
    ///         the seller is never paid late and the buyer is never rushed.
    uint256 public constant CONFIRM_WINDOW = 7 days;

    /// @notice Dispute backstop. Once a deal is disputed the escape hatches are
    ///         frozen while the middleman arbitrates. If the platform never
    ///         resolves, the buyer is refunded after this window — funds can
    ///         never be locked forever, and the weaker party is the default.
    uint256 public constant DISPUTE_BACKSTOP = 30 days;

    /// @notice Escape-hatch timeout for MARKETPLACE ORDERS. Retained for the
    ///         order flow only; escrow deals use the per-deal deadlines above.
    uint256 public constant ESCROW_TIMEOUT = 7 days;

    /// @notice Pause timelock. `requestPause()` must be called `PAUSE_DELAY`
    ///         seconds before `executePause()` can flip `paused = true`.
    ///         Mitigates the instant-pause rug vector if the owner EOA is
    ///         compromised. `unpause()` stays instant (recovery path).
    uint256 public constant PAUSE_DELAY = 24 hours;
    uint256 public pauseRequestedAt;

    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    struct Order {
        address buyer;
        address seller;
        uint256 amount;      // item subtotal: seller receives amount - sellerFee on release; buyer receives amount on refund
        uint256 fee;         // buyer fee (FEE_BPS of amount), non-refundable, collected at creation
        uint256 createdAt;
        uint256 deliveryDeadline; // seller must mark delivered before this
        uint256 confirmDeadline;  // set when the seller marks delivered
        bool delivered;
        bool buyerConfirmed;
        bool released;
        bool refunded;
    }

    /**
     * @notice A peer-to-peer escrow deal (WL / OTC).
     *
     * @dev `collateral` is the seller's fraud insurance, denominated in USDC and
     *      locked at deal time (the parties agree a USD-equivalent figure; no
     *      oracle is involved). It is returned to the seller on a normal release
     *      or refund, but is SLASHED TO THE BUYER when the middleman rules that
     *      the seller committed fraud — that is the whole point of the deposit.
     */
    struct EscrowDeal {
        address buyer;
        address seller;
        uint256 price;              // seller receives 100% of this on release; buyer receives it on refund
        uint256 fee;                // buyer fee (FEE_BPS of price), non-refundable, collected at creation
        uint256 collateral;         // seller's fraud insurance, in USDC
        uint256 collateralReturned; // how much of `collateral` has already been paid out
        uint256 createdAt;
        uint256 deliveryDeadline;   // seller must mark delivered before this
        uint256 confirmDeadline;    // set when the seller marks delivered
        uint256 disputedAt;         // 0 while not disputed
        bool buyerDeposited;
        bool delivered;
        bool buyerConfirmed;
        bool disputed;
        bool released;
        bool refunded;
        /// @dev The seller's chosen delivery window, in seconds. Stored so the
        ///      delivery clock can start when the deal is FUNDED rather than when
        ///      the shell is created — otherwise a buyer who funds late would
        ///      inherit a partially elapsed window.
        uint256 deliveryWindow;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event OrderCreated(uint256 indexed id, address buyer, address seller, uint256 amount, uint256 fee);
    event OrderReleased(uint256 indexed id, address mm, address seller, uint256 payout);
    event OrderRefunded(uint256 indexed id, address mm, address buyer, uint256 amount);
    event OrderDelivered(uint256 indexed id, address seller);
    event OrderConfirmed(uint256 indexed id, address buyer);

    event DealCreated(uint256 indexed id, address buyer, address seller, uint256 price, uint256 fee, uint256 collateral);
    /// @notice Emitted when the buyer funds a deal shell the seller opened. The
    ///         delivery clock starts here, not at shell creation.
    event DealFunded(uint256 indexed id, address buyer, uint256 price, uint256 fee);
    event DealReleased(uint256 indexed id, address mm, address seller, uint256 payout, uint256 collateralReturned);
    event DealRefunded(uint256 indexed id, address mm, address buyer, uint256 amount, uint256 collateralReturned);
    /// @notice Emitted when the seller's collateral is forfeited to the buyer as
    ///         compensation for proven fraud.
    event DealRefundedWithSlash(uint256 indexed id, address mm, address buyer, uint256 price, uint256 collateral);
    event DealDelivered(uint256 indexed id, address seller, uint256 confirmDeadline);
    event DealConfirmed(uint256 indexed id, address buyer);
    event DealDisputed(uint256 indexed id, address by);
    event CollateralAdded(uint256 indexed id, address seller, uint256 added, uint256 total);

    event MiddlemanAdded(address indexed mm);
    event MiddlemanRemoved(address indexed mm);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PauseRequested(address indexed by, uint256 effectiveAt);
    event PauseCancelled(address indexed by);
    event Paused();
    event Unpaused();
    event FeesCollected(address treasury, uint256 amount);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() { require(msg.sender == owner, "!owner"); _; }
    modifier onlyMiddleman() { require(middlemen[msg.sender], "!mm"); _; }
    modifier onlyOperator() { require(msg.sender == platform || middlemen[msg.sender], "!operator"); _; }
    modifier whenNotPaused() { require(!paused, "paused"); _; }

    constructor(address _usdc, address _treasury, address _platform) {
        require(_usdc != address(0), "invalid usdc");
        require(_treasury != address(0), "invalid treasury");
        require(_platform != address(0), "invalid platform");
        usdc = IERC20(_usdc);
        treasury = _treasury;
        platform = _platform;
        owner = msg.sender;
        middlemen[msg.sender] = true;
    }

    // ---------------------------------------------------------------------
    // Fee helpers
    // ---------------------------------------------------------------------

    /// @notice Buyer fee for a given amount (FEE_BPS).
    function computeFee(uint256 amount) public pure returns (uint256) {
        return (amount * FEE_BPS) / 10000;
    }

    /// @notice Seller fee deducted from the payout on a MARKETPLACE release
    ///         (SELLER_FEE_BPS). WL escrow deals do not use this.
    function computeSellerFee(uint256 amount) public pure returns (uint256) {
        return (amount * SELLER_FEE_BPS) / 10000;
    }

    /// @dev Clamp a caller-supplied delivery window into [MIN, MAX].
    function _clampDeliveryWindow(uint256 window) internal pure returns (uint256) {
        if (window < MIN_DELIVERY_WINDOW) return MIN_DELIVERY_WINDOW;
        if (window > MAX_DELIVERY_WINDOW) return MAX_DELIVERY_WINDOW;
        return window;
    }

    // =====================================================================
    // Marketplace orders
    // =====================================================================

    function createOrder(address seller, uint256 amount, uint256 deliveryWindow)
        external
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        require(seller != address(0), "invalid seller");
        require(amount > 0, "zero amount");
        uint256 fee = computeFee(amount);
        uint256 total = amount + fee;
        usdc.safeTransferFrom(msg.sender, address(this), total);
        pendingFees += fee;
        uint256 orderId = orderCounter++;
        Order storage o = orders[orderId];
        o.buyer = msg.sender;
        o.seller = seller;
        o.amount = amount;
        o.fee = fee;
        o.createdAt = block.timestamp;
        o.deliveryDeadline = block.timestamp + _clampDeliveryWindow(deliveryWindow);
        emit OrderCreated(orderId, msg.sender, seller, amount, fee);
        return orderId;
    }

    /**
     * Relayer-submitted order funded by the BUYER via EIP-2612 permit.
     * Buyer signs a gasless permit off-chain; platform/MM relays this tx and
     * pays gas. Funds are pulled from `buyer` (not msg.sender), so the buyer's
     * UCW is debited — not the platform DCW.
     */
    function createOrderFor(
        address buyer,
        address seller,
        uint256 amount,
        uint256 deliveryWindow,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256) {
        require(buyer != address(0), "invalid buyer");
        require(seller != address(0), "invalid seller");
        require(amount > 0, "zero amount");
        uint256 fee = computeFee(amount);
        uint256 total = amount + fee;
        _applyPermit(buyer, total, deadline, v, r, s);
        usdc.safeTransferFrom(buyer, address(this), total);
        pendingFees += fee;
        uint256 orderId = orderCounter++;
        Order storage o = orders[orderId];
        o.buyer = buyer;
        o.seller = seller;
        o.amount = amount;
        o.fee = fee;
        o.createdAt = block.timestamp;
        o.deliveryDeadline = block.timestamp + _clampDeliveryWindow(deliveryWindow);
        emit OrderCreated(orderId, buyer, seller, amount, fee);
        return orderId;
    }

    /// @notice Seller marks the order shipped/delivered, starting the buyer's
    ///         confirmation clock.
    function markOrderDelivered(uint256 orderId) external whenNotPaused {
        Order storage o = orders[orderId];
        require(o.amount > 0, "not found");
        require(msg.sender == o.seller, "!seller");
        require(!o.delivered, "already delivered");
        require(!o.released && !o.refunded, "already resolved");
        require(block.timestamp <= o.deliveryDeadline, "delivery deadline passed");
        o.delivered = true;
        o.confirmDeadline = block.timestamp + CONFIRM_WINDOW;
        emit OrderDelivered(orderId, msg.sender);
    }

    /// @notice Buyer confirms receipt. The buyer is the only party who can take
    ///         this shortcut, so a happy buyer never needs the platform to act.
    function confirmOrder(uint256 orderId) external whenNotPaused nonReentrant {
        Order storage o = orders[orderId];
        require(o.amount > 0, "not found");
        require(msg.sender == o.buyer, "!buyer");
        require(!o.released && !o.refunded, "already resolved");
        o.buyerConfirmed = true;
        _releaseOrder(o, orderId);
        emit OrderConfirmed(orderId, msg.sender);
    }

    function releaseOrder(uint256 orderId) external onlyOperator whenNotPaused nonReentrant {
        Order storage o = orders[orderId];
        require(o.amount > 0, "not found");
        require(!o.released && !o.refunded, "already resolved");
        _releaseOrder(o, orderId);
    }

    /// @dev Shared payout logic for the order release path.
    ///      Marketplace release charges a SELLER-side fee: the seller receives
    ///      amount - sellerFee and the fee joins pendingFees alongside the buyer
    ///      fee collected at creation. The contract already holds amount + buyerFee,
    ///      so this needs no extra funding: (amount - sellerFee) + sellerFee = amount.
    function _releaseOrder(Order storage o, uint256 orderId) internal {
        o.released = true;
        uint256 sellerFee = computeSellerFee(o.amount);
        uint256 payout = o.amount - sellerFee;
        pendingFees += sellerFee;
        usdc.safeTransfer(o.seller, payout);
        emit OrderReleased(orderId, msg.sender, o.seller, payout);
    }

    function refundOrder(uint256 orderId) external onlyOperator whenNotPaused nonReentrant {
        Order storage o = orders[orderId];
        require(o.amount > 0, "not found");
        require(!o.released && !o.refunded, "already resolved");
        o.refunded = true;
        // Buyer gets amount only (fee is non-refundable, already in pendingFees).
        usdc.safeTransfer(o.buyer, o.amount);
        emit OrderRefunded(orderId, msg.sender, o.buyer, o.amount);
    }

    // =====================================================================
    // WL / OTC escrow deals
    // =====================================================================

    /**
     * @notice Create an escrow deal, funded by the caller (the buyer).
     * @param deliveryWindow Seconds the seller has to deliver, clamped to
     *        [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW]. The buyer is expected
     *        to see this value in the UI BEFORE paying.
     */
    function createEscrowDeal(address seller, uint256 price, uint256 deliveryWindow)
        external
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        require(seller != address(0), "invalid seller");
        require(price > 0, "zero price");
        return _createEscrowDeal(msg.sender, seller, price, deliveryWindow);
    }

    /**
     * Relayer-submitted WL escrow deal funded by the BUYER via EIP-2612 permit.
     * Pulls price+fee from `buyer` (not msg.sender).
     */
    function createEscrowDealFor(
        address buyer,
        address seller,
        uint256 price,
        uint256 deliveryWindow,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256) {
        require(buyer != address(0), "invalid buyer");
        require(seller != address(0), "invalid seller");
        require(price > 0, "zero price");
        _applyPermit(buyer, price + computeFee(price), deadline, v, r, s);
        return _createEscrowDeal(buyer, seller, price, deliveryWindow);
    }

    function _createEscrowDeal(address buyer, address seller, uint256 price, uint256 deliveryWindow)
        internal
        returns (uint256)
    {
        uint256 fee = computeFee(price);
        uint256 total = price + fee;
        usdc.safeTransferFrom(buyer, address(this), total);
        pendingFees += fee;
        uint256 dealId = dealCounter++;
        EscrowDeal storage d = deals[dealId];
        d.buyer = buyer;
        d.seller = seller;
        d.price = price;
        d.fee = fee;
        d.createdAt = block.timestamp;
        d.deliveryWindow = _clampDeliveryWindow(deliveryWindow);
        d.deliveryDeadline = block.timestamp + d.deliveryWindow;
        d.buyerDeposited = true;
        emit DealCreated(dealId, buyer, seller, price, fee, 0);
        return dealId;
    }

    /**
     * @notice Seller opens an UNFUNDED deal shell and deposits the fraud
     *         collateral in the same transaction.
     *
     * @dev This is what makes collateral-first possible. The buyer can only fund
     *      a shell that already carries the seller's deposit (`fundEscrowDeal`
     *      requires `collateral > 0` when the deal demands it), so the buyer's
     *      USDC can never sit in escrow with nothing backing it.
     *
     *      The delivery clock deliberately does NOT start here — `createdAt` and
     *      `deliveryDeadline` are set by `fundEscrowDeal`, so a buyer who funds
     *      days later still gets the full window the seller advertised.
     *
     * @param buyer            The counterparty who will fund and receive.
     * @param price            Amount the buyer will pay (seller receives 100%).
     * @param deliveryWindow   Seconds the seller gets to deliver, clamped.
     * @param collateral       Fraud insurance, pulled from msg.sender now.
     */
    function createEscrowDealAsSeller(
        address buyer,
        uint256 price,
        uint256 deliveryWindow,
        uint256 collateral
    ) external whenNotPaused nonReentrant returns (uint256) {
        require(buyer != address(0), "invalid buyer");
        require(buyer != msg.sender, "buyer != seller");
        require(price > 0, "zero price");

        uint256 dealId = dealCounter++;
        EscrowDeal storage d = deals[dealId];
        d.buyer = buyer;
        d.seller = msg.sender;
        d.price = price;
        d.fee = computeFee(price);
        d.deliveryWindow = _clampDeliveryWindow(deliveryWindow);
        d.createdAt = block.timestamp;
        // deliveryDeadline stays 0 until the deal is funded.

        if (collateral > 0) {
            d.collateral = collateral;
            usdc.safeTransferFrom(msg.sender, address(this), collateral);
            emit CollateralAdded(dealId, msg.sender, collateral, collateral);
        }

        emit DealCreated(dealId, buyer, msg.sender, price, d.fee, collateral);
        return dealId;
    }

    /**
     * @notice Buyer funds a shell the seller opened. This is the moment the deal
     *         becomes live: funds move, and the delivery clock starts.
     *
     * @dev Requires the deal to carry collateral whenever the price is non-zero —
     *      that is the whole point of the shell flow. `collateralRequired` is
     *      enforced here rather than at shell creation so a seller cannot open a
     *      shell with zero collateral and then have the buyer fund it anyway.
     */
    function fundEscrowDeal(uint256 dealId) external whenNotPaused nonReentrant {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(msg.sender == d.buyer, "!buyer");
        require(!d.buyerDeposited, "already funded");
        require(!d.released && !d.refunded, "already resolved");
        require(d.collateral > 0, "collateral not deposited");

        uint256 total = d.price + d.fee;
        usdc.safeTransferFrom(msg.sender, address(this), total);
        pendingFees += d.fee;
        d.buyerDeposited = true;

        // The deal is live now — start both clocks from this moment.
        d.createdAt = block.timestamp;
        d.deliveryDeadline = block.timestamp + d.deliveryWindow;

        emit DealFunded(dealId, msg.sender, d.price, d.fee);
    }

    /**
     * @notice Seller deposits — or tops up — the fraud collateral.
     *
     * @dev Deliberately callable more than once. OTC collateral is NEGOTIATED in
     *      the deal room: the buyer may ask for more after the first deposit, so
     *      the seller must be able to add. Collateral can only ever grow — there
     *      is no path to withdraw it, which stops a seller from shrinking the
     *      buyer's protection after the buyer has paid.
     */
    function depositEscrowCollateral(uint256 dealId, uint256 amount) external whenNotPaused nonReentrant {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(msg.sender == d.seller, "!seller");
        require(amount > 0, "zero collateral");
        require(!d.released && !d.refunded, "already resolved");
        d.collateral += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralAdded(dealId, msg.sender, amount, d.collateral);
    }

    /// @notice Seller marks the deal delivered, starting the buyer's
    ///         confirmation clock. Must happen before `deliveryDeadline`.
    function markDelivered(uint256 dealId) external whenNotPaused {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(msg.sender == d.seller, "!seller");
        require(d.buyerDeposited, "buyer not deposited");
        require(!d.delivered, "already delivered");
        require(!d.released && !d.refunded, "already resolved");
        require(block.timestamp <= d.deliveryDeadline, "delivery deadline passed");
        d.delivered = true;
        d.confirmDeadline = block.timestamp + CONFIRM_WINDOW;
        emit DealDelivered(dealId, msg.sender, d.confirmDeadline);
    }

    /// @notice Buyer confirms receipt — releases immediately, no middleman needed.
    function confirmEscrow(uint256 dealId) external whenNotPaused nonReentrant {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(msg.sender == d.buyer, "!buyer");
        require(d.buyerDeposited, "buyer not deposited");
        require(!d.released && !d.refunded, "already resolved");
        d.buyerConfirmed = true;
        _releaseEscrow(d, dealId);
        emit DealConfirmed(dealId, msg.sender);
    }

    /// @notice Middleman releases to the seller (arbitration / assisted path).
    function releaseEscrow(uint256 dealId) external onlyMiddleman whenNotPaused nonReentrant {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(!d.released && !d.refunded, "already resolved");
        require(d.buyerDeposited, "buyer not deposited");
        _releaseEscrow(d, dealId);
    }

    /// @dev Shared payout logic for the escrow release path. Seller gets 100% of
    ///      `price` (the buyer fee was collected at creation) plus the collateral
    ///      back — a release means no fraud was found.
    function _releaseEscrow(EscrowDeal storage d, uint256 dealId) internal {
        d.released = true;
        usdc.safeTransfer(d.seller, d.price);
        if (d.collateral > 0 && d.collateralReturned == 0) {
            usdc.safeTransfer(d.seller, d.collateral); // collateral back
            d.collateralReturned = d.collateral;
        }
        emit DealReleased(dealId, msg.sender, d.seller, d.price, d.collateralReturned);
    }

    /// @notice Middleman refunds the buyer. The seller's collateral is returned
    ///         (no fraud was established — the deal simply did not complete).
    function refundEscrow(uint256 dealId) external onlyMiddleman whenNotPaused nonReentrant {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(!d.released && !d.refunded, "already resolved");
        _refundEscrow(d, dealId);
    }

    /**
     * @notice Middleman refunds the buyer AND forfeits the seller's collateral
     *         to the buyer, as compensation for proven fraud.
     *
     * @dev This is what gives the collateral meaning. Typical WL/mint fraud: the
     *      buyer funds a mint wallet with their own money, and the seller either
     *      forwards those funds to another wallet or mints the NFT to an address
     *      that is not the buyer's. The platform admin verifies the evidence
     *      (usually on another chain, hence manual arbitration) and rules fraud
     *      here, so the buyer is made whole out of the seller's deposit.
     */
    function refundEscrowWithSlash(uint256 dealId) external onlyMiddleman whenNotPaused nonReentrant {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(!d.released && !d.refunded, "already resolved");
        require(d.collateral > 0, "no collateral to slash");

        d.refunded = true;
        uint256 slash = d.collateral;

        // Buyer gets their price back (when the deal was funded) AND the seller's
        // collateral as compensation. The collateral is ALWAYS paid out here —
        // otherwise a fraud ruling on an unfunded shell would strand the deposit
        // in the contract forever.
        uint256 toBuyer = slash + (d.buyerDeposited ? d.price : 0);
        usdc.safeTransfer(d.buyer, toBuyer);
        // The collateral left the seller's hands for good.
        d.collateralReturned = slash;
        emit DealRefundedWithSlash(dealId, msg.sender, d.buyer, d.price, slash);
    }

    /// @dev Shared refund logic. Buyer gets price only (fee is non-refundable,
    ///      already in pendingFees); collateral goes back to the seller.
    function _refundEscrow(EscrowDeal storage d, uint256 dealId) internal {
        d.refunded = true;
        if (d.buyerDeposited) {
            usdc.safeTransfer(d.buyer, d.price);
        }
        if (d.collateral > 0 && d.collateralReturned == 0) {
            usdc.safeTransfer(d.seller, d.collateral); // collateral back to seller
            d.collateralReturned = d.collateral;
        }
        emit DealRefunded(dealId, msg.sender, d.buyer, d.price, d.collateralReturned);
    }

    /**
     * @notice Either party raises a dispute, freezing the escape hatches so the
     *         middleman can arbitrate without the other side racing settlement.
     */
    function flagDispute(uint256 dealId) external whenNotPaused {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(msg.sender == d.buyer || msg.sender == d.seller, "!party");
        require(d.buyerDeposited, "buyer not deposited");
        require(!d.disputed, "already disputed");
        require(!d.released && !d.refunded, "already resolved");
        d.disputed = true;
        d.disputedAt = block.timestamp;
        emit DealDisputed(dealId, msg.sender);
    }

    // =====================================================================
    // Escape hatches (anti-censorship)
    // =====================================================================
    //
    // Callable by ANYONE once the relevant deadline has passed, so funds can
    // never be stranded if the platform operator refuses or is unable to relay.
    //
    // The two directions are MUTUALLY EXCLUSIVE — they key off different state,
    // so there is no "whoever calls first wins" race:
    //
    //   release : delivered && past confirmDeadline && not disputed
    //   refund  : (!delivered && past deliveryDeadline) || disputed past backstop
    //
    // The `deadline` param protects against stale calls being mined much later
    // (defense in depth on top of the `!released && !refunded` check).

    function releaseOrderAfterTimeout(uint256 orderId, uint256 deadline) external whenNotPaused nonReentrant {
        Order storage o = orders[orderId];
        require(o.amount > 0, "not found");
        require(!o.released && !o.refunded, "already resolved");
        require(o.delivered, "not delivered");
        require(block.timestamp > o.confirmDeadline, "confirm window not elapsed");
        require(block.timestamp <= deadline, "deadline passed");
        // Same seller-side fee as the operator path — the escape hatch must not
        // become a way to avoid it.
        _releaseOrder(o, orderId);
    }

    function refundOrderAfterTimeout(uint256 orderId, uint256 deadline) external whenNotPaused nonReentrant {
        Order storage o = orders[orderId];
        require(o.amount > 0, "not found");
        require(!o.released && !o.refunded, "already resolved");
        require(!o.delivered, "already delivered");
        require(block.timestamp > o.deliveryDeadline, "delivery deadline not passed");
        require(block.timestamp <= deadline, "deadline passed");
        o.refunded = true;
        // Buyer gets amount only (fee is non-refundable, already in pendingFees).
        usdc.safeTransfer(o.buyer, o.amount);
        emit OrderRefunded(orderId, msg.sender, o.buyer, o.amount);
    }

    function releaseEscrowAfterTimeout(uint256 dealId, uint256 deadline) external whenNotPaused nonReentrant {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(!d.released && !d.refunded, "already resolved");
        require(d.buyerDeposited, "buyer not deposited");
        require(!d.disputed, "disputed");
        require(d.delivered, "not delivered");
        require(block.timestamp > d.confirmDeadline, "confirm window not elapsed");
        require(block.timestamp <= deadline, "deadline passed");
        _releaseEscrow(d, dealId);
    }

    /**
     * @notice Refund path. Opens in two situations:
     *          1. the seller never marked delivered and the delivery deadline passed;
     *          2. the deal is disputed and the platform never resolved it within
     *             DISPUTE_BACKSTOP — the buyer is the default winner so funds are
     *             never locked forever.
     */
    function refundEscrowAfterTimeout(uint256 dealId, uint256 deadline) external whenNotPaused nonReentrant {
        EscrowDeal storage d = deals[dealId];
        require(d.price > 0, "not found");
        require(!d.released && !d.refunded, "already resolved");
        // An unfunded shell has no deliveryDeadline yet (it is set at funding), so
        // without this guard the "deadline passed" check below would be trivially
        // true and the buyer could refund a deal that never started.
        require(d.buyerDeposited, "not funded");
        require(block.timestamp <= deadline, "deadline passed");

        if (d.disputed) {
            require(block.timestamp > d.disputedAt + DISPUTE_BACKSTOP, "dispute backstop not elapsed");
        } else {
            require(!d.delivered, "already delivered");
            require(block.timestamp > d.deliveryDeadline, "delivery deadline not passed");
        }

        _refundEscrow(d, dealId);
    }

    // =====================================================================
    // Admin
    // =====================================================================

    function addMiddleman(address mm) external onlyOwner {
        require(mm != address(0), "invalid address");
        middlemen[mm] = true;
        emit MiddlemanAdded(mm);
    }

    function removeMiddleman(address mm) external onlyOwner {
        require(mm != address(0), "invalid address");
        require(mm != owner, "cannot remove owner");
        middlemen[mm] = false;
        emit MiddlemanRemoved(mm);
    }

    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "invalid address");
        emit TreasuryUpdated(treasury, t);
        treasury = t;
    }

    /// @notice Transfer contract ownership to a new address (e.g. a multisig).
    ///         Previously `owner` was immutable post-construction, which blocked
    ///         migrating the owner role to a multisig for F6 hardening.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "invalid address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Request a pause. The pause takes effect only after `PAUSE_DELAY`
    ///         (24h) has elapsed AND `executePause()` is called. Mitigates the
    ///         instant-pause rug vector if the owner EOA is compromised.
    function requestPause() external onlyOwner {
        pauseRequestedAt = block.timestamp;
        emit PauseRequested(msg.sender, block.timestamp + PAUSE_DELAY);
    }

    /// @notice Cancel a pending pause request. Resets `pauseRequestedAt`.
    function cancelPause() external onlyOwner {
        require(pauseRequestedAt > 0, "no pause requested");
        pauseRequestedAt = 0;
        emit PauseCancelled(msg.sender);
    }

    /// @notice Execute the pause after `PAUSE_DELAY` has elapsed since
    ///         `requestPause()`. Reverts if no request was made or the delay
    ///         hasn't elapsed yet.
    function executePause() external onlyOwner {
        require(pauseRequestedAt > 0, "no pause requested");
        require(block.timestamp >= pauseRequestedAt + PAUSE_DELAY, "delay not elapsed");
        paused = true;
        pauseRequestedAt = 0;
        emit Paused();
    }

    /// @notice Unpause is instant (no timelock) — this is the recovery path
    ///         after an incident is resolved or a pause was mistaken.
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function collectFees() external nonReentrant {
        require(msg.sender == treasury, "!treasury");
        uint256 f = pendingFees;
        pendingFees = 0;
        usdc.safeTransfer(treasury, f);
        emit FeesCollected(treasury, f);
    }

    /**
     * Apply an EIP-2612 permit for `owner` → this contract as spender.
     * Wrapped in try/catch to tolerate permit front-running: if the permit was
     * already consumed (nonce used) but the resulting allowance is sufficient,
     * we proceed instead of reverting.
     */
    function _applyPermit(
        address tokenOwner,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) internal {
        try IERC20Permit(address(usdc)).permit(tokenOwner, address(this), value, deadline, v, r, s) {
            // permit applied
        } catch {
            require(usdc.allowance(tokenOwner, address(this)) >= value, "permit failed");
        }
    }
}
