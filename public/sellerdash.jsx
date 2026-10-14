// ============ Seller Dashboard: Product manager ============
// .C1 — Store Editor DELETED: a seller's profile IS their storefront.
// (Store name = username, avatar = profile avatar, uid = user uid.)

const BANNER_GRADIENTS = [
  'from-arc-primary via-arc-primarydk to-arc-surface',
  'from-cyan-600 via-blue-700 to-indigo-900',
  'from-emerald-600 via-teal-700 to-arc-surface',
  'from-rose-600 via-pink-700 to-rose-900',
  'from-amber-600 via-orange-700 to-rose-900',
  'from-arc-borderlt via-arc-surface2 to-arc-bg',
];
const PRODUCT_GLYPHS = ['💳', '◈', '▣', '◉', '✦', '⬡', '⛩', '✶', '🎮', '🎁'];

function stockCount(p) {
  if (p.delivery === 'instant') {
    // Accept BOTH shapes: /api/my/products returns SNAKE_CASE
    // (`variant_stocks` / `stock_items`) straight from the DB mapper, while
    // mock/demo fixtures and older call sites use camelCase. Reading only the
    // camelCase names made every seller see "0 STOCK" even with stock loaded.
    const vs = p.variantStock ?? p.variant_stocks;
    if (vs && Object.keys(vs).length > 0) {
      return Object.values(vs).reduce((a, b) => a + (b || 0), 0);
    }
    const items = p.stockItems ?? p.stock_items;
    return items ? items.length : 0;
  }
  return (p.stock || 0);
}

