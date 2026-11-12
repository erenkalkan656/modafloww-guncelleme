'use strict';
// Not: Bu modül hem arayüzde hem testlerde kullanılır; Node'a özgü modül içe aktarmaz.
const { compareSizes } = require('./sizes');

const NO_SIZE = '__none__';

function lower(s) {
  return String(s == null ? '' : s).toLocaleLowerCase('tr-TR');
}

/**
 * Ürün/varyant filtresi. Tüm filtreler VE (AND) mantığıyla birlikte uygulanır.
 * f = { q, sizes:[], status, stock:'all|in|out|low', lowStock, minPrice, maxPrice, category, conflictOnly, sort:{key,dir} }
 * Beden filtresi seçiliyse arama, sıralama ve seçim yalnızca o bedenlerin varyantları üzerinde çalışır.
 */
function filterVariants(variants, f = {}) {
  const q = f.q ? lower(f.q).trim() : '';
  const sizes = f.sizes && f.sizes.length ? new Set(f.sizes) : null;
  const min = f.minPrice != null && f.minPrice !== '' ? Number(String(f.minPrice).replace(',', '.')) : null;
  const max = f.maxPrice != null && f.maxPrice !== '' ? Number(String(f.maxPrice).replace(',', '.')) : null;
  const low = Number.isFinite(Number(f.lowStock)) ? Number(f.lowStock) : 5;
  const out = [];
  for (const v of variants) {
    if (sizes) {
      const key = v.size || NO_SIZE;
      if (!sizes.has(key)) continue;
    }
    if (f.status && f.status !== 'all' && v.status !== f.status) continue;
    if (f.stock && f.stock !== 'all') {
      const qn = Number(v.quantity);
      if (f.stock === 'in' && !(qn > 0)) continue;
      if (f.stock === 'out' && qn !== 0) continue;
      if (f.stock === 'low' && !(qn > 0 && qn <= low)) continue;
    }
    if (min != null && Number.isFinite(min) && !(v.salePrice >= min)) continue;
    if (max != null && Number.isFinite(max) && !(v.salePrice <= max)) continue;
    if (Array.isArray(f.category) ? f.category.length && !f.category.includes(v.category) : f.category && f.category !== 'all' && v.category !== f.category) continue;
    if (f.brand && f.brand !== 'all' && v.brand !== f.brand) continue;
    if (f.tab === 'active' && v.status !== 'onSale') continue;
    if (f.tab === 'passive' && v.status === 'onSale') continue;
    // Alan bazlı aramalar (Trendyol paneli gibi ayrı kutular)
    if (f.barcode && !lower(v.barcode).includes(lower(f.barcode).trim())) continue;
    if (f.title && !lower(v.title).includes(lower(f.title).trim())) continue;
    if (f.model && !lower(v.productMainId).includes(lower(f.model).trim())) continue;
    if (f.stockCode && !lower(v.stockCode).includes(lower(f.stockCode).trim())) continue;
    if (f.conflictOnly && !v.conflict) continue;
    if (f.sub && f.sub !== 'all' && !matchSub(v, f.sub, f.buybox || {})) continue;
    if (q) {
      const hay = v._hay || (v._hay = lower([v.title, v.barcode, v.stockCode, v.productMainId, v.color, v.brand].filter(Boolean).join(' ')));
      // Birden fazla kelime: hepsi geçmeli
      if (!q.split(/\s+/).every((w) => hay.includes(w))) continue;
    }
    out.push(v);
  }
  if (f.sort && f.sort.key) {
    const dir = f.sort.dir === 'desc' ? -1 : 1;
    const k = f.sort.key;
    out.sort((a, b) => {
      let r;
      if (k === 'size') r = compareSizes(a.size, b.size);
      else if (k === 'title') r = lower(a.title).localeCompare(lower(b.title), 'tr') || compareSizes(a.size, b.size);
      else {
        const x = a[k], y = b[k];
        if (x == null && y == null) r = 0;
        else if (x == null) return 1; // boş değerler her zaman sona
        else if (y == null) return -1;
        else r = x < y ? -1 : x > y ? 1 : 0;
      }
      return r * dir;
    });
  }
  return out;
}

/**
 * Alt filtreler (Trendyol panelindeki "Tükenenler", "Kilitliler", "Buybox dahil olanlar" vb.)
 * Buybox filtreleri yalnızca buybox bilgisi okunmuş varyantlarda sonuç verir.
 */
