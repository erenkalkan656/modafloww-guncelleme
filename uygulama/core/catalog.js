'use strict';
const { detectSize, compareSizes } = require('./sizes');
const { chunk, nowIso } = require('./util');

const PAGE_SIZE = 100; // V2 onaylı ürün servisinde sayfa başına en fazla 100
const PAGE_WINDOW = 10000; // page*size en fazla 10.000; sonrası nextPageToken ile

/**
 * Sayfalı bir V2 servisini sonuna kadar dolaşır.
 * İlk 10.000 kayıt page/size ile, sonrası nextPageToken ile alınır.
 */
async function fetchAllPages(fetchPage, { size = PAGE_SIZE, onPage, shouldStop } = {}) {
  const all = [];
  let page = 0;
  let token = null;
  let total = null;
  for (let guard = 0; guard < 5000; guard++) {
    if (shouldStop && shouldStop()) throw new Error('İşlem iptal edildi');
    const params = token ? { size, nextPageToken: token } : { page, size };
    const res = await fetchPage(params);
    const content = (res && Array.isArray(res.content)) ? res.content : null;
    if (!content) throw new Error('Trendyol yanıtında "content" alanı yok veya geçersiz');
    if (total == null && Number.isFinite(res.totalElements)) total = res.totalElements;
    all.push(...content);
    if (onPage) onPage({ fetched: all.length, total });
    if (content.length === 0) break;
    if (total != null && all.length >= total) break;
    const nextIndexEnd = (page + 2) * size;
    if (token || nextIndexEnd > PAGE_WINDOW) {
      if (!res.nextPageToken || res.nextPageToken === token) break;
      token = res.nextPageToken;
    } else {
      page++;
      if (Number.isFinite(res.totalPages) && page >= res.totalPages) break;
    }
  }
  return { items: all, total };
}

function attrValue(attrs, names) {
  if (!Array.isArray(attrs)) return null;
  const set = names.map((n) => n.toLocaleLowerCase('tr-TR'));
  const a = attrs.find((x) => x && x.attributeName && set.includes(String(x.attributeName).toLocaleLowerCase('tr-TR')));
  return a ? (a.attributeValue != null ? String(a.attributeValue) : null) : null;
}

function variantStatus(v) {
  if (v.blacklisted) return 'blacklisted';
  if (v.archived) return 'archived';
  if (v.locked) return 'locked';
  return v.onSale ? 'onSale' : 'notOnSale';
}

/**
 * Onaylı ürünler + stok/fiyat yanıtlarını tek bir varyant listesinde birleştirir.
 * Anahtar: barkod. Aynı barkod birden fazla içerikte görünürse "conflict" işaretlenir
 * ve toplu işlemlerden otomatik olarak çıkarılır.
 */