// ---------- Product Manager ----------
function ProductManager({ products, setProducts, notify }) {
  const [tab, setTab] = useState('active');
  const [addOpen, setAddOpen] = useState(false);
  const [restock, setRestock] = useState(null);
  // sellers had no way to fix a typo, change a price, or take a listing
  // down. Only status/restock/variants/image had routes.
  const [editProduct, setEditProduct] = useState(null);

  const counts = {
    active: products.filter(p => p.status === 'active').length,
    soldout: products.filter(p => p.status === 'soldout').length,
    inactive: products.filter(p => p.status === 'inactive').length,
  };
  const list = products.filter(p => p.status === tab);

  const setStatus = async (id, status) => {
    // Capture the previous status so we can roll back on failure.
    const prev = products.find(p => p.id === id);
    const prevStatus = prev ? prev.status : 'active';
    // Optimistic local update for instant UI feedback.
    setProducts(ps => ps.map(p => p.id === id ? { ...p, status } : p));
    try {
      const API = window.SLIME_API || '';
      const r = await fetch(API + '/api/my/products/' + id + '/status', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ status }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || ('HTTP ' + r.status)); }
      notify(tr('sel.statusUpdated','Product status updated → ') + status, 'info');
    } catch (e) {
      // Roll back the optimistic update so the UI matches the DB.
      setProducts(ps => ps.map(p => p.id === id ? { ...p, status: prevStatus } : p));
      notify('Status update failed: ' + e.message, 'error');
    }
  };
  // edit an existing listing (name/price/desc/category/delivery/…).
  const saveEdit = async (id, patch) => {
    const API = window.SLIME_API || '';
    const prev = products.find(p => p.id === id);
    setProducts(ps => ps.map(p => p.id === id ? { ...p, ...patch } : p)); // optimistic
    try {
      const r = await fetch(API + '/api/my/products/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      setEditProduct(null);
      notify(tr('sel.productUpdated','Product updated'), 'success');
      if (window.loadCatalog) window.loadCatalog();
    } catch (e) {
      // Roll back so the UI never shows an edit that did not persist.
      if (prev) setProducts(ps => ps.map(p => p.id === id ? prev : p));
      notify('Update failed: ' + e.message, 'error');
    }
  };

  // remove a listing. The server deactivates instead of deleting when
  // the product already has orders (history must stay intact).
  const removeProduct = async (p) => {
    if (!confirm(tr('sel.confirmDelete','Remove "') + p.name + tr('sel.confirmDelete2','" from your store?'))) return;
    const API = window.SLIME_API || '';
    const prev = products;
    setProducts(ps => ps.filter(x => x.id !== p.id)); // optimistic
    try {
      const r = await fetch(API + '/api/my/products/' + p.id, {
        method: 'DELETE', credentials: 'include',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      notify(d.deleted === false ? (d.reason || tr('sel.productDeactivated','Product deactivated'))
                                 : tr('sel.productDeleted','Product removed'), 'success');
      if (window.loadCatalog) window.loadCatalog();
    } catch (e) {
      setProducts(prev); // roll back
      notify('Remove failed: ' + e.message, 'error');
    }
  };

  const addProduct = async (prod) => {
    try {
      const API = window.SLIME_API || '';
      // Build the request body. When the seller defined multiple variants with
      // per-variant stock items (instant delivery), send `variants[].stockItems`
      // instead of the flat `stockItems` array — the backend (lib/catalog/products.ts)
      // routes per-variant stock into `product_stock_items` (migration 0037).
      const hasVariantStock = prod.delivery === 'instant' && Array.isArray(prod.variants)
        && prod.variants.some(v => Array.isArray(v.stockItems) && v.stockItems.length > 0);
      const body = {
        name: prod.name, category: prod.category, delivery: prod.delivery,
        price: prod.price, glyph: prod.glyph, gradient: prod.gradient, img: prod.img || null,
        desc: prod.desc, notes: prod.notes || '', warranty: prod.warranty || '',
        variants: Array.isArray(prod.variants)
          ? prod.variants.map(v => ({
              label: v.label,
              price: v.price,
              ...(Array.isArray(v.stockItems) && v.stockItems.length > 0 ? { stockItems: v.stockItems } : {}),
            }))
          : undefined,
      };
      if (hasVariantStock) {
        // per-variant stock path — do NOT send flat stockItems
      } else if (prod.stockItems) {
        body.stockItems = prod.stockItems;
      } else {
        body.stock = prod.stock || 0;
      }
      const res = await fetch(API + '/api/my/products', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      // Use the server-created product (has real id, seller embedded).
      setProducts(ps => [{ ...prod, ...data }, ...ps]);
      setAddOpen(false);
      notify(tr('sel.productPublished','Product published to your store: ') + prod.name, 'success');
      // Refresh the public catalog so storefront reflects the new item.
      if (window.loadCatalog) window.loadCatalog();
    } catch (e) {
      // Do NOT add the product locally — it was never persisted. Keep the modal
      // open so the seller can fix/retry; surface the real error.
      notify(tr('sel.publishFailed','Publish failed') + ' — ' + e.message, 'error');
    }
  };
  const doRestock = async (id, addItems, addNum, variantLabel) => {
    const API = window.SLIME_API || '';
    try {
      const body = addItems.length > 0
        ? { variantLabel: variantLabel || 'Default', items: addItems }
        : { variantLabel: variantLabel || 'Default', stockQty: addNum };
      const r = await fetch(API + '/api/my/products/' + id + '/restock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); notify('Restock failed: ' + (d.error || 'HTTP ' + r.status), 'error'); return; }
      setRestock(null);
      // Re-fetch authoritative product data from the backend. The local
      // variantStock/stockItems maps go stale after a restock (that's why
      // "Stock: 0" persisted and soldout status didn't reset). A fresh fetch
      // returns the real per-variant counts + updated status.
      if (typeof window.refreshMyProducts === 'function') {
        await window.refreshMyProducts();
      }
      notify(tr('sel.stockAdded','Stock added') + (variantLabel ? ' (' + variantLabel + ')' : ''), 'success');
    } catch (e) { notify('Restock failed: ' + e.message, 'error'); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 bg-arc-surface/60 ring-1 ring-arc-border rounded-xl p-1">
          {[['active', tr('sel.active','Active'), counts.active], ['soldout', tr('sel.soldOut','Sold Out'), counts.soldout], ['inactive', tr('sel.inactive','Inactive'), counts.inactive]].map(([id, label, n]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 text-sm font-medium rounded-lg px-3.5 py-2 transition ${tab === id ? 'bg-arc-primary text-white shadow-glow' : 'text-arc-muted hover:text-arc-text'}`}>
              {label} <span className={`text-[10px] rounded px-1.5 py-0.5 ${tab === id ? 'bg-white/20' : 'bg-arc-surface2'}`}>{n}</span>
            </button>
          ))}
        </div>
        <Btn variant="emerald" icon="plus" onClick={() => setAddOpen(true)}>{tr('sel.addProduct','Add Product')}</Btn>
      </div>

      <div className="space-y-2.5">
        {list.map(p => {
          const sc = stockCount(p);
          // Per-variant breakdown (only when the product actually has multiple
          // price variants, not just the synthesized "Default").
          const realVariants = Array.isArray(p.variants)
            ? p.variants.filter(v => !(p.variants.length === 1 && v.label === 'Default'))
            : [];
          return (
            <Card key={p.id} className="p-4">
              <div className="flex items-center gap-3.5 flex-wrap">
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${p.gradient} grid-noise flex items-center justify-center text-2xl shrink-0 bg-cover bg-center`} style={p.img ? { backgroundImage: `url(${p.img})` } : {}}>{!p.img && p.glyph}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-arc-text">{p.name}</span>
                    <DeliveryBadge type={p.delivery} est={15} />
                  </div>
                  <div className="text-[11px] text-arc-faint mt-1 flex items-center gap-2 flex-wrap">
                    <span className="text-arc-muted">{p.category}</span> ·
                    <span>{tr('sel.stock','Stock')}: <span className={sc > 0 ? 'text-emerald-400 font-medium' : 'text-rose-400 font-medium'}>{sc}</span></span> ·
                    <span>{p.sold} {tr('sel.sold','sold')}</span>
                  </div>
                  {realVariants.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {p.variants.map((v, i) => {
                        const vStock = p.delivery === 'instant'
                          ? (p.variantStock && p.variantStock[v.label] ? p.variantStock[v.label] : 0)
                          : (p.stock || 0);
                        return (
                          <span key={i} className={`inline-flex items-center gap-1.5 rounded-lg ring-1 px-2 py-1 text-[11px] font-mono ${vStock > 0 || p.delivery !== 'instant' ? 'ring-arc-border bg-arc-surface/60 text-arc-muted' : 'ring-rose-500/30 bg-rose-500/5 text-rose-400/80'}`}>
                            <span className="text-arc-text font-medium">{v.label}</span>
                            <span className="text-emerald-400">${(v.price || 0).toFixed(2)}</span>
                            {p.delivery === 'instant' && <span className={vStock > 0 ? 'text-arc-faint' : 'text-rose-400'}>· {vStock}</span>}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <Usdc value={p.price} className="text-emerald-400 font-bold shrink-0" />
                <div className="flex items-center gap-1.5 shrink-0 w-full sm:w-auto justify-end">
                  <Btn size="sm" variant="outline" icon="pencil" onClick={() => setEditProduct(p)}>{tr('sel.edit','Edit')}</Btn>
                  <Btn size="sm" variant="outline" icon="package-plus" onClick={() => setRestock(p)}>{tr('sel.restock','Restock')}</Btn>
                  {p.status !== 'soldout' && <Btn size="sm" variant="subtle" icon="package-x" onClick={() => setStatus(p.id, 'soldout')}>{tr('sel.soldOut','Sold Out')}</Btn>}
                  {p.status === 'inactive'
                    ? <Btn size="sm" variant="emerald" icon="eye" onClick={() => setStatus(p.id, sc > 0 ? 'active' : 'soldout')}>{tr('sel.activate','Activate')}</Btn>
                    : <Btn size="sm" variant="ghost" icon="eye-off" onClick={() => setStatus(p.id, 'inactive')}>{tr('sel.deactivate','Deactivate')}</Btn>}
                  <Btn size="sm" variant="danger" icon="trash-2" onClick={() => removeProduct(p)}>{tr('sel.remove','Remove')}</Btn>
                </div>
              </div>
            </Card>
          );
        })}
        {list.length === 0 && (
          <Card className="py-14 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-arc-surface2 flex items-center justify-center"><Icon name="package-open" size={22} className="text-arc-faint" /></div>
            <div className="text-sm text-arc-muted">{tr('sel.noProductsTab','No products in this tab.')}</div>
            {tab === 'active' && <Btn variant="emerald" icon="plus" onClick={() => setAddOpen(true)}>{tr('sel.addFirstProduct','Add Your First Product')}</Btn>}
          </Card>
        )}
      </div>

      <AddProductModal open={addOpen} onClose={() => setAddOpen(false)} onAdd={addProduct} />
      <EditProductModal product={editProduct} onClose={() => setEditProduct(null)} onSave={saveEdit} />
      <RestockModal product={restock} onClose={() => setRestock(null)} onRestock={doRestock} />
    </div>
  );
}

// ---------- Edit Product modal ----------
// Only the fields the PATCH route accepts. Variants/stock keep their own flows
// (variants editor, Restock) so this modal stays predictable.
function EditProductModal({ product, onClose, onSave }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState(SELLER_CATEGORIES[0]);
  const [delivery, setDelivery] = useState('instant');
  const [price, setPrice] = useState('');
  const [desc, setDesc] = useState('');
  const [warranty, setWarranty] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!product) return;
    setName(product.name || '');
    setCategory(product.category || SELLER_CATEGORIES[0]);
    setDelivery(product.delivery || 'instant');
    setPrice(String(product.price ?? ''));
    setDesc(product.desc || '');
    setWarranty(product.warranty || '');
    setNotes(product.notes || '');
    setErr('');
    setBusy(false);
  }, [product]);

  if (!product) return null;

  const submit = async () => {
    if (!name.trim()) { setErr('Name is required'); return; }
    if (!(parseFloat(price) > 0)) { setErr('Price must be greater than 0'); return; }
    if (desc.trim().length < 10) { setErr('Description must be at least 10 characters'); return; }
    setBusy(true); setErr('');
    await onSave(product.id, {
      name: name.trim(), category, delivery,
      price: parseFloat(price), desc, warranty, notes,
    });
    setBusy(false);
  };

  const inputCls = 'mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition';

  return (
    <Modal open={!!product} onClose={onClose} width="max-w-lg">
      <Card className="p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center"><Icon name="pencil" size={18} className="text-emerald-300" /></div>
          <div>
            <div className="font-semibold text-arc-text">{tr('sel.editProduct','Edit Product')}</div>
            <div className="text-[12px] text-arc-muted">{product.name}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm text-arc-muted">{tr('sel.name','Name')}</label>
            <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.price','Price (USDC)')}</label>
              <input value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} className={inputCls + ' font-mono'} />
              {parseFloat(price) > 0 && (
                <div className="mt-2 rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/25 px-3 py-2 text-[11px] text-emerald-200">
                  {tr('sel.youReceive','You receive')} <b className="font-mono">${(parseFloat(price) * 0.98).toFixed(2)}</b> {tr('sel.perItem','per item')}
                </div>
              )}
            </div>
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.deliveryType','Delivery Type')}</label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[['instant', tr('c.instant','Instant')], ['manual', tr('c.manual','Manual')]].map(([id, lbl]) => (
                  <button key={id} onClick={() => setDelivery(id)}
                    className={`h-11 rounded-xl text-sm font-medium transition ring-1 ${delivery === id ? 'ring-emerald-500 bg-emerald-500/10 text-emerald-200' : 'ring-arc-border bg-arc-surface/60 text-arc-muted'}`}>{lbl}</button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="text-sm text-arc-muted">{tr('sel.category','Category')}</label>
            <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls}>
              {SELLER_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-arc-muted">{tr('sel.description','Description')}</label>
            <textarea rows={3} value={desc} onChange={e => setDesc(e.target.value)} className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text outline-none resize-none transition"></textarea>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.warranty','Warranty')}</label>
              <input value={warranty} onChange={e => setWarranty(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.usageNotes','Usage Notes')}</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
            </div>
          </div>
          {err && <div className="text-sm text-rose-400">{err}</div>}
          <div className="flex gap-2">
            <Btn variant="ghost" full onClick={onClose}>{tr('c.cancel','Cancel')}</Btn>
            <Btn variant="emerald" full icon="check" disabled={busy} onClick={submit}>{busy ? tr('sel.saving','Saving…') : tr('sel.saveChanges','Save Changes')}</Btn>
          </div>
        </div>
      </Card>
    </Modal>
  );
}

// ---------- Add Product modal ----------
function AddProductModal({ open, onClose, onAdd }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState(SELLER_CATEGORIES[0]);
  const [delivery, setDelivery] = useState('instant');
  const [price, setPrice] = useState('');
  const [glyph, setGlyph] = useState(PRODUCT_GLYPHS[0]);
  const [gradient, setGradient] = useState(BANNER_GRADIENTS[0]);
  const [img, setImg] = useState(null);
  const [desc, setDesc] = useState('');
  const [notes, setNotes] = useState('');
  const [warranty, setWarranty] = useState('');
  const [items, setItems] = useState('');
  const [stockNum, setStockNum] = useState('');
  const [variants, setVariants] = useState([{ label: 'Default', price: '', stockItems: '' }]);
  useEffect(() => { if (open) { setName(''); setCategory(SELLER_CATEGORIES[0]); setDelivery('instant'); setPrice(''); setGlyph(PRODUCT_GLYPHS[0]); setGradient(BANNER_GRADIENTS[0]); setImg(null); setDesc(''); setNotes(''); setWarranty(''); setItems(''); setStockNum(''); setVariants([{ label: 'Default', price: '', stockItems: '' }]); } }, [open]);

  const itemLines = items.split('\n').map(s => s.trim()).filter(Boolean);
  // Per-variant stock lines (only used when the seller has 2+ variants and
  // delivery is instant). Each variant row carries its own stockItems textarea.
  const hasMultiVariants = variants.length > 1;
  const usePerVariantStock = delivery === 'instant' && hasMultiVariants;
  const variantStockCounts = variants.map(v => {
    const lines = (v.stockItems || '').split('\n').map(s => s.trim()).filter(Boolean);
    return lines.length;
  });
  const totalVariantStock = variantStockCounts.reduce((a, b) => a + b, 0);
  const flatStock = delivery === 'instant' ? itemLines.length : (parseInt(stockNum) || 0);
  const stock = usePerVariantStock ? totalVariantStock : flatStock;
  const valid = name.trim() && desc.trim().length >= 10 && (parseFloat(price) > 0) && stock > 0;

  const submit = () => {
    const parsedVariants = variants.map(v => ({ label: v.label.trim() || 'Default', price: v.price ? parseFloat(v.price) : parseFloat(price) }));
    const prod = {
      id: 'mp' + Date.now(), name: name.trim(), category, delivery, price: parseFloat(price),
      glyph, gradient, img, desc: desc.trim(), notes: notes.trim(), warranty: warranty.trim(), status: 'active', sold: 0, views: 0,
      // Stock: per-variant stockItems when multi-variant + instant; otherwise
      // the legacy flat stockItems (instant) or stock number (manual).
      ...(usePerVariantStock
        ? { stockItems: [], variants: parsedVariants.map((v, i) => ({ ...v, stockItems: (variants[i].stockItems || '').split('\n').map(s => s.trim()).filter(Boolean) })) }
        : { ...(delivery === 'instant' ? { stockItems: itemLines } : { stock: parseInt(stockNum) || 0 }), variants: parsedVariants }),
      variantStock: usePerVariantStock
        ? parsedVariants.reduce((m, v, i) => { m[v.label] = variantStockCounts[i]; return m; }, {})
        : (delivery === 'instant' ? { Default: itemLines.length } : {}),
    };
    onAdd(prod);
  };

  return (
    <Modal open={open} onClose={onClose} width="max-w-lg">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center text-emerald-300"><Icon name="package-plus" size={18} /></div>
          <div>
            <div className="font-semibold text-arc-text">{tr('sel.addProduct','Add Product')}</div>
            <div className="text-xs text-arc-muted">{tr('sel.listNewProduct','List a new product in your store')}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* product image */}
          <div>
            <label className="text-sm text-arc-muted mb-2 block">{tr('sel.productImage','Product Image')}</label>
            <ImageUpload value={img} onChange={setImg} height={130} gradient={gradient} glyph={glyph} recommend={tr('sel.productImageRec','800×600px (4:3), max 2MB · PNG/JPG')} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.productName','Product Name')}</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('sel.productNamePh','e.g. VCC Wise Australia')} className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
            </div>
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.category','Category')}</label>
              <select value={category} onChange={e => setCategory(e.target.value)} className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text outline-none transition">
                {SELLER_CATEGORIES.map(c => <option key={c} value={c} className="bg-arc-surface">{c}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.price','Price (USDC)')}</label>
              <input value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
              {/* show the seller's NET before they publish. The platform
                  takes 2% on completed sales, so the price they type is not the
                  amount that lands in their wallet. */}
              {parseFloat(price) > 0 && (
                <div className="mt-2 rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/25 px-3 py-2 text-[11px] leading-relaxed">
                  <div className="text-emerald-200">
                    {tr('sel.youReceive','You receive')} <b className="font-mono">${(parseFloat(price) * 0.98).toFixed(2)}</b> {tr('sel.perItem','per item')}
                  </div>
                  <div className="text-arc-faint mt-0.5">
                    {tr('sel.afterFee2','after the 2% platform fee')} (${(parseFloat(price) * 0.02).toFixed(2)} {tr('sel.perSale','per sale')})
                  </div>
                </div>
              )}
            </div>
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.deliveryType','Delivery Type')}</label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[['instant', 'zap', tr('c.instant','Instant')], ['manual', 'clock', tr('c.manual','Manual')]].map(([id, ic, lbl]) => (
                  <button key={id} onClick={() => setDelivery(id)}
                    className={`inline-flex items-center justify-center gap-1.5 h-11 rounded-xl text-sm font-medium transition ring-1 ${delivery === id ? 'ring-emerald-500 bg-emerald-500/10 text-emerald-200' : 'ring-arc-border bg-arc-surface/60 text-arc-muted hover:ring-arc-borderlt'}`}>
                    <Icon name={ic} size={15} /> {lbl}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* description (required) */}
          <div>
            <label className="text-sm text-arc-muted flex items-center gap-2">{tr('sel.description','Description')} <span className="text-rose-400">*</span></label>
            <textarea rows={3} value={desc} onChange={e => setDesc(e.target.value)} placeholder={tr('sel.descPh','Describe the product: contents, region, warranty, terms… (required, min 10 characters)')}
              className={`mt-2 w-full bg-arc-bg/60 ring-1 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none transition ${desc.trim().length > 0 && desc.trim().length < 10 ? 'ring-rose-500/50 focus:ring-rose-500/50' : 'ring-arc-border focus:ring-emerald-500/50'}`}></textarea>
            <div className="text-[11px] text-arc-faint mt-1.5">{desc.trim().length < 10 ? <span className="text-rose-400/80">{tr('sel.descRequired','Required before publishing (min 10 characters).')}</span> : <span className="text-emerald-400">✓ {desc.trim().length} {tr('sel.characters','characters')}</span>}</div>
          </div>

          {/* warranty */}
          <div>
            <label className="text-sm text-arc-muted">{tr('sel.warranty','Warranty')}</label>
            <input value={warranty} onChange={e => setWarranty(e.target.value)} placeholder="e.g., Login warranty, 1 day, 30 days, no warranty" className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
          </div>

          {/* usage notes */}
          <div>
            <label className="text-sm text-arc-muted flex items-center gap-2">{tr('sel.usageNotes','Usage Notes')} <span className="text-[11px] text-arc-faint">{tr('sel.usageNotesSub','optional · sent to buyer')}</span></label>
            <textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)} placeholder={"username/email, password, 2FA auth key, recovery code, or other access details"}
              className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none transition"></textarea>
            <div className="text-[11px] text-arc-faint mt-1.5 flex items-center gap-1.5"><Icon name="info" size={11} className="text-arc-accent" /> {tr('sel.usageNotesHint',"Great for instant selling — appears in the buyer's order info after payment.")}</div>
          </div>

          {/* variants */}
          <div>
            <label className="text-sm text-arc-muted flex items-center gap-2">{tr('sel.variants','Variants')} <span className="text-[11px] text-arc-faint">{tr('sel.variantsSub','optional · set price per option (falls back to base price)')}</span></label>
            <div className="mt-2 space-y-2">
              {variants.map((v, i) => (
                <div key={i} className="space-y-2 rounded-xl ring-1 ring-arc-border bg-arc-surface/40 p-2.5">
                  <div className="flex items-center gap-2">
                    <input value={v.label} onChange={e => setVariants(vs => vs.map((vv, j) => j === i ? { ...vv, label: e.target.value } : vv))} placeholder={i === 0 ? 'Default' : 'e.g. 1 month, 30 days'}
                      className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
                    <input value={v.price} onChange={e => setVariants(vs => vs.map((vv, j) => j === i ? { ...vv, price: e.target.value.replace(/[^0-9.]/g, '') } : vv))}
                      placeholder={tr('sel.variantPricePh','Price (USDC)')} aria-label={tr('sel.variantPriceAria','Price for this variant in USDC — leave empty to use base price')}
                      className="w-36 shrink-0 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
                    <button onClick={() => setVariants(vs => vs.filter((_, j) => j !== i))} disabled={variants.length <= 1}
                      className="shrink-0 h-11 px-3 rounded-xl ring-1 ring-arc-border bg-arc-surface/60 text-xs text-arc-muted hover:text-rose-400 hover:ring-rose-500/50 disabled:opacity-40 disabled:cursor-not-allowed transition">{tr('c.remove','Remove')}</button>
                  </div>
                  {/* Per-variant stock items: only shown for instant delivery with 2+ variants. */}
                  {usePerVariantStock && (
                    <div>
                      <textarea rows={3} value={v.stockItems || ''} onChange={e => setVariants(vs => vs.map((vv, j) => j === i ? { ...vv, stockItems: e.target.value } : vv))} placeholder={`Stock for "${v.label || 'Default'}" — 1 line = 1 item`}
                        className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none font-mono leading-[1.45] transition"></textarea>
                      <div className="text-[10px] text-arc-faint mt-1 flex items-center gap-1.5"><Icon name="boxes" size={10} className="text-emerald-400" /> {tr('sel.stockDetected','Detected stock:')} <span className="font-semibold text-emerald-300">{variantStockCounts[i]}</span></div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button onClick={() => setVariants(vs => [...vs, { label: '', price: '', stockItems: '' }])} className="mt-2.5 inline-flex items-center gap-1.5 text-sm text-emerald-400 hover:brightness-125 transition"><Icon name="plus" size={15} /> {tr('sel.addVariant','Add Variant')}</button>
            {usePerVariantStock && <div className="text-[11px] text-arc-faint mt-1.5 flex items-center gap-1.5"><Icon name="info" size={11} className="text-arc-accent" /> {tr('sel.perVariantStockNote','Each variant has its own stock pool. Total stock:')} <span className="font-semibold text-emerald-300">{totalVariantStock}</span></div>}
          </div>

          {/* stock — only shown when NOT using per-variant stock (single-variant path) */}
          {!usePerVariantStock && (delivery === 'instant' ? (
            <div>
              <label className="text-sm text-arc-muted flex items-center gap-2">{tr('sel.instantStock','Instant Stock')} <span className="text-[11px] text-arc-faint">{tr('sel.instantStockSub','1 line = 1 account/code, delivered automatically in order')}</span></label>
              <div className="mt-2 flex gap-2">
                {/* line numbers */}
                <div className="shrink-0 w-9 bg-arc-bg/60 ring-1 ring-arc-border rounded-xl py-2.5 px-1 text-right font-mono text-[11px] text-arc-faint leading-[1.45] overflow-hidden select-none" style={{ minHeight: 132 }}>
                  {(itemLines.length > 0 ? itemLines : ['']).map((_, i) => <div key={i}>{i + 1}</div>)}
                </div>
                <textarea rows={6} value={items} onChange={e => setItems(e.target.value)} placeholder={"account@email.com password 2fa-key\naccount2@email.com password 2fa-key\n…"}
                  className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none font-mono leading-[1.45] transition"></textarea>
              </div>
              <div className="text-[11px] text-arc-faint mt-1.5 flex items-center gap-1.5"><Icon name="boxes" size={12} className="text-emerald-400" /> {tr('sel.stockDetected','Detected stock:')} <span className="font-semibold text-emerald-300">{itemLines.length} {tr('sel.item','item')}</span> · {tr('sel.stockOrderNote','number on the left = delivery order')}</div>
            </div>
          ) : (
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.manualStock','Stock Quantity (manual)')}</label>
              <input value={stockNum} onChange={e => setStockNum(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
              <div className="text-[11px] text-arc-faint mt-1.5">{tr('sel.manualStockNote','Manual orders are processed and delivered by the seller after payment.')}</div>
            </div>
          ))}

          <div className="flex gap-3 pt-1">
            <Btn variant="ghost" full onClick={onClose}>{tr('c.cancel','Cancel')}</Btn>
            <Btn variant="emerald" full icon="check" disabled={!valid} onClick={submit}>{tr('sel.publishProduct','Publish Product')}</Btn>
          </div>
          {!valid && (name.trim() || price || desc) && <div className="text-[11px] text-rose-400/80 text-center -mt-1">{tr('sel.fillAll','Complete name, description (min 10), price > 0, and at least 1 stock.')}</div>}
        </div>
      </Card>
    </Modal>
  );
}

// ---------- Restock modal ----------
function RestockModal({ product, onClose, onRestock }) {
  const [items, setItems] = useState('');
  const [num, setNum] = useState('');
  const [selVariant, setSelVariant] = useState('Default');
  const [editVariants, setEditVariants] = useState(false);
  const [newVariants, setNewVariants] = useState([]);
  const [savingVariants, setSavingVariants] = useState(false);
  useEffect(() => {
    if (product) {
      setItems(''); setNum('');
      const variants = (product.variants || []).map(v => v.label || 'Default');
      setSelVariant(variants[0] || 'Default');
      setNewVariants(variants.map((label, i) => ({ label, price: String(product.variants[i]?.price || product.price || 0) })));
      setEditVariants(false);
    }
  }, [product]);
  if (!product) return null;
  const instant = product.delivery === 'instant';
  const lines = items.split('\n').map(s => s.trim()).filter(Boolean);
  const valid = instant ? lines.length > 0 : (parseInt(num) || 0) > 0;
  const variants = (product.variants || []).map(v => v.label || 'Default');
  const hasVariants = variants.length > 1;

  const saveVariants = async () => {
    const API = window.SLIME_API || '';
    setSavingVariants(true);
    try {
      const r = await fetch(API + '/api/my/products/' + product.id + '/variants', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ variants: newVariants }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); notify && notify('Failed: ' + (d.error || 'HTTP ' + r.status), 'error'); return; }
      notify && notify('Variants updated', 'success');
      setEditVariants(false);
      // Update local product
      // (The parent ProductManager will re-fetch or we can update in place)
    } catch (e) { notify && notify('Failed: ' + e.message, 'error'); }
    setSavingVariants(false);
  };

  return (
    <Modal open={!!product} onClose={onClose} width="max-w-md">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${product.gradient} grid-noise flex items-center justify-center text-xl`}>{product.glyph}</div>
          <div>
            <div className="font-semibold text-arc-text">{tr('sel.restock','Restock')} — {product.name}</div>
            <div className="text-xs text-arc-muted">{tr('sel.currentStock','Current stock:')} {stockCount(product)}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* Variant selector */}
          {hasVariants && !editVariants && (
            <div>
              <label className="text-sm text-arc-muted">Variant</label>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {variants.map(v => (
                  <button key={v} onClick={() => setSelVariant(v)}
                    className={`text-xs font-medium rounded-lg px-3 py-2 transition ${selVariant === v ? 'bg-arc-primary/20 text-arc-accent ring-1 ring-arc-primary' : 'bg-arc-surface2 text-arc-muted ring-1 ring-arc-border hover:ring-arc-borderlt'}`}>{v}</button>
                ))}
                <button onClick={() => setEditVariants(true)} className="text-xs text-arc-accent hover:brightness-125 ml-auto inline-flex items-center gap-1"><Icon name="pencil" size={12} /> Edit Variants</button>
              </div>
            </div>
          )}
          {/* No variants — show edit button */}
          {!hasVariants && !editVariants && (
            <button onClick={() => { setEditVariants(true); setNewVariants([{ label: 'Default', price: String(product.price || 0) }]); }} className="text-xs text-arc-accent hover:brightness-125 inline-flex items-center gap-1"><Icon name="plus" size={12} /> Add Variants</button>
          )}
          {/* Edit variants */}
          {editVariants && (
            <div className="space-y-2">
              <label className="text-sm text-arc-muted">Edit Variants</label>
              {newVariants.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={v.label} onChange={e => setNewVariants(vs => vs.map((vv, j) => j === i ? { ...vv, label: e.target.value } : vv))} placeholder="Variant name"
                    className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none" />
                  <input value={v.price} onChange={e => setNewVariants(vs => vs.map((vv, j) => j === i ? { ...vv, price: e.target.value.replace(/[^0-9.]/g, '') } : vv))} placeholder="Price"
                    className="w-24 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none font-mono" />
                  <button onClick={() => setNewVariants(vs => vs.filter((_, j) => j !== i))} disabled={newVariants.length <= 1}
                    className="shrink-0 h-10 px-2 rounded-lg ring-1 ring-arc-border bg-arc-surface/60 text-xs text-arc-muted hover:text-rose-400 disabled:opacity-40">✕</button>
                </div>
              ))}
              <button onClick={() => setNewVariants(vs => [...vs, { label: '', price: '' }])} className="text-xs text-emerald-400 hover:brightness-125 inline-flex items-center gap-1"><Icon name="plus" size={12} /> Add Variant</button>
              <div className="flex gap-2 mt-2">
                <Btn variant="ghost" size="sm" onClick={() => setEditVariants(false)}>Cancel</Btn>
                <Btn variant="emerald" size="sm" icon="check" disabled={savingVariants} onClick={saveVariants}>{savingVariants ? 'Saving...' : 'Save Variants'}</Btn>
              </div>
            </div>
          )}
          {/* Restock input */}
          {!editVariants && (instant ? (
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.addItems','Add Items (1 line = 1 item)')}{hasVariants ? ' — ' + selVariant : ''}</label>
              <textarea rows={5} value={items} onChange={e => setItems(e.target.value)} placeholder={tr('sel.pasteItems','Paste new items here…')}
                className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none font-mono transition"></textarea>
              <div className="text-[11px] text-arc-faint mt-1.5">{tr('sel.willAdd','Will add:')} <span className="font-semibold text-emerald-300">{lines.length} {tr('sel.item','item')}</span>{hasVariants ? ' to ' + selVariant : ''}</div>
            </div>
          ) : (
            <div>
              <label className="text-sm text-arc-muted">{tr('sel.addStockQty','Add Stock Quantity')}</label>
              <input value={num} onChange={e => setNum(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
            </div>
          ))}
          {!editVariants && (
            <div className="flex gap-3">
              <Btn variant="ghost" full onClick={onClose}>{tr('c.cancel','Cancel')}</Btn>
              <Btn variant="emerald" full icon="package-plus" disabled={!valid} onClick={() => onRestock(product.id, lines, parseInt(num) || 0, hasVariants ? selVariant : 'Default')}>{tr('sel.addStock','Add Stock')}</Btn>
            </div>
          )}
        </div>
      </Card>
    </Modal>
  );
}

// ---------- Apply as Seller modal ----------
function ApplySellerModal({ open, onClose, onSubmit }) {
  const [category, setCategory] = useState(SELLER_CATEGORIES[0]);
  const [pitch, setPitch] = useState('');
  const [contact, setContact] = useState('');
  const [agree, setAgree] = useState(false);
  useEffect(() => { if (open) { setCategory(SELLER_CATEGORIES[0]); setPitch(''); setContact(''); setAgree(false); } }, [open]);
  const valid = pitch.trim() && contact.trim() && agree;
  return (
    <Modal open={open} onClose={onClose} width="max-w-lg">
      <Card className="overflow-hidden">
        <div className="relative h-20 bg-gradient-to-r from-emerald-600 via-teal-700 to-arc-primary grid-noise scanlines">
          <button onClick={onClose} className="absolute top-3 right-3 w-8 h-8 rounded-lg bg-arc-bg/40 hover:bg-arc-bg/70 text-white flex items-center justify-center transition"><Icon name="x" size={16} /></button>
          <div className="absolute bottom-3 left-5 flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center backdrop-blur"><Icon name="store" size={18} className="text-white" /></div>
            <div>
              <Pixel className="text-white/80 text-[8px]">{tr('sel.becomeSeller','BECOME A SELLER')}</Pixel>
              <div className="font-semibold text-white text-sm mt-0.5">{tr('sel.applyAsSeller','Apply as Seller')}</div>
            </div>
          </div>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="flex items-start gap-2 rounded-xl ring-1 ring-amber-500/25 bg-amber-500/5 px-3.5 py-3">
            <Icon name="shield-alert" size={15} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="text-xs text-arc-muted">{tr('sel.applyNote1','Not everyone can become a seller instantly — applications are ')}<span className="font-medium text-arc-text">{tr('sel.applyNoteHl','manually reviewed')}</span>{tr('sel.applyNote2',' by admins (±1×24h) to keep the marketplace high quality.')}</div>
          </div>
          {/* .C1 — no store name input: approval turns your PROFILE into your storefront */}
          <div className="flex items-start gap-2.5 rounded-xl ring-1 ring-emerald-500/25 bg-emerald-500/5 px-3.5 py-3">
            <Icon name="user-round" size={15} className="text-emerald-400 mt-0.5 shrink-0" />
            <div className="text-xs text-arc-muted">{tr('sel.applyNote','Approval turns your profile into your storefront')} — <span className="font-medium text-arc-text">{tr('store.profileStorefront','Profile = storefront')}</span></div>
          </div>
          <div>
            <label className="text-sm text-arc-muted">{tr('sel.mainCategory','Main Category')}</label>
            <select value={category} onChange={e => setCategory(e.target.value)} className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text outline-none transition">
              {SELLER_CATEGORIES.map(c => <option key={c} value={c} className="bg-arc-surface">{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-arc-muted">{tr('sel.contact','Contact (Telegram/Discord)')}</label>
            <input value={contact} onChange={e => setContact(e.target.value)} placeholder="@username" className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
          </div>
          <div>
            <label className="text-sm text-arc-muted">{tr('sel.pitchLabel','Tell us what products/services you will sell')}</label>
            <textarea rows={3} value={pitch} onChange={e => setPitch(e.target.value)} placeholder={tr('sel.pitchPh','e.g. VCC, premium accounts, game top-ups…')}
              className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none transition"></textarea>
          </div>
          <button onClick={() => setAgree(a => !a)} className="flex items-start gap-2.5 text-left">
            <span className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5 transition ${agree ? 'bg-emerald-500 text-emerald-950' : 'bg-arc-surface2 ring-1 ring-arc-borderlt'}`}>{agree && <Icon name="check" size={13} />}</span>
            <span className="text-xs text-arc-muted">{tr('sel.agreeTerms','I agree to follow SlimeMarket seller rules: no scam, escrow guarantee, and 2% platform fee per transaction.')}</span>
          </button>
          <div className="flex gap-3 pt-1">
            <Btn variant="ghost" full onClick={onClose}>{tr('c.cancel','Cancel')}</Btn>
            <Btn variant="emerald" full icon="send" disabled={!valid} onClick={() => onSubmit({ category })}>{tr('sel.submitApplication','Submit Application')}</Btn>
          </div>
        </div>
      </Card>
    </Modal>
  );
}

Object.assign(window, { ProductManager, AddProductModal, RestockModal, ApplySellerModal, stockCount });
