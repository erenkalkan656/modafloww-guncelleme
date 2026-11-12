'use strict';
/**
 * Buybox Fırsatları — veri katmanı (saf fonksiyonlar, test edilebilir).
 *
 * Ürünler tarayıcı eklentisinin kullanıcının açtığı Trendyol sayfalarından okuduğu verilerden gelir.
 * Hiçbir alan tahmin edilmez: okunamayan bilgi null kalır ve arayüzde "bilgi eksik" olarak görünür.
 * "Buybox bende" yalnızca iki doğrulanmış kaynaktan gelir:
 *   1) Ürün kendi kataloğumuzdaysa Trendyol Buybox Kontrol servisi (buyboxOrder === 1)
 *   2) Ürün sayfasındaki buybox satıcısının kimliği bizim satıcı ID'mize eşitse
 */

const { normBrand } = require('./brand-check');

const MAX_ITEMS = 20000;
const MAX_SCANS = 300;
const NEW_MS = 24 * 3600 * 1000;

const STATUS = {
  mine: { label: 'Buybox sende', tone: 'mine' },
  rival: { label: 'Buybox rakipte', tone: 'opp' },
  opp: { label: 'Buybox fırsatı', tone: 'opp' },
  doc: { label: 'Belge kontrolü', tone: 'doc' },
  no: { label: 'Uygun değil', tone: 'no' },
  unknown: { label: 'Bilgi eksik', tone: 'unknown' },
};

const emptyDb = () => ({ version: 1, items: {}, scans: [], selected: [], recentCats: [] });

const str = (v, max = 300) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
};
const int = (v, max = 1e12) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n < max ? n : null; };

/** Trendyol ürün linkinden içerik numarasını (…-p-123456) çıkarır; yalnızca trendyol.com kabul edilir. */
function parseProductUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch (_) { return null; }
  if (url.protocol !== 'https:' || !/^(www\.)?trendyol\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/-p-(\d{3,15})(?:$|[/?#])/);
  if (!m) return null;
  return { contentId: m[1], url: 'https://www.trendyol.com' + url.pathname, brandSlug: decodeURIComponent(url.pathname.split('/')[1] || '') || null };
}

function cleanImage(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href.slice(0, 600) : null; } catch (_) { return null; }
}

function cleanCategory(c) {
  if (!c || typeof c !== 'object') return null;
  const id = int(c.id);
  const name = str(c.name, 120);
  const path = Array.isArray(c.path) ? c.path.map((p) => str(p, 80)).filter(Boolean).slice(0, 8) : null;
  return id || name ? { id: id || null, name, path } : null;
}

function cleanVariants(list) {
  const out = [], seen = new Set();
  for (const v of list.slice(0, 60)) {
    const barcode = v && str(v.barcode, 40);
    const size = v && str(v.size, 24);
    if (!barcode || !size || !/^[A-Za-z0-9._-]{4,40}$/.test(barcode) || seen.has(barcode)) continue;
    seen.add(barcode);
    out.push({ size, barcode, inStock: v.inStock === true ? true : v.inStock === false ? false : null });
  }
  return out.length ? out : null;
}

const slugTitle = (slug) => String(slug || '').split('-').filter(Boolean).map((w) => w.charAt(0).toLocaleUpperCase('tr-TR') + w.slice(1)).join(' ') || null;
/**
 * Marka adını düzeltir. Trendyol ürün linkinin ilk parçası markadır (/happiness-istanbul/...-p-123).
 * Sayfadan marka yerine ürün adının tamamı okunduysa ("Happiness İstanbul Kadın Siyah ..."), linkteki markaya
 * uyan baştaki kelimeler alınır; uymazsa linkteki marka kullanılır.
 */
/**
 * Ürünün markası. En güvenilir kaynak ürün adresidir: trendyol.com/<marka>/<ürün-adı>-p-<id>.
 * Karttan okunan yazı (ör. kalın "Hızlı Teslimat", "Kargo Bedava" rozetleri ya da ürün adının tamamı) adresteki
 * markayla eşleşmiyorsa kullanılmaz; markanın yazımı ürün adının başından (adresle eşleşen kısım), o da yoksa adresten alınır.
 */
const BRAND_CACHE = new Map();
/** cleanBrand sonucu girdilere göre önbelleğe alınır (liste her sorgulandığında binlerce ürün için yeniden hesaplanmasın). */
function cleanBrand(brand, url, title) {
  if ((brand != null && typeof brand !== 'string') || typeof url !== 'string' || (title != null && typeof title !== 'string')) return cleanBrandRaw(brand, url, title);
  const key = (brand || '') + '\u0001' + url + '\u0001' + (title || '');
  let v = BRAND_CACHE.get(key);
  if (v === undefined) {
    if (BRAND_CACHE.size > 20000) BRAND_CACHE.clear();
    v = cleanBrandRaw(brand, url, title);
    BRAND_CACHE.set(key, v);
  }
  return v;
}
function cleanBrandRaw(brand, url, title) {
  const p = parseProductUrl(url);
  const slug = p && p.brandSlug;
  const sN = normBrand(slug);
  const b = brand ? String(brand).replace(/\s+/g, ' ').trim() : '';
  if (!sN) return b || null;
  if (b && normBrand(b) === sN) return b;
  const prefix = (s) => {
    const words = String(s || '').replace(/\s+/g, ' ').trim().split(' ');
    for (let i = 1; i <= Math.min(words.length, 8); i++) if (normBrand(words.slice(0, i).join(' ')) === sN) return words.slice(0, i).join(' ');
    return null;
  };
  return prefix(b) || prefix(title) || slugTitle(slug);
}

/** Eklentiden gelen tek bir ürünü doğrular ve normalize eder. Geçersizse null. */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = parseProductUrl(raw.url);
  if (!p) return null;
  const out = {
    contentId: p.contentId,
    url: p.url,
    title: str(raw.title, 300),
    brand: cleanBrand(str(raw.brand, 120), raw.url, str(raw.title, 300)),
    image: cleanImage(raw.image),
    price: num(raw.price),
    originalPrice: num(raw.originalPrice),
    merchantId: int(raw.merchantId) || null,
    sellerCount: int(raw.sellerCount, 10000),
    buyboxSeller: str(raw.buyboxSeller, 120),
    buyboxSellerId: int(raw.buyboxSellerId) || null,
    buyboxPrice: num(raw.buyboxPrice),
    barcode: str(raw.barcode, 60),
    variants: Array.isArray(raw.variants) ? cleanVariants(raw.variants) : null,
    detail: raw.detail === true,
  };
  if (!out.title) return null;
  return out;
}

