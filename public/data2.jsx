// ============ SlimeMarket — buyer-flow dummy data ============

// ---- Landing hero banners (SlimeMarket original branding) ----
const BANNERS = [
  {
    id: 'b1', kind: 'brand',
    title: 'Digital Asset Marketplace, Secured On-Chain.',
    sub: 'Every transaction is guarded by Smart-Contract Escrow. Anti-scam, money back if it fails.',
    cta: 'Start Shopping', gradient: 'from-arc-primary via-arc-primarydk to-arc-bg', glyph: '🛡',
  },
  {
    id: 'b2', kind: 'promo',
    title: 'ChatGPT Plus', price: 29, badge: 'AI TOOLS',
    sub: 'Upgrade AI for work, study & productivity',
    features: ['Fast response', 'Priority access', 'Great for tasks', 'Affordable'],
    cta: 'Order Now', gradient: 'from-cyan-600 via-blue-700 to-indigo-900', glyph: '◈',
  },
];

// Landing-page category cards.
//
// `id` is only an i18n key suffix (home.cat.<id>) and must NOT be sent to the
// storefront: these are broad marketing groupings, while the storefront filters
// on the REAL `products.category` values (see CATEGORIES in data.jsx). Sending
// the grouping id meant the filter matched nothing, and sending `label` as a
// search query meant clicking a card searched for the literal text "Game
// Products" — which also matched nothing.
//
// `cat` is the storefront category each card maps to. It must be one of
// CATEGORIES. A grouping that spans several real categories needs a storefront
// change (multi-category filter); until then each card maps to its closest one.
const HOME_CATS = [
  { id: 'digital', label: 'Digital Products', icon: 'sparkles', tone: 'violet', cat: 'Digital Products' },
  { id: 'game', label: 'Game Products', icon: 'gamepad-2', tone: 'cyan', cat: 'Game Accounts' },
  { id: 'jasa', label: 'Services', icon: 'briefcase', tone: 'emerald', cat: 'Services' },
];

const STORES = {}; // populated by loadStores() from API

const REVIEWS = []; // fetched from /api/stores/:uid/reviews

const BUYER_ORDERS = []; // populated by refreshOrders() from API

const REKBER_TX = []; // escrow deals fetched from /api/wl/deals

const REKBER_STAGES = ['WAITING', 'APPROVED', 'SENT', 'COMPLETED', 'CANCELLED'];

const SALDO = {
  usdc: 0,
  maxTopupUSDC: 2000,
  banks: [],
};

const FIAT_TX = []; // populated by refreshWallet() from API

const TOPUP_METHODS = [
  { id: 'qris', label: 'QRIS', sub: 'Instant · scan & pay', icon: 'qr-code' },
  { id: 'card', label: 'Card / Visa', sub: 'Circle on-ramp', icon: 'credit-card' },
  { id: 'bank', label: 'Bank Transfer', sub: 'Manual · VA', icon: 'building-2' },
];

function storeProducts(name) {
  return (window.PRODUCTS || []).filter(p => p.seller.name === name);
}

const CHAT_THREADS = []; // fetched from /api/chats after auth

const CHAT_TYPES = [{ id: 'all', label: 'All Types' }, { id: 'normal', label: 'Normal / DM' }, { id: 'escrow', label: 'Escrow' }, { id: 'dispute', label: 'Tribunal' }];
const CHAT_STATUSES = [{ id: 'all', label: 'All Status' }, { id: 'active', label: 'Active' }, { id: 'disrupted', label: 'Disrupted' }, { id: 'closed', label: 'Closed' }, { id: 'resolved', label: 'Resolved' }];

const GLOBAL_DISCUSSION = []; // fetched from /api/forum/posts

const DISC_ROLE_META = {
  'Admin': { color: 'rose', icon: 'shield' },
  'Top Seller': { color: 'amber', icon: 'crown' },
  'Seller': { color: 'emerald', icon: 'store' },
  'Verified': { color: 'emerald', icon: 'badge-check' },
  'Buyer': { color: 'slate', icon: 'user' },
  'Member': { color: 'slate', icon: 'user-round' },
};

