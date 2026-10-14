// ============================================================================
// MarketEscrow — contract tests.
//
// MODEL (marketplace):
//   buyer pays   amount + 2%   (FEE_BPS, collected at creation)
//   seller gets  amount - 2%   (SELLER_FEE_BPS, deducted at release) = 98%
//   platform gets 2% + 2%      = 4% of the item amount
//
// MODEL (WL / rekber escrow):
//   buyer pays   price + 2%
//   seller gets  100% of price  (no seller-side fee)
//
// SETTLEMENT CLOCKS (escrow deals):
//   createdAt ─▶ deliveryDeadline ─▶ (seller markDelivered)
//                                       │
//                                       ▼
//                                 confirmDeadline ─▶ release to seller
//
//   - seller never delivers past deliveryDeadline  ⇒ anyone may refund
//   - delivered but buyer silent past confirmDeadline ⇒ anyone may release
//   - disputed ⇒ escape hatches frozen; backstop refunds the buyer
//
// The two escape-hatch directions are mutually exclusive — there is no
// "first caller wins" race.
// ============================================================================
import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// package.json declares "type": "module", so this suite uses ESM imports.
const { ethers } = hre;

const DAY = 24 * 60 * 60;

describe("MarketEscrow", function () {
  const AMOUNT = 10_000_000n; // $10.00 item (6 decimals)
  const BUYER_FEE = (AMOUNT * 200n) / 10_000n; // 200_000n
  const SELLER_FEE = (AMOUNT * 200n) / 10_000n; // 200_000n
  const SELLER_NET = AMOUNT - SELLER_FEE; // 9_800_000n
  const ODD = 999_999n;

  const DELIVERY = 7 * DAY; // delivery window used by most tests
  const COLLATERAL = 3_000_000n; // $3.00 of seller fraud insurance

  let usdc, escrow;
  let owner, platform, treasury, buyer, seller, mm, other;

  async function deploy() {
    [owner, platform, treasury, buyer, seller, mm, other] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const Escrow = await ethers.getContractFactory("MarketEscrow");
    escrow = await Escrow.deploy(
      await usdc.getAddress(),
      treasury.address,
      platform.address,
    );
    await escrow.waitForDeployment();

    // Fund the actors.
    for (const who of [buyer, seller, mm, other]) {
      await usdc.mint(who.address, 1_000_000_000n); // 1000 USDC
      await usdc.connect(who).approve(await escrow.getAddress(), ethers.MaxUint256);
    }

    // Deployer is owner + middleman; register the platform DCW and an MM too.
    await escrow.addMiddleman(platform.address);
    await escrow.addMiddleman(mm.address);
  }

  beforeEach(deploy);

  // -------------------------------------------------------------------------
  // Fee constants
  // -------------------------------------------------------------------------
  describe("fee constants", function () {
    it("buyer fee is 2% (200 bps)", async function () {
      expect(await escrow.FEE_BPS()).to.equal(200n);
    });

    it("seller fee is 2% (200 bps)", async function () {
      expect(await escrow.SELLER_FEE_BPS()).to.equal(200n);
    });

    it("computeFee is 2% of the amount", async function () {
      expect(await escrow.computeFee(AMOUNT)).to.equal(BUYER_FEE);
    });

    it("computeSellerFee is 2% of the amount", async function () {
      expect(await escrow.computeSellerFee(AMOUNT)).to.equal(SELLER_FEE);
    });

    it("truncates on odd amounts (integer math)", async function () {
      expect(await escrow.computeFee(ODD)).to.equal((ODD * 200n) / 10_000n);
      expect(await escrow.computeSellerFee(ODD)).to.equal((ODD * 200n) / 10_000n);
    });
  });

  // -------------------------------------------------------------------------
  // Marketplace
  // -------------------------------------------------------------------------
  describe("marketplace order lifecycle", function () {
    async function createOrder(amount = AMOUNT) {
      const tx = await escrow.connect(buyer).createOrder(seller.address, amount, DELIVERY);
      await tx.wait();
      return 0n; // first order id
    }

    it("createOrder pulls amount + buyer fee and accrues only the buyer fee", async function () {
      const before = await usdc.balanceOf(buyer.address);
      await createOrder();
      const after = await usdc.balanceOf(buyer.address);

      expect(before - after).to.equal(AMOUNT + BUYER_FEE);
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(AMOUNT + BUYER_FEE);
      expect(await escrow.pendingFees()).to.equal(BUYER_FEE);
    });

    it("createOrder records a delivery deadline", async function () {
      await createOrder();
      const o = await escrow.orders(0);
      const now = BigInt(await time.latest());
      expect(o.deliveryDeadline).to.be.greaterThan(now);
      expect(o.delivered).to.equal(false);
    });

    it("clamps a delivery window below the floor up to MIN_DELIVERY_WINDOW", async function () {
      const min = await escrow.MIN_DELIVERY_WINDOW();
      await escrow.connect(buyer).createOrder(seller.address, AMOUNT, 1n);
      const o = await escrow.orders(0);
      expect(o.deliveryDeadline - o.createdAt).to.equal(min);
    });

    it("clamps a delivery window above the cap down to MAX_DELIVERY_WINDOW", async function () {
      const max = await escrow.MAX_DELIVERY_WINDOW();
      await escrow.connect(buyer).createOrder(seller.address, AMOUNT, 100n * 365n * BigInt(DAY));
      const o = await escrow.orders(0);
      expect(o.deliveryDeadline - o.createdAt).to.equal(max);
    });

    it("releaseOrder pays the seller 98% and adds the seller fee to pendingFees", async function () {
      const id = await createOrder();
      const before = await usdc.balanceOf(seller.address);

      await expect(escrow.connect(platform).releaseOrder(id))
        .to.emit(escrow, "OrderReleased")
        .withArgs(id, platform.address, seller.address, SELLER_NET);

      const after = await usdc.balanceOf(seller.address);
      expect(after - before).to.equal(SELLER_NET);
      // Platform now holds BOTH fees: 2% buyer + 2% seller = 4%.
      expect(await escrow.pendingFees()).to.equal(BUYER_FEE + SELLER_FEE);
      // Escrow keeps only the fees.
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(BUYER_FEE + SELLER_FEE);
    });

    it("the platform's total take is 4% of the item amount", async function () {
      const id = await createOrder();
      await escrow.connect(platform).releaseOrder(id);
      expect(await escrow.pendingFees()).to.equal((AMOUNT * 400n) / 10_000n);
    });

    it("refundOrder returns the item amount to the buyer and charges NO seller fee", async function () {
      const id = await createOrder();
      const before = await usdc.balanceOf(buyer.address);

      await escrow.connect(platform).refundOrder(id);

      // Buyer gets the item back; the 2% buyer fee is non-refundable.
      expect((await usdc.balanceOf(buyer.address)) - before).to.equal(AMOUNT);
      expect(await escrow.pendingFees()).to.equal(BUYER_FEE);
    });

    it("cannot release or refund twice", async function () {
      const id = await createOrder();
      await escrow.connect(platform).releaseOrder(id);
      await expect(escrow.connect(platform).releaseOrder(id)).to.be.revertedWith("already resolved");
      await expect(escrow.connect(platform).refundOrder(id)).to.be.revertedWith("already resolved");
    });

    it("only an operator may release", async function () {
      const id = await createOrder();
      await expect(escrow.connect(other).releaseOrder(id)).to.be.revertedWith("!operator");
    });

    it("confirmOrder lets the BUYER release without any operator", async function () {
      const id = await createOrder();
      const before = await usdc.balanceOf(seller.address);

      await expect(escrow.connect(buyer).confirmOrder(id)).to.emit(escrow, "OrderConfirmed");

      expect((await usdc.balanceOf(seller.address)) - before).to.equal(SELLER_NET);
    });

    it("confirmOrder is buyer-only", async function () {
      const id = await createOrder();
      await expect(escrow.connect(other).confirmOrder(id)).to.be.revertedWith("!buyer");
    });
  });

  // -------------------------------------------------------------------------
  // WL / rekber escrow — deliberately different: seller gets 100%
  // -------------------------------------------------------------------------
  describe("WL escrow lifecycle (no seller fee)", function () {
    async function createDeal(price = AMOUNT, window = DELIVERY) {
      await escrow.connect(buyer).createEscrowDeal(seller.address, price, window);
      return 0n;
    }

    it("createEscrowDeal pulls price + buyer fee", async function () {
      const before = await usdc.balanceOf(buyer.address);
      await createDeal();
      expect(before - (await usdc.balanceOf(buyer.address))).to.equal(AMOUNT + BUYER_FEE);
      expect(await escrow.pendingFees()).to.equal(BUYER_FEE);
    });

    it("releaseEscrow pays the seller the FULL price (no 2% seller fee)", async function () {
      await createDeal();
      const before = await usdc.balanceOf(seller.address);

      await escrow.connect(mm).releaseEscrow(0);

      expect((await usdc.balanceOf(seller.address)) - before).to.equal(AMOUNT);
      // Only the buyer fee is platform revenue on a WL deal.
      expect(await escrow.pendingFees()).to.equal(BUYER_FEE);
    });

    it("refundEscrow returns the price to the buyer", async function () {
      await createDeal();
      const before = await usdc.balanceOf(buyer.address);

      await escrow.connect(mm).refundEscrow(0);

      expect((await usdc.balanceOf(buyer.address)) - before).to.equal(AMOUNT);
      expect(await escrow.pendingFees()).to.equal(BUYER_FEE);
    });

    it("only a middleman may release or refund an escrow deal", async function () {
      await createDeal();
      await expect(escrow.connect(other).releaseEscrow(0)).to.be.revertedWith("!mm");
      await expect(escrow.connect(other).refundEscrow(0)).to.be.revertedWith("!mm");
    });

    it("confirmEscrow lets the BUYER release immediately (no middleman)", async function () {
      await createDeal();
      const before = await usdc.balanceOf(seller.address);

      await expect(escrow.connect(buyer).confirmEscrow(0)).to.emit(escrow, "DealConfirmed");

      expect((await usdc.balanceOf(seller.address)) - before).to.equal(AMOUNT);
      const d = await escrow.deals(0);
      expect(d.buyerConfirmed).to.equal(true);
      expect(d.released).to.equal(true);
    });

    it("confirmEscrow is buyer-only", async function () {
      await createDeal();
      await expect(escrow.connect(other).confirmEscrow(0)).to.be.revertedWith("!buyer");
    });
  });

  // -------------------------------------------------------------------------
  // Collateral — the seller's fraud insurance
  // -------------------------------------------------------------------------
  describe("seller collateral", function () {
    async function createDeal() {
      await escrow.connect(buyer).createEscrowDeal(seller.address, AMOUNT, DELIVERY);
      return 0n;
    }

    it("seller can deposit collateral, and it is returned on a normal release", async function () {
      await createDeal();
      await escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL);
      expect((await escrow.deals(0)).collateral).to.equal(COLLATERAL);

      const before = await usdc.balanceOf(seller.address);
      await escrow.connect(mm).releaseEscrow(0);
      // price (100%) + collateral back
      expect((await usdc.balanceOf(seller.address)) - before).to.equal(AMOUNT + COLLATERAL);
    });

    it("collateral can be TOPPED UP — the deal-room renegotiation path", async function () {
      await createDeal();
      await escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL);
      await expect(escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL))
        .to.emit(escrow, "CollateralAdded")
        .withArgs(0, seller.address, COLLATERAL, COLLATERAL * 2n);

      expect((await escrow.deals(0)).collateral).to.equal(COLLATERAL * 2n);
    });

    it("only the seller may deposit collateral", async function () {
      await createDeal();
      await expect(
        escrow.connect(other).depositEscrowCollateral(0, COLLATERAL),
      ).to.be.revertedWith("!seller");
    });

    it("collateral cannot be withdrawn once deposited (buyer stays protected)", async function () {
      await createDeal();
      await escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL);
      // There is no withdrawal entry point at all; the balance can only grow.
      const d = await escrow.deals(0);
      expect(d.collateral).to.equal(COLLATERAL);
      expect(d.collateralReturned).to.equal(0n);
    });

    it("normal refund returns the collateral to the seller (no fraud established)", async function () {
      await createDeal();
      await escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL);

      const before = await usdc.balanceOf(seller.address);
      await escrow.connect(mm).refundEscrow(0);
      expect((await usdc.balanceOf(seller.address)) - before).to.equal(COLLATERAL);
    });

    it("refundEscrowWithSlash pays the buyer price + collateral (fraud compensation)", async function () {
      await createDeal();
      await escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL);

      const buyerBefore = await usdc.balanceOf(buyer.address);
      const sellerBefore = await usdc.balanceOf(seller.address);

      await expect(escrow.connect(mm).refundEscrowWithSlash(0))
        .to.emit(escrow, "DealRefundedWithSlash")
        .withArgs(0, mm.address, buyer.address, AMOUNT, COLLATERAL);

      // Buyer is made whole: price back + the seller's collateral as compensation.
      expect((await usdc.balanceOf(buyer.address)) - buyerBefore).to.equal(AMOUNT + COLLATERAL);
      // The seller gets nothing back — the collateral is gone for good.
      expect(await usdc.balanceOf(seller.address)).to.equal(sellerBefore);
    });

    it("refundEscrowWithSlash requires collateral to exist", async function () {
      await createDeal();
      await expect(escrow.connect(mm).refundEscrowWithSlash(0))
        .to.be.revertedWith("no collateral to slash");
    });

    it("only a middleman may slash", async function () {
      await createDeal();
      await escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL);
      await expect(escrow.connect(other).refundEscrowWithSlash(0)).to.be.revertedWith("!mm");
    });
  });

  // -------------------------------------------------------------------------
  // Two clocks — deterministic settlement, no race
  // -------------------------------------------------------------------------
  describe("settlement clocks (no release/refund race)", function () {
    async function createDeal() {
      await escrow.connect(buyer).createEscrowDeal(seller.address, AMOUNT, DELIVERY);
      return 0n;
    }

    it("markDelivered sets the confirm deadline and is seller-only", async function () {
      await createDeal();
      await expect(escrow.connect(other).markDelivered(0)).to.be.revertedWith("!seller");

      await expect(escrow.connect(seller).markDelivered(0)).to.emit(escrow, "DealDelivered");
      const d = await escrow.deals(0);
      const confirm = await escrow.CONFIRM_WINDOW();
      expect(d.delivered).to.equal(true);
      expect(d.confirmDeadline).to.be.greaterThan(0n);
      expect(confirm).to.equal(BigInt(7 * DAY));
    });

    it("seller cannot mark delivered after the delivery deadline", async function () {
      await createDeal();
      await time.increase(DELIVERY + 1);
      await expect(escrow.connect(seller).markDelivered(0))
        .to.be.revertedWith("delivery deadline passed");
    });

    it("REFUND opens when the seller never delivered past the deadline", async function () {
      await createDeal();
      const early = BigInt(await time.latest()) + 3600n;

      // Not yet — the delivery deadline has not passed.
      await expect(escrow.connect(other).refundEscrowAfterTimeout(0, early))
        .to.be.revertedWith("delivery deadline not passed");

      await time.increase(DELIVERY + 1);
      const deadline = BigInt(await time.latest()) + 3600n;
      const buyerBefore = await usdc.balanceOf(buyer.address);
      await escrow.connect(other).refundEscrowAfterTimeout(0, deadline);
      expect((await usdc.balanceOf(buyer.address)) - buyerBefore).to.equal(AMOUNT);
    });

    it("RELEASE is blocked while the deal is undelivered — this is the race fix", async function () {
      await createDeal();
      await time.increase(DELIVERY + 1);
      const deadline = BigInt(await time.latest()) + 3600n;
      // The old contract allowed anyone to release here. Now it must not.
      await expect(escrow.connect(other).releaseEscrowAfterTimeout(0, deadline))
        .to.be.revertedWith("not delivered");
    });

    it("RELEASE opens only after delivery + the confirm window", async function () {
      await createDeal();
      await escrow.connect(seller).markDelivered(0);

      const deadline = BigInt(await time.latest()) + 40n * BigInt(DAY);
      await expect(escrow.connect(other).releaseEscrowAfterTimeout(0, deadline))
        .to.be.revertedWith("confirm window not elapsed");

      await time.increase(7 * DAY + 1);
      const sellerBefore = await usdc.balanceOf(seller.address);
      await escrow.connect(other).releaseEscrowAfterTimeout(0, deadline);
      expect((await usdc.balanceOf(seller.address)) - sellerBefore).to.equal(AMOUNT);
    });

    it("REFUND is blocked once the seller has delivered", async function () {
      await createDeal();
      await escrow.connect(seller).markDelivered(0);
      await time.increase(8 * DAY);
      const deadline = BigInt(await time.latest()) + 3600n;
      await expect(escrow.connect(other).refundEscrowAfterTimeout(0, deadline))
        .to.be.revertedWith("already delivered");
    });

    it("delivery window is flexible per deal (airdrop case: months out)", async function () {
      const window = 90n * BigInt(DAY); // ~3 months
      await escrow.connect(buyer).createEscrowDeal(seller.address, AMOUNT, window);
      const d = await escrow.deals(0);
      expect(d.deliveryDeadline - d.createdAt).to.equal(window);
    });
  });

  // -------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------
  describe("disputes", function () {
    async function createDeal() {
      await escrow.connect(buyer).createEscrowDeal(seller.address, AMOUNT, DELIVERY);
      return 0n;
    }

    it("either party may flag a dispute; third parties may not", async function () {
      await createDeal();
      await expect(escrow.connect(other).flagDispute(0)).to.be.revertedWith("!party");

      await expect(escrow.connect(buyer).flagDispute(0)).to.emit(escrow, "DealDisputed");
      const d = await escrow.deals(0);
      expect(d.disputed).to.equal(true);
      expect(d.disputedAt).to.be.greaterThan(0n);
    });

    it("a dispute FREEZES the release escape hatch even after delivery", async function () {
      await createDeal();
      await escrow.connect(seller).markDelivered(0);
      await escrow.connect(buyer).flagDispute(0);
      await time.increase(8 * DAY);

      const deadline = BigInt(await time.latest()) + 400n * BigInt(DAY);
      await expect(escrow.connect(other).releaseEscrowAfterTimeout(0, deadline))
        .to.be.revertedWith("disputed");
    });

    it("the middleman can still resolve a disputed deal", async function () {
      await createDeal();
      await escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL);
      await escrow.connect(buyer).flagDispute(0);

      const buyerBefore = await usdc.balanceOf(buyer.address);
      await escrow.connect(mm).refundEscrowWithSlash(0);
      expect((await usdc.balanceOf(buyer.address)) - buyerBefore).to.equal(AMOUNT + COLLATERAL);
    });

    it("dispute backstop refunds the buyer if the platform never resolves", async function () {
      await createDeal();
      await escrow.connect(buyer).flagDispute(0);
      const deadline = BigInt(await time.latest()) + 400n * BigInt(DAY);

      const backstop = await escrow.DISPUTE_BACKSTOP();
      await expect(escrow.connect(other).refundEscrowAfterTimeout(0, deadline))
        .to.be.revertedWith("dispute backstop not elapsed");

      await time.increase(Number(backstop) + 1);
      const buyerBefore = await usdc.balanceOf(buyer.address);
      await escrow.connect(other).refundEscrowAfterTimeout(0, deadline);
      expect((await usdc.balanceOf(buyer.address)) - buyerBefore).to.equal(AMOUNT);
    });
  });

  // -------------------------------------------------------------------------
  // Treasury — single wallet, no multisig
  // -------------------------------------------------------------------------
  describe("collectFees", function () {
    it("only the treasury may collect", async function () {
      await escrow.connect(buyer).createOrder(seller.address, AMOUNT, DELIVERY);
      await expect(escrow.connect(platform).collectFees()).to.be.revertedWith("!treasury");
    });

    it("sweeps pendingFees to the treasury and zeroes the accumulator", async function () {
      await escrow.connect(buyer).createOrder(seller.address, AMOUNT, DELIVERY);
      await escrow.connect(platform).releaseOrder(0);

      const expected = BUYER_FEE + SELLER_FEE;
      const before = await usdc.balanceOf(treasury.address);

      await expect(escrow.connect(treasury).collectFees())
        .to.emit(escrow, "FeesCollected")
        .withArgs(treasury.address, expected);

      expect((await usdc.balanceOf(treasury.address)) - before).to.equal(expected);
      expect(await escrow.pendingFees()).to.equal(0n);
    });

    it("setTreasury is owner-only and repoints the sweep target", async function () {
      await expect(escrow.connect(other).setTreasury(other.address)).to.be.revertedWith("!owner");
      await escrow.setTreasury(other.address);
      expect(await escrow.treasury()).to.equal(other.address);
    });
  });

  // -------------------------------------------------------------------------
  // Pause
  // -------------------------------------------------------------------------
  describe("pause", function () {
    it("requires the delay before pausing, and unpause is instant", async function () {
      await escrow.requestPause();
      await expect(escrow.executePause()).to.be.revertedWith("delay not elapsed");
      await time.increase(24 * 60 * 60 + 1);
      await escrow.executePause();
      expect(await escrow.paused()).to.equal(true);

      await expect(escrow.connect(buyer).createOrder(seller.address, AMOUNT, DELIVERY))
        .to.be.revertedWith("paused");

      await escrow.unpause();
      expect(await escrow.paused()).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------
  describe("roles", function () {
    it("addMiddleman is owner-only", async function () {
      await expect(escrow.connect(other).addMiddleman(other.address)).to.be.revertedWith("!owner");
    });

    it("a removed middleman can no longer release escrow", async function () {
      await escrow.connect(buyer).createEscrowDeal(seller.address, AMOUNT, DELIVERY);
      await escrow.removeMiddleman(mm.address);
      await expect(escrow.connect(mm).releaseEscrow(0)).to.be.revertedWith("!mm");
    });

    it("the platform is an operator even when not a middleman", async function () {
      await escrow.removeMiddleman(platform.address);
      await escrow.connect(buyer).createOrder(seller.address, AMOUNT, DELIVERY);
      await escrow.connect(platform).releaseOrder(0); // onlyOperator: platform || middlemen
      expect(await escrow.pendingFees()).to.equal(BUYER_FEE + SELLER_FEE);
    });
  });

  // -------------------------------------------------------------------------
  // Collateral-first shell flow (A2)
  //
  // The seller opens an unfunded shell AND deposits collateral in one tx; only
  // then can the buyer fund it. This makes "buyer's money locked with nothing
  // backing it" structurally impossible, rather than merely discouraged.
  // -------------------------------------------------------------------------
  describe("collateral-first shell flow", function () {
    const WINDOW = 7 * DAY;

    async function openShell(collateral = COLLATERAL) {
      await escrow.connect(seller).createEscrowDealAsSeller(
        buyer.address, AMOUNT, WINDOW, collateral,
      );
      return 0n;
    }

    it("seller opens a shell and deposits collateral in one transaction", async function () {
      const before = await usdc.balanceOf(seller.address);
      await expect(
        escrow.connect(seller).createEscrowDealAsSeller(buyer.address, AMOUNT, WINDOW, COLLATERAL),
      ).to.emit(escrow, "CollateralAdded");

      expect(before - (await usdc.balanceOf(seller.address))).to.equal(COLLATERAL);
      const d = await escrow.deals(0);
      expect(d.collateral).to.equal(COLLATERAL);
      expect(d.buyerDeposited).to.equal(false);
      // The delivery clock must NOT have started yet.
      expect(d.deliveryDeadline).to.equal(0n);
    });

    it("the buyer cannot fund a shell with no collateral", async function () {
      await escrow.connect(seller).createEscrowDealAsSeller(buyer.address, AMOUNT, WINDOW, 0n);
      await expect(escrow.connect(buyer).fundEscrowDeal(0))
        .to.be.revertedWith("collateral not deposited");
    });

    it("funding moves the buyer's money and starts the delivery clock", async function () {
      await openShell();
      const before = await usdc.balanceOf(buyer.address);

      await expect(escrow.connect(buyer).fundEscrowDeal(0)).to.emit(escrow, "DealFunded");

      expect(before - (await usdc.balanceOf(buyer.address))).to.equal(AMOUNT + BUYER_FEE);
      const d = await escrow.deals(0);
      expect(d.buyerDeposited).to.equal(true);
      expect(d.deliveryDeadline - d.createdAt).to.equal(BigInt(WINDOW));
      expect(await escrow.pendingFees()).to.equal(BUYER_FEE);
    });

    it("only the named buyer may fund", async function () {
      await openShell();
      await expect(escrow.connect(other).fundEscrowDeal(0)).to.be.revertedWith("!buyer");
    });

    it("a shell cannot be funded twice", async function () {
      await openShell();
      await escrow.connect(buyer).fundEscrowDeal(0);
      await expect(escrow.connect(buyer).fundEscrowDeal(0)).to.be.revertedWith("already funded");
    });

    it("the seller cannot be their own buyer", async function () {
      await expect(
        escrow.connect(seller).createEscrowDealAsSeller(seller.address, AMOUNT, WINDOW, COLLATERAL),
      ).to.be.revertedWith("buyer != seller");
    });

    it("a funded shell settles exactly like a directly-created deal", async function () {
      await openShell();
      await escrow.connect(buyer).fundEscrowDeal(0);
      await escrow.connect(seller).markDelivered(0);

      const before = await usdc.balanceOf(seller.address);
      await escrow.connect(buyer).confirmEscrow(0);
      // Seller receives 100% of price plus the collateral back.
      expect((await usdc.balanceOf(seller.address)) - before).to.equal(AMOUNT + COLLATERAL);
    });

    it("an UNFUNDED shell cannot be marked delivered", async function () {
      await openShell();
      await expect(escrow.connect(seller).markDelivered(0))
        .to.be.revertedWith("buyer not deposited");
    });

    it("an UNFUNDED shell cannot be refunded via the timeout hatch", async function () {
      await openShell();
      // deliveryDeadline is 0 while unfunded, so without the guard this would
      // pass trivially and let the buyer unwind a deal that never started.
      const deadline = BigInt(await time.latest()) + 3600n;
      await expect(escrow.connect(other).refundEscrowAfterTimeout(0, deadline))
        .to.be.revertedWith("not funded");
    });

    it("the middleman can refund an unfunded shell, returning the collateral", async function () {
      await openShell();
      const before = await usdc.balanceOf(seller.address);
      await escrow.connect(mm).refundEscrow(0);
      expect((await usdc.balanceOf(seller.address)) - before).to.equal(COLLATERAL);
      expect((await escrow.deals(0)).refunded).to.equal(true);
    });

    it("slashing an unfunded shell still pays the collateral to the buyer", async function () {
      // Otherwise the deposit would be stranded in the contract forever.
      await openShell();
      const before = await usdc.balanceOf(buyer.address);
      await escrow.connect(mm).refundEscrowWithSlash(0);
      expect((await usdc.balanceOf(buyer.address)) - before).to.equal(COLLATERAL);
    });

    it("the seller can top up collateral before the buyer funds", async function () {
      await openShell();
      await escrow.connect(seller).depositEscrowCollateral(0, COLLATERAL);
      expect((await escrow.deals(0)).collateral).to.equal(COLLATERAL * 2n);
      await escrow.connect(buyer).fundEscrowDeal(0);
      expect((await escrow.deals(0)).buyerDeposited).to.equal(true);
    });
  });
});