function trimItems(items) {
  const keys = Object.keys(items);
  if (keys.length <= MAX_ITEMS) return items;
  keys.sort((a, b) => (items[a].lastSeen || 0) - (items[b].lastSeen || 0));
  for (const k of keys.slice(0, keys.length - MAX_ITEMS)) delete items[k];
  return items;
}

/**
 * Bir tarama sonucunu veritabanına işler. Aynı ürün (içerik no) tekrar eklenmez, yalnızca güncellenir.
 * Detay bilgisi (satıcı sayısı, buybox satıcısı) yalnızca yeni okunan değer null değilse üzerine yazılır.
 */
function mergeScan(db, payload, { now = Date.now(), scanId } = {}) {
  db = db && db.items ? db : emptyDb();
  const list = Array.isArray(payload && payload.items) ? payload.items.slice(0, 2500) : [];
  const category = cleanCategory(payload && payload.category);
  const requested = cleanCategory(payload && payload.requestedCategory);
  let added = 0, updated = 0, invalid = 0;
  const seen = new Set();
  for (const raw of list) {
    const it = normalizeItem(raw);
    if (!it) { invalid++; continue; }
    if (seen.has(it.contentId)) continue;
    seen.add(it.contentId);
    const prev = db.items[it.contentId];
    const cats = prev ? [...(prev.categories || [])] : [];
    for (const c of [requested, category]) {
      if (c && !cats.some((x) => (c.id && x.id === c.id) || (!c.id && x.name === c.name))) cats.push(c);
    }
    const merged = { ...(prev || { firstSeen: now, brandCheck: null, join: null }), lastSeen: now, categories: cats.slice(-6) };
    for (const [k, v] of Object.entries(it)) {
      if (k === 'detail') continue;
      if (v != null) merged[k] = v;
      else if (!prev) merged[k] = null;
    }
    if (it.detail) merged.detailAt = now;
    merged.scanIds = [...(prev && prev.scanIds ? prev.scanIds : []), scanId].filter(Boolean).slice(-5);
    db.items[it.contentId] = merged;
    if (prev) updated++; else added++;
  }
  const scan = {
    id: scanId || 'tarama-' + now.toString(36),
    at: now,
    kind: payload && payload.kind === 'detail' ? 'detail' : 'list',
    pageUrl: str(payload && payload.pageUrl, 400),
    pageTitle: str(payload && payload.pageTitle, 200),
    category: requested || category,
    pageCategory: category,
    received: list.length, added, updated, invalid,
  };
  db.scans = [scan, ...(db.scans || [])].slice(0, MAX_SCANS);
  const rc = requested || category;
  if (rc && rc.id) db.recentCats = [rc, ...(db.recentCats || []).filter((c) => c.id !== rc.id)].slice(0, 12);
  trimItems(db.items);
  return { db, scan };
}