const CANCEL_REASONS = [
  'Seller not online / AFK',
  'Found another seller who is online',
  'Processing takes too long',
  'Wrong product / variant selected',
  'Changed my mind',
];
const DECLINE_REASONS = [
  'Out of stock',
  'Wrong price / typo',
  'Cannot process right now',
  'Suspicious buyer',
  'Account issue',
];

// ---- Forum channels (gated behind Buyer+; Members see Global only) ----
const FORUM_CHANNELS = [
  { id: 'global', label: 'Global', hash: '#global', icon: 'globe', gated: false, desc: 'General discussion' },
  { id: 'wts', label: 'WTS', hash: '#wts', icon: 'tag', gated: true, desc: 'Want To Sell' },
  { id: 'wtb', label: 'WTB', hash: '#wtb', icon: 'search', gated: true, desc: 'Want To Buy' },
  { id: 'alpha', label: 'AlphaShare', hash: '#alpha-share', icon: 'gem', gated: true, desc: 'Alpha & WL intel' },
  { id: 'freebie', label: 'Freebie', hash: '#freebie', icon: 'gift', gated: true, desc: 'Free stuff & giveaways' },
  { id: 'discount', label: 'Discount', hash: '#discount', icon: 'badge-percent', gated: true, desc: 'Promos & flash sales' },
  { id: 'aitalk', label: 'AI-Talk', hash: '#ai-talk', icon: 'bot', gated: true, desc: 'AI tools & prompts' },
  { id: 'nfts', label: 'NFTs', hash: '#nfts', icon: 'hexagon', gated: true, desc: 'Mint, flip, collect' },
];

const FORUM_MESSAGES = {
  global: [], wts: [], wtb: [], alpha: [], freebie: [], discount: [], aitalk: [], nfts: [],
};

const MY_STORE = {
  name: '',
  handle: '',
  uid: ME.uid,
  avatar: 'from-arc-primary to-arc-accent',
  avatarImg: null,
  banner: 'from-arc-primary via-arc-primarydk to-arc-surface',
  bannerImg: null,
  message: '',
  rating: 0, joined: '', // ratingCount/joined filled by loadMyStore() from the API
};

const SELLER_CATEGORIES = ['Digital Products', 'Game Products', 'Game Accounts', 'Currency', 'Gift Card', 'Services'];

const MY_PRODUCTS = []; // fetched from /api/my/products

function censorName(name) {
  if (!name) return '';
  const s = String(name);
  if (s.length <= 3) return s[0] + '*'.repeat(Math.max(1, s.length - 1));
  return s.slice(0, 3) + '*'.repeat(Math.min(7, s.length - 3));
}

// ---- WL (Whitelist) marketplace — Escrow-only ----
const WL_TYPES = [
  { id: 'mint', label: 'Mint', icon: 'hammer', collateral: true, desc: 'Seller mints directly to buyer wallet' },
  { id: 'token_transfer', label: 'Token Transfer', icon: 'arrow-left-right', collateral: true, desc: 'Transfer token / NFT to buyer wallet' },
  { id: 'wallet_surrender', label: 'Wallet Surrender', icon: 'key-round', collateral: true, desc: 'Full wallet + seed phrase handover' },
  { id: 'discord_surrender', label: 'Discord Surrender', icon: 'message-square', collateral: false, desc: 'Hand over Discord account with role' },
  { id: 'wallet_submit', label: 'Wallet Submit', icon: 'wallet', collateral: false, desc: 'Submit buyer address to project allowlist' },
];
function wlTypeMeta(id) { return WL_TYPES.find(t => t.id === id) || WL_TYPES[0]; }

const WL_LISTINGS = []; // fetched from /api/wl/listings

const WL_STAGES = ['WAITING', 'ESCROW', 'COMPLETED', 'CANCELLED'];
const WL_STAGE_META = {
  WAITING: { tone: 'amber', icon: 'gavel', label: 'Waiting for Seller to Proceed' },
  ESCROW: { tone: 'blue', icon: 'lock', label: 'Escrow Active · Processing' },
  // 0071 — a party raised a dispute. The on-chain escape hatches are frozen and
  // the middleman arbitrates; if the platform never resolves, the contract
  // refunds the buyer after 30 days.
  DISPUTED: { tone: 'rose', icon: 'shield-alert', label: 'Disputed · Awaiting Middleman' },
  COMPLETED: { tone: 'emerald', icon: 'check-check', label: 'Complete · Released to seller' },
  CANCELLED: { tone: 'rose', icon: 'undo-2', label: 'Refunded · Returned to buyer' },
};