const SUB_FILTERS = {
  out: { label: 'Tükenenler', test: (v) => v.quantity === 0 },
  noPrice: { label: 'Fiyat girilmesi gerekenler', test: (v) => !(Number(v.salePrice) > 0) },
  locked: { label: 'Kilitliler', test: (v) => !!v.locked },
  archived: { label: 'Arşivdekiler', test: (v) => !!v.archived },
  closed: { label: 'Satışa kapatılanlar', test: (v) => v.status === 'notOnSale' },
  bbIn: { label: 'Buybox dahil olanlar', buybox: true, test: (v, bb) => !!(bb[v.barcode] && !bb[v.barcode].none && bb[v.barcode].multi) },
  bbOut: { label: 'Buybox dahil olmayanlar', buybox: true, test: (v, bb) => !!(bb[v.barcode] && !bb[v.barcode].none && !bb[v.barcode].multi) },
  bbLost: { label: 'Buybox kaybedilenler', buybox: true, test: (v, bb) => !!(bb[v.barcode] && !bb[v.barcode].none && bb[v.barcode].order > 1) },
};
function matchSub(v, key, bb) {
  const s = SUB_FILTERS[key];
  return s ? s.test(v, bb) : true;
}

/** Her alt filtre için (diğer filtreler uygulanmışken) kaç ÜRÜN olduğunu sayar. */
function subCounts(variants, f, keys) {
  const out = {};
  for (const k of keys) {
    const list = filterVariants(variants, { ...f, sub: k, sort: null });
    out[k] = new Set(list.map((v) => v.contentId)).size;
  }
  return out;
}

/** Diğer filtreler uygulanmışken her bedenin kaç varyantı olduğunu sayar (beden çiplerinde gösterilir). */
function sizeCounts(variants, f = {}) {
  const base = filterVariants(variants, { ...f, sizes: [], sort: null });
  const counts = {};
  for (const v of base) {
    const k = v.size || NO_SIZE;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * Filtrelenmiş varyantları ürün (içerik) bazında gruplar. Her grup yalnızca filtreye uyan varyantları içerir;
 * `totalVariants` ürünün katalogdaki toplam varyant sayısıdır.
 */
function groupVariants(filtered, allVariants, sort) {
  const totals = new Map();
  for (const v of allVariants) {
    const k = groupKey(v);
    totals.set(k, (totals.get(k) || 0) + 1);
  }
  const map = new Map();
  for (const v of filtered) {
    const k = groupKey(v);
    let g = map.get(k);
    if (!g) {
      g = { key: k, contentId: v.contentId, productMainId: v.productMainId, title: v.title, image: v.image, brand: v.brand, category: v.category, color: v.color, productUrl: v.productUrl, variants: [], totalVariants: totals.get(k) || 0 };
      map.set(k, g);
    }
    g.variants.push(v);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.variants.sort((a, b) => compareSizes(a.size, b.size));
    const prices = g.variants.map((v) => v.salePrice).filter((x) => Number.isFinite(x));
    const lists = g.variants.map((v) => v.listPrice).filter((x) => Number.isFinite(x));
    const comm = g.variants.map((v) => v.commission).filter((x) => Number.isFinite(x));
    g.minPrice = prices.length ? Math.min(...prices) : null;
    g.maxPrice = prices.length ? Math.max(...prices) : null;
    g.maxList = lists.length ? Math.max(...lists) : null;
    g.stock = g.variants.reduce((a, v) => a + (Number(v.quantity) || 0), 0);
    g.onSale = g.variants.filter((v) => v.status === 'onSale').length;
    g.outOfStock = g.variants.filter((v) => v.quantity === 0).length;
    g.sizes = [...new Set(g.variants.map((v) => v.size).filter(Boolean))];
    g.commission = comm.length ? (Math.min(...comm) === Math.max(...comm) ? comm[0] : [Math.min(...comm), Math.max(...comm)]) : null;
    g.modifiedAt = Math.max(0, ...g.variants.map((v) => Number(v.modifiedAt) || 0)) || null;
    g.createdAt = Math.min(Infinity, ...g.variants.map((v) => Number(v.createdAt) || Infinity));
    if (!Number.isFinite(g.createdAt)) g.createdAt = null;
    g.conflict = g.variants.some((v) => v.conflict);
  }
  if (sort && sort.key) {
    const dir = sort.dir === 'desc' ? -1 : 1;
    const val = { title: (g) => lower(g.title), salePrice: (g) => g.minPrice, quantity: (g) => g.stock, variants: (g) => g.variants.length, modifiedAt: (g) => g.modifiedAt, createdAt: (g) => g.createdAt, size: (g) => lower(g.title) }[sort.key] || ((g) => lower(g.title));
    groups.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return x.localeCompare(y, 'tr') * dir;
      return (x - y) * dir;
    });
  }
  return groups;
}

function groupKey(v) {
  return v.contentId != null ? 'c' + v.contentId : 'm' + (v.productMainId || v.barcode);
}

module.exports = { filterVariants, sizeCounts, groupVariants, subCounts, SUB_FILTERS, NO_SIZE };
