'use strict';
/**
 * Kara liste: eklenen ürünlere uygulama HİÇBİR değişiklik yapmaz (stok, fiyat, ürün bilgisi, arşiv, grup otomasyonu)
 * ve ürün listelerinde görünmez. Ürün düzeyinde tutulur: ürünün sonradan eklenen varyantları da engellenir.
 *
 * Saklama (store 'blacklist'): { items: [{ key, productMainId, contentId, title, image, barcodes[], addedAt }], updatedAt }
 *   key: 'p:<productMainId>' (yoksa 'c:<contentId>')
 */

const productKey = (v) => (v && v.productMainId ? 'p:' + v.productMainId : v && v.contentId != null ? 'c:' + v.contentId : null);

function normalize(bl) {
  const items = Array.isArray(bl && bl.items) ? bl.items.filter((x) => x && x.key) : [];
  return { items, updatedAt: (bl && bl.updatedAt) || null };
}

/** Engellenen barkodlar: eklenirken kaydedilenler + katalogda aynı ürüne ait (sonradan eklenen) varyantlar. */
function blockedSet(bl, variants) {
  const b = normalize(bl);
  const set = new Set();
  const keys = new Set();
  for (const it of b.items) { keys.add(it.key); for (const bc of it.barcodes || []) set.add(String(bc)); }
  if (keys.size) for (const v of variants || []) { const k = productKey(v); if (k && keys.has(k)) set.add(String(v.barcode)); }
  return set;
}

/** Engellenen ürün içerik numaraları (ürün bilgisi güncelleme gibi içerik düzeyi işlemler için). */
function blockedContentIds(bl, variants) {
  const b = normalize(bl);
  const keys = new Set(b.items.map((i) => i.key));
  const out = new Set(b.items.map((i) => i.contentId).filter((x) => x != null).map(String));
  for (const v of variants || []) { const k = productKey(v); if (k && keys.has(k) && v.contentId != null) out.add(String(v.contentId)); }
  return out;
}

/** Seçilen varyantların ÜRÜNLERİNİ (tüm varyantlarıyla) kara listeye ekler. */
function addByBarcodes(bl, barcodes, variants, now = Date.now()) {
  const b = normalize(bl);
  const want = new Set((barcodes || []).map(String));
  const all = variants || [];
  const keys = new Map();
  for (const v of all) if (want.has(String(v.barcode))) { const k = productKey(v); if (k) keys.set(k, v); }
  const missing = [...want].filter((bc) => !all.some((v) => String(v.barcode) === bc));
  const have = new Set(b.items.map((i) => i.key));
  let added = 0;
  for (const [k, v] of keys) {
    const barcodesOf = all.filter((x) => productKey(x) === k).map((x) => String(x.barcode));
    if (have.has(k)) {
      const it = b.items.find((i) => i.key === k);
      it.barcodes = [...new Set([...(it.barcodes || []), ...barcodesOf])];
      continue;
    }
    b.items.push({ key: k, productMainId: v.productMainId || null, contentId: v.contentId ?? null, title: v.title || '', image: v.image || null, barcodes: barcodesOf, addedAt: now });
    added++;
  }
  b.updatedAt = now;
  return { list: b, added, missing };
}

function removeKeys(bl, keys, now = Date.now()) {
  const b = normalize(bl);
  const rm = new Set((keys || []).map(String));
  const before = b.items.length;
  b.items = b.items.filter((i) => !rm.has(i.key));
  b.updatedAt = now;
  return { list: b, removed: before - b.items.length };
}

module.exports = { productKey, normalize, blockedSet, blockedContentIds, addByBarcodes, removeKeys };
