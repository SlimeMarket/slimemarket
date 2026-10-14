// ============ SlimeMarket — client-side router (clean marketplace URLs) ============
// Server serves the SPA for every path (app/[[...slug]]/route.ts), so deep links
// and refresh work. This module keeps the URL <-> view state in sync.

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** name -> url-safe slug (cosmetic; lookup uses the id). */
function slugify(str) {
  return String(str || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

/** Extract a UUID from the tail of a slug segment, else return the raw segment. */
function extractId(seg) {
  const m = String(seg || '').match(UUID_RE);
  return m ? m[1] : (seg || '');
}

/** view + entity -> pathname. */
function buildPath(view, e) {
  e = e || {};
  switch (view) {
    case 'beranda':     return '/';
    case 'storefront':  return '/explore';
    case 'product':     return '/products/' + (e.slug ? slugify(e.slug) + '-' : (e.name ? slugify(e.name) + '-' : '')) + (e.id || '');
    case 'store':       return '/store/' + encodeURIComponent(e.handle || slugify(e.name || '') || '');
    case 'orders':      return '/orders';
    case 'orderdetail': return '/orders/' + (e.id || '');
    case 'escrow':      return '/escrow';
    case 'dealroom':    return '/escrow/' + (e.id || '');
    case 'balance':     return '/wallet';
    case 'dm':          return '/chat' + (e.id ? '/' + e.id : '');
    case 'discussion':  return '/forum' + (e.channel ? '/' + e.channel : '');
    case 'seller':      return '/seller';
    case 'sellerorder': return '/seller/orders/' + (e.id || '');
    case 'admin':       return '/admin';
    case 'mm':           return '/mm';
    case 'profile':     return '/profile';
    case 'user':        return '/u/' + (e.uid || '');
    case 'auth':        return '/auth';
    default:            return '/';
  }
}

/** pathname -> { view, id?, slug?, handle?, channel?, uid? }. */
function parsePath(pathname) {
  const s = (pathname || '/').replace(/\/+$/, '') || '/';
  const parts = s.split('/').filter(Boolean);
  const seg = parts[0] || '';
  const p1 = parts[1] || '';
  const p2 = parts[2] || '';
  switch (seg) {
    case '':                        return { view: 'beranda' };
    case 'explore': case 'storefront': return { view: 'storefront' };
    case 'products': case 'product': return { view: 'product', id: extractId(p1), slug: p1 };
    case 'store':                   return { view: 'store', handle: decodeURIComponent(p1) };
    case 'orders':                  return p1 ? { view: 'orderdetail', id: p1 } : { view: 'orders' };
    case 'escrow': case 'rekber':   return p1 ? { view: 'dealroom', id: p1 } : { view: 'escrow' };
    case 'wallet': case 'balance':  return { view: 'balance' };
    case 'chat': case 'dm':         return { view: 'dm', id: p1 || null };
    case 'forum': case 'discussion':return { view: 'discussion', channel: p1 || null };
    case 'seller':                  return (p1 === 'orders' && p2) ? { view: 'sellerorder', id: p2 } : { view: 'seller' };
    case 'admin':                   return { view: 'admin' };
    case 'mm': case 'middleman':     return { view: 'mm' };
    case 'profile':                 return { view: 'profile' };
    case 'u':                       return { view: 'user', uid: p1 };
    case 'auth':                   return { view: 'auth' };
    case 'refresh-session':        return { view: 'refresh-session' };
    default:                        return { view: 'notfound' };
  }
}

/** Push a new URL without reloading (no-op if same path). */
function pushPath(view, entity) {
  const path = buildPath(view, entity);
  if (window.location.pathname !== path) {
    window.history.pushState({ view }, '', path);
  }
  return path;
}

window.SlimeRouter = { slugify, extractId, buildPath, parsePath, pushPath };