// lookup helper for View Profile
function findUserProfile(name) {
  const store = STORES[name];
  if (store) return { name: store.name, uid: store.uid, avatar: store.avatar, role: 'Seller', rating: store.rating, ratingCount: store.ratingCount, joined: store.joined, online: store.online, isStore: true, message: store.message };
  const disc = (GLOBAL_DISCUSSION).find(m => m.user === name) || (CHAT_THREADS).find(t => t.user === name);
  if (disc) return { name, uid: disc.uid || '—', avatar: disc.avatar, role: disc.role || 'Buyer', rating: null, joined: '2026', online: true, isStore: false };
  return { name, uid: '—', avatar: 'from-arc-primary to-arc-accent', role: 'Buyer', rating: null, joined: '2026', online: true, isStore: false };
}

Object.assign(window, {
  BANNERS, HOME_CATS, STORES, REVIEWS, BUYER_ORDERS,
  REKBER_TX, REKBER_STAGES, SALDO, FIAT_TX, TOPUP_METHODS, storeProducts,
  CHAT_THREADS, CHAT_TYPES, CHAT_STATUSES, GLOBAL_DISCUSSION, DISC_ROLE_META,
  findUserProfile, CANCEL_REASONS, DECLINE_REASONS,
  FORUM_CHANNELS, FORUM_MESSAGES, MY_STORE, MY_PRODUCTS, SELLER_CATEGORIES, censorName,
  WL_TYPES, wlTypeMeta, WL_LISTINGS, WL_STAGES, WL_STAGE_META,
});

// ---- Store + review loaders: fetch from backend, fallback to dummy ----
async function loadStores() {
  try {
    const API = window.SLIME_API || '';
    // Build STORES map from products (each carries its seller). A dedicated
    // /api/stores list endpoint can replace this later.
    const res = await fetch(API + '/api/products?limit=100', { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data || !Array.isArray(data.items)) return false;
    const map = {};
    for (const p of data.items) {
      if (p.seller && p.seller.name && !map[p.seller.name]) {
        map[p.seller.name] = {
          name: p.seller.name,
          handle: '@' + (p.seller.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
          uid: p.seller.name,
          avatar: p.seller.avatar || 'from-arc-primary to-arc-accent',
          banner: 'from-arc-surface2 via-arc-surface to-arc-bg',
          rating: p.seller.rating || 0,
          // The products API doesn't expose ratingCount for the seller —
          // leave undefined and let the openStore() profile merge fill it
          // (avoids the hardcoded 0 lying on the store page).
          ratingCount: p.seller.ratingCount ?? undefined,
          online: true,
          joined: p.joined || '',
          message: '',
        };
      }
    }
    if (Object.keys(map).length > 0) { window.STORES = map; return true; }
    return false;
  } catch (e) { return false; }
}

// ---- My Store loader: hydrate window.MY_STORE from backend ----
// Fixes "save doesn't persist after refresh": previously the FE only ever
// used the static MY_STORE default and never fetched the saved profile.
// Maps DB columns (banner_url, banner_gradient, avatar_url, avatar_gradient)
// to the frontend field names (bannerImg, banner, avatarImg, avatar).
async function loadMyStore() {
  try {
    const API = window.SLIME_API || '';
    const res = await fetch(API + '/api/my/store', { credentials: 'include' });
    if (!res.ok) return null; // not a seller yet, or not logged in
    const data = await res.json();
    const s = data && data.store;
    if (!s) return null;
    const hydrated = {
      name: s.name || '',
      handle: s.handle || '',
      uid: s.uid || ME.uid,
      avatar: s.avatar_gradient || 'from-arc-primary to-arc-accent',
      avatarImg: s.avatar_url || null,
      banner: s.banner_gradient || 'from-arc-primary via-arc-primarydk to-arc-surface',
      bannerImg: s.banner_url || null,
      message: s.message || '',
      rating: Number(s.rating) || 0,
      ratingCount: Number(s.rating_count) || 0,
      joined: s.joined_at || '',
    };
    window.MY_STORE = hydrated;
    return hydrated;
  } catch (e) { return null; }
}

Object.assign(window, { loadStores, loadMyStore });