function mergeCatalog(contents, inventoryContents) {
  const inv = new Map();
  for (const c of inventoryContents || []) {
    for (const v of c.variants || []) {
      if (v && v.barcode) inv.set(String(v.barcode), { ...v, contentId: c.contentId });
    }
  }
  const byBarcode = new Map();
  const conflicts = [];
  const contentMap = {};
  for (const c of contents || []) {
    const images = Array.isArray(c.images) ? c.images : [];
    const contentColor = attrValue(c.attributes, ['Renk', 'Web Color']);
    if (c.contentId != null) {
      contentMap[c.contentId] = {
        contentId: c.contentId, productMainId: c.productMainId || null, title: c.title || '', description: c.description || '',
        brandId: c.brand ? c.brand.id ?? null : null, brand: c.brand ? c.brand.name : null,
        categoryId: c.category ? c.category.id : null, category: c.category ? c.category.name : null,
        images: images.map((i) => i.url).filter(Boolean),
        attributes: (c.attributes || []).map((a) => ({ attributeId: a.attributeId, attributeName: a.attributeName, attributeValueId: a.attributeValueId ?? null, attributeValue: a.attributeValue ?? null })),
        creationDate: c.creationDate || null, lastModifiedDate: c.lastModifiedDate || null,
      };
    }
    for (const v of c.variants || []) {
      if (!v || !v.barcode) continue;
      const barcode = String(v.barcode);
      const s = detectSize(v, c);
      const iv = inv.get(barcode);
      const price = v.price || {};
      const stock = v.stock || {};
      const row = {
        barcode,
        variantId: v.variantId ?? null,
        contentId: c.contentId ?? null,
        productMainId: c.productMainId ?? null,
        title: c.title || '',
        brand: c.brand ? c.brand.name : null,
        categoryId: c.category ? c.category.id : null,
        category: c.category ? c.category.name : null,
        image: images[0] ? images[0].url : null,
        stockCode: v.stockCode || (iv && iv.stockCode) || null,
        size: s.size,
        sizeRaw: s.raw,
        sizeSource: s.source,
        color: attrValue(v.attributes, ['Renk']) || contentColor,
        salePrice: iv && Number.isFinite(iv.salePrice) ? iv.salePrice : (Number.isFinite(price.salePrice) ? price.salePrice : null),
        listPrice: iv && Number.isFinite(iv.listPrice) ? iv.listPrice : (Number.isFinite(price.listPrice) ? price.listPrice : null),
        quantity: iv && Number.isFinite(iv.quantity) ? iv.quantity : (Number.isFinite(stock.quantity) ? stock.quantity : null),
        priceSource: iv ? 'inventory' : 'product',
        onSale: !!v.onSale,
        locked: !!v.locked,
        archived: !!v.archived,
        blacklisted: !!v.blacklisted,
        status: variantStatus(v),
        productUrl: v.productUrl || null,
        vatRate: v.vatRate ?? null,
        brandId: c.brand ? c.brand.id ?? null : null,
        origin: v.origin || null,
        deliveryDuration: v.deliveryOption && Number.isFinite(v.deliveryOption.deliveryDuration) ? v.deliveryOption.deliveryDuration : null,
        // Ürün oluşturma/kopyalama için varyant niteliklerinin kimlikleri saklanır
        variantAttributes: (v.attributes || []).map((a) => ({ attributeId: a.attributeId, attributeName: a.attributeName, attributeValueId: a.attributeValueId ?? null, attributeValue: a.attributeValue ?? null })),
        commission: Number.isFinite(v.commission) ? v.commission : null,
        createdAt: v.sellerCreatedDate || c.creationDate || null,
        modifiedAt: v.sellerModifiedDate || c.lastModifiedDate || null,
        stockModifiedAt: (iv && iv.stockLastModifiedDate) || stock.lastModifiedDate || null,
        conflict: false,
      };
      if (byBarcode.has(barcode)) {
        const prev = byBarcode.get(barcode);
        if (prev.contentId !== row.contentId || prev.variantId !== row.variantId) {
          prev.conflict = true;
          row.conflict = true;
          conflicts.push({ barcode, contentIds: [prev.contentId, row.contentId] });
          byBarcode.set(barcode + '#' + row.contentId, row);
        }
        continue;
      }
      byBarcode.set(barcode, row);
    }
  }
  const variants = [...byBarcode.values()];
  variants.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'tr') || compareSizes(a.size, b.size));
  return { variants, conflicts, contents: contentMap };
}

function summarize(variants) {
  const contents = new Set();
  const sizes = {};
  let onSale = 0, inStock = 0, outOfStock = 0, locked = 0, archived = 0, noSize = 0;
  for (const v of variants) {
    contents.add(v.contentId);
    if (v.status === 'onSale') onSale++;
    if (v.locked) locked++;
    if (v.archived) archived++;
    if (Number(v.quantity) > 0) inStock++;
    else if (v.quantity === 0) outOfStock++;
    if (v.size) sizes[v.size] = (sizes[v.size] || 0) + 1;
    else noSize++;
  }
  return { products: contents.size, variants: variants.length, onSale, inStock, outOfStock, locked, archived, noSize, sizes };
}