/**
 * Bir ürünün durumunu belirler.
 * own: { byContent: Map(contentId -> [barcode]) , buybox: { barcode: {order} }, sellerId }
 */
function classify(it, own = {}) {
  if (it.join && it.join.status === 'rejected') return 'no';
  if (it.join && it.join.status === 'docRequired') return 'doc';
  const sellerId = own.sellerId ? Number(own.sellerId) : null;
  const barcodes = own.byContent ? own.byContent.get(String(it.contentId)) : null;
  if (barcodes && barcodes.length) {
    const infos = barcodes.map((b) => own.buybox && own.buybox[b]).filter((x) => x && !x.none && x.order != null);
    if (infos.some((x) => x.order === 1)) return 'mine';
    if (infos.length) return 'rival';
  }
  if (sellerId && it.buyboxSellerId && it.buyboxSellerId === sellerId) return 'mine';
  if (it.brandCheck && (it.brandCheck.status === 'active' || it.brandCheck.status === 'application')) return 'doc';
  if (it.sellerCount != null || it.buyboxSeller || it.buyboxSellerId) return 'opp';
  return 'unknown';
}

const isNew = (it, now = Date.now()) => now - (it.firstSeen || 0) < NEW_MS;
/** Marka 25/35 sınıflarında tescilsiz (ya da yalnızca süresi dolmuş tescil) */
const brandFree = (it) => !!(it.brandCheck && (it.brandCheck.status === 'none' || it.brandCheck.status === 'expired'));

const FILTERS = {
  all: { label: 'Tüm ürünler', test: () => true },
  mine: { label: 'Buybox bende', test: (it, s) => s === 'mine' },
  rival: { label: 'Buybox rakipte', test: (it, s) => s === 'opp' || s === 'rival' },
  new: { label: 'Yeni fırsatlar', test: (it, s, now) => isNew(it, now) && s !== 'mine' && s !== 'no' },
  doc: { label: 'Satıcı belgesi gerekenler', test: (it, s) => s === 'doc' },
  brand: { label: 'Marka kontrolü bekleyenler', test: (it) => !it.brandCheck || it.brandCheck.status === 'unverified' },
  // Katılıma uygun: Trendyol katılımı onayladıysa ya da marka 25/35 sınıflarında tescilsiz çıktıysa (kendi ürünlerimiz hariç).
  // Doğrulanamayan marka tescilsiz SAYILMAZ (marka kontrolü bekleyenlerde kalır).
  eligible: { label: 'Katılıma uygun', test: (it, s) => !!(it.join && it.join.status === 'ok') || (!['mine', 'rival', 'no', 'doc'].includes(s) && brandFree(it)) },
  // Uygun değil: Trendyol reddetti ya da marka tescilli/başvurulu (satıcı belgesi olmadan katılınamaz)
  no: { label: 'Uygun değil', test: (it, s) => s === 'no' || s === 'doc' },
};

const bbPrice = (it) => it.buyboxPrice ?? it.price ?? null;
const SORTS = {
  newest: { label: 'En yeni bulunan', cmp: (a, b) => (b.firstSeen || 0) - (a.firstSeen || 0) },
  bbAsc: { label: 'En düşük Buybox fiyatı', cmp: (a, b) => (bbPrice(a) ?? Infinity) - (bbPrice(b) ?? Infinity) },
  bbDesc: { label: 'En yüksek Buybox fiyatı', cmp: (a, b) => (bbPrice(b) ?? -Infinity) - (bbPrice(a) ?? -Infinity) },
  sellers: { label: 'En fazla satıcısı olan', cmp: (a, b) => (b.sellerCount ?? -1) - (a.sellerCount ?? -1) },
  mine: { label: 'Buybox bende olanlar önce', cmp: (a, b) => (b._s === 'mine') - (a._s === 'mine') },
  profit: { label: 'Tahmini kâr oranı', cmp: (a, b) => (b.est && b.est.marginPct != null ? b.est.marginPct : -Infinity) - (a.est && a.est.marginPct != null ? a.est.marginPct : -Infinity) },
  opp: { label: 'Yeni fırsatlar önce', cmp: (a, b, now) => (isNew(b, now) && b._s !== 'mine') - (isNew(a, now) && a._s !== 'mine') || (b.firstSeen || 0) - (a.firstSeen || 0) },
};

