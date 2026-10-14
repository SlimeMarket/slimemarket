// ============ SlimeMarket — dummy data ============

const ME = {
  // UUID from `users.id`, assigned on login (app.jsx) — NOT in this literal
  // until now, which made "is the user signed in?" checks look impossible.
  // Declared here so the field is discoverable.
  id: '',
  name: '',
  handle: '',
  uid: '',
  email: '',
  wallet: '',
  role: 'Member',
  txCount: 0,
  usdc: 0,
  // on-chain USDC only (Arc). In non-custodial mode the checkout gate
  // is authoritative on this number; `usdc` above is the display max().
  usdcOnChain: 0,
  forumBalance: 0,
  avatar: 'from-arc-primary to-arc-accent',
  avatarImg: null,
  joined: 'Mar 2026',
  contacts: {},
};

const ROLE_RANK = { Member: 0, Buyer: 1, Seller: 2, Admin: 3 };

const CATEGORIES = ['All', 'Game Accounts', 'Currency', 'Gift Card', 'Digital Products', 'Services'];

const PRODUCTS = []; // populated by loadCatalog() from API

const SELLER_ORDERS = []; // populated by refreshSellerOrders() from API

const TX_HISTORY = []; // populated by refreshWallet() from API

// Buyer-facing primary navigation (sidebar) — browse only
const NAV_BUYER = [
  { id: 'beranda', label: 'Home', icon: 'home', desc: 'Landing' },
  { id: 'storefront', label: 'Explore', icon: 'store', desc: 'Product catalog' },
  { id: 'escrow', label: 'Escrow', icon: 'shield-check', desc: 'WL & P2P Escrow' },
  { id: 'discussion', label: 'Discussion', icon: 'messages-square', desc: 'Public forum' },
  { id: 'seller', label: 'Seller Center', icon: 'layout-dashboard', desc: 'Seller dashboard' },
];

// Account menu (profile dropdown)
const PROFILE_MENU = [
  { id: 'profile', label: 'My Profile', icon: 'user-round' },
  { id: 'orders', label: 'My Orders', icon: 'package-open' },
  { id: 'escrow', label: 'My Escrow', icon: 'shield-check' },
  { id: 'dm', label: 'Chat', icon: 'message-circle' },
  { id: 'balance', label: 'Top Up Balance', icon: 'wallet' },
];

Object.assign(window, {
  ME, ROLE_RANK, CATEGORIES, PRODUCTS, SELLER_ORDERS,
  TX_HISTORY, NAV_BUYER, PROFILE_MENU,
});

// ---- Catalog loader: fetch live products from backend ----
// Views read window.PRODUCTS directly, so we overwrite the global after fetch.
// window.CATALOG_STATE tracks the last outcome so the storefront can render a
// proper error state with retry instead of spinning the skeleton forever
// ('loading' / 'ready' / 'error' / 'empty').
window.CATALOG_STATE = 'loading';
// pagination state. The API pages at 24 items (lib/catalog/products.ts)
// and ignores `limit`, so the SPA used to fetch exactly page 1 and silently
// hide every product after the 24 newest. These globals let the storefront show
// a "Load more" control and know when it has everything.
window.CATALOG_TOTAL = 0;
window.CATALOG_PAGE = 1;

/**
 * Load the catalog.
 * @param {{page?: number, append?: boolean, q?: string, cat?: string}} [opts]
 *   `append` keeps the products already loaded (Load more) instead of replacing.
 */
async function loadCatalog(opts) {
  const o = opts || {};
  const page = o.page || 1;
  const append = !!o.append;
  if (!append) window.CATALOG_STATE = 'loading';
  try {
    const API = window.SLIME_API || '';
    const params = new URLSearchParams({ page: String(page) });
    if (o.q) params.set('q', o.q);
    if (o.cat) params.set('cat', o.cat);
    const res = await fetch(API + '/api/products?' + params.toString(), { credentials: 'include' });
    if (!res.ok) { if (!append) window.CATALOG_STATE = 'error'; return false; }
    const data = await res.json();
    if (data && Array.isArray(data.items)) {
      // De-dupe on append: a product created while paging can shift the window.
      window.PRODUCTS = append
        ? [...window.PRODUCTS, ...data.items.filter(p => !window.PRODUCTS.some(x => x.id === p.id))]
        : data.items;
      window.CATALOG_TOTAL = Number(data.total) || window.PRODUCTS.length;
      window.CATALOG_PAGE = page;
      window.CATALOG_STATE = window.PRODUCTS.length > 0 ? 'ready' : 'empty';
      return true;
    }
    if (!append) window.CATALOG_STATE = 'error';
    return false;
  } catch (e) {
    if (!append) window.CATALOG_STATE = 'error';
    return false;
  }
}
Object.assign(window, { loadCatalog });