/**
 * Tam ürün senkronizasyonu. Başarısız olursa eski katalog korunur.
 */
async function syncCatalog(client, store, { onProgress, shouldStop } = {}) {
  const startedAt = nowIso();
  const progress = (stage, info) => onProgress && onProgress({ stage, ...info });
  progress('products', { fetched: 0, total: null });
  const products = await fetchAllPages((p) => client.getApprovedProducts(p), {
    onPage: (i) => progress('products', i), shouldStop,
  });
  progress('inventory', { fetched: 0, total: null });
  const inventory = await fetchAllPages((p) => client.getApprovedInventoryAndPrice(p), {
    onPage: (i) => progress('inventory', i), shouldStop,
  });
  progress('unapproved', {});
  const unapproved = [];
  const unapprovedCounts = { rejected: null, pendingApproval: null };
  for (const status of ['pendingApproval', 'rejected']) {
    try {
      const res = await fetchAllPages((p) => client.getUnapprovedProducts({ ...p, status }), { size: 200, shouldStop });
      unapprovedCounts[status] = res.total != null ? res.total : res.items.length;
      for (const u of res.items.slice(0, 2000)) {
        unapproved.push({
          barcode: u.barcode, title: u.title, status: u.status || status, stockCode: u.stockCode,
          productMainId: u.productMainId, salePrice: u.salePrice, quantity: u.quantity,
          image: u.media && u.media[0] ? u.media[0].url : null,
          rejectReasons: (u.rejectReasonDetails || []).map((r) => ({ reason: r.rejectReason, detail: r.rejectReasonDetail })),
          lastUpdateDate: u.lastUpdateDate || null,
        });
      }
    } catch (e) {
      // Onaysız ürün servisi hesapta kapalıysa ana senkronizasyonu bozmasın
      unapprovedCounts[status] = null;
    }
  }
  const { variants, conflicts, contents } = mergeCatalog(products.items, inventory.items);
  const catalog = {
    syncedAt: nowIso(),
    startedAt,
    env: client.env,
    sellerId: client.sellerId,
    source: 'trendyol-api-v2',
    variants,
    conflicts,
    contents,
    unapproved,
    unapprovedCounts,
    inventoryMissing: variants.filter((v) => v.priceSource !== 'inventory').length,
    counts: summarize(variants),
  };
  store.set('catalog', catalog, { immediate: true });
  return catalog;
}

/** Belirli barkodların güncel stok/fiyatını Trendyol'dan okur (50'li gruplar). */
async function fetchCurrentByBarcodes(client, barcodes) {
  const map = new Map();
  for (const group of chunk([...new Set(barcodes)], 50)) {
    const res = await client.getApprovedInventoryAndPrice({ barcodes: group.join(','), size: 100, page: 0 });
    for (const c of (res && res.content) || []) {
      for (const v of c.variants || []) {
        if (v && v.barcode) map.set(String(v.barcode), { salePrice: v.salePrice, listPrice: v.listPrice, quantity: v.quantity, stockLastModifiedDate: v.stockLastModifiedDate });
      }
    }
  }
  return map;
}

/** Yerel katalogdaki değerleri günceller (yalnızca doğrulanmış/başarılı işlemlerden sonra çağrılır). */
function patchCatalog(store, updates) {
  const catalog = store.get('catalog', null);
  if (!catalog) return;
  const idx = new Map(catalog.variants.map((v, i) => [v.barcode, i]));
  for (const [barcode, patch] of updates) {
    const i = idx.get(barcode);
    if (i == null) continue;
    catalog.variants[i] = { ...catalog.variants[i], ...patch };
  }
  catalog.counts = summarize(catalog.variants);
  store.set('catalog', catalog);
}

module.exports = { fetchAllPages, mergeCatalog, summarize, syncCatalog, fetchCurrentByBarcodes, patchCatalog, PAGE_SIZE };