/** Liste sorgusu: filtre + arama + kategori + sıralama + sayfalama. Sayılar da döner. */
function query(db, own, q = {}, now = Date.now()) {
  const all = Object.values((db && db.items) || {}).map((it) => ({ ...it, _s: classify(it, own) }));
  const counts = { total: all.length };
  for (const [k, f] of Object.entries(FILTERS)) counts[k] = all.filter((it) => f.test(it, it._s, now)).length;
  const f = FILTERS[q.filter] || FILTERS.all;
  const cats = Array.isArray(q.categories) ? q.categories.map(String) : [];
  const text = q.search ? String(q.search).toLocaleLowerCase('tr-TR') : '';
  const brands = Array.isArray(q.brands) ? new Set(q.brands) : null;
  const pMin = num(q.priceMin), pMax = num(q.priceMax);
  const sMin = int(q.sellersMin, 10000);
  let rows = all.filter((it) => {
    if (!f.test(it, it._s, now)) return false;
    if (cats.length && !(it.categories || []).some((c) => cats.includes(String(c.id || c.name)))) return false;
    if (brands && brands.size && !brands.has(it.brand || '—')) return false;
    if (text && !`${it.title} ${it.brand || ''} ${it.contentId}`.toLocaleLowerCase('tr-TR').includes(text)) return false;
    const p = bbPrice(it);
    if (pMin != null && (p == null || p < pMin)) return false;
    if (pMax != null && (p == null || p > pMax)) return false;
    if (sMin != null && sMin > 0 && (it.sellerCount == null || it.sellerCount < sMin)) return false;
    return true;
  });
  const s = SORTS[q.sort] || SORTS.newest;
  rows.sort((a, b) => s.cmp(a, b, now) || (b.firstSeen || 0) - (a.firstSeen || 0));
  const pageSize = [10, 20, 50, 100].includes(Number(q.pageSize)) ? Number(q.pageSize) : 20;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(0, Number(q.page) || 0), pages - 1);
  const filteredIds = rows.map((r) => r.contentId);
  const brandList = [...new Set(all.map((it) => it.brand || '—'))].sort((a, b) => a.localeCompare(b, 'tr'));
  const catMap = new Map();
  for (const it of all) for (const c of it.categories || []) { const k = String(c.id || c.name); catMap.set(k, { key: k, name: c.name || ('#' + c.id), n: (catMap.get(k) || { n: 0 }).n + 1 }); }
  return {
    items: rows.slice(page * pageSize, (page + 1) * pageSize).map((r) => ({ ...r, isNew: isNew(r, now) })),
    total: rows.length, page, pages, pageSize, counts, filteredIds,
    brands: brandList, categories: [...catMap.values()].sort((a, b) => b.n - a.n),
  };
}

/** Katalogdan içerik no -> barkod listesi. */
function ownIndex(catalog) {
  const byContent = new Map();
  for (const v of (catalog && catalog.variants) || []) {
    if (v.contentId == null || v.archived) continue;
    const k = String(v.contentId);
    if (!byContent.has(k)) byContent.set(k, []);
    byContent.get(k).push(String(v.barcode));
  }
  return byContent;
}

/** Trendyol kategori ağacını (product-categories) sade bir ağaca çevirir. */
function normalizeCategoryTree(res) {
  const walk = (list, depth) => (Array.isArray(list) ? list : []).filter((c) => c && c.id != null && c.name).map((c) => ({
    id: Number(c.id), name: String(c.name).slice(0, 120),
    children: depth < 12 ? walk(c.subCategories, depth + 1) : [],
  }));
  return walk(res && (res.categories || res), 0);
}

module.exports = { cleanBrand, STATUS, FILTERS, SORTS, emptyDb, parseProductUrl, normalizeItem, mergeScan, classify, query, ownIndex, normalizeCategoryTree, isNew };
