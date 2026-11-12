'use strict';
/**
 * Toplu sticker listesi: kargoya verilmemiş paketleri gruplar.
 *  - Tek ürünlü paketler bedene göre (S, M, L…), çok ürünlüler toplam adede göre (2'li, 3'lü, 4'lü, 5+).
 *  - Aynı sipariş numarasının birden çok açık paketi varsa (bölünmüş paket) listeye ALINMAZ: etiket sipariş
 *    numarasıyla eşleştirildiği için hangi pakete ait olduğu ayırt edilemez; bunlar panelden yazdırılır.
 * Arayüz (Orders.jsx) ve testler aynı kodu kullanır.
 */

const SIZE_ORDER = ['XXS', 'XS', 'XS-S', 'XS/S', 'S', 'S/M', 'S-M', 'M', 'M/L', 'M-L', 'L', 'L/XL', 'L-XL', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL', 'STD', 'STANDART', 'TEK EBAT'];
const OPEN_FOR_LABEL = new Set(['Created', 'ReadyToShip', 'Approved', 'Picking']);
const sizeKey = (s) => String(s || '').trim().toLocaleUpperCase('tr-TR').replace(/\s+/g, '') || '—';
const groupLabel = (k) => (k.startsWith('n:') ? (k === 'n:5' ? '5 ve üzeri' : { 2: "2'li", 3: "3'lü", 4: "4'lü" }[k.slice(2)]) : k === '—' ? 'Beden yok' : k);
const isMixed = (o) => new Set((o.lines || []).map((l) => l.barcode || `${l.productName}|${l.productSize}|${l.productColor}`)).size > 1;
const sizeRank = (k) => { const i = SIZE_ORDER.indexOf(k === 'XXL' ? '2XL' : k); if (i >= 0) return i; const n = parseFloat(k); return Number.isFinite(n) ? 100 + n : k === '—' ? 9999 : 1000; };
const units = (o) => (o.lines || []).reduce((a, l) => a + (Number(l.quantity) || 0), 0);
const groupKey = (o) => { const n = units(o); return n === 1 ? sizeKey(o.lines[0].productSize) : n >= 5 ? 'n:5' : 'n:' + n; };

/**
 * @param {object[]} items  saklanan siparişler (orders.json items)
 * @returns {{ groups: [string, object[]][], split: object[], open: object[] }}
 *   groups: [anahtar, paketler] — yazdırma sırası; split: bölünmüş paketler (listede yok); open: listedeki paketler
 */
/** Kargo firması: "Trendyol Express Marketplace" → anahtar "trendyol express", görünen ad "Trendyol Express" */
const cargoName = (o) => String((o && o.cargoProviderName) || '').replace(/\s+marketplace\s*$/i, '').replace(/\s+/g, ' ').trim() || 'Kargo bilinmiyor';
const cargoKey = (o) => cargoName(o).toLocaleLowerCase('tr-TR');
/** Paketlerde en çok kullanılan kargo (ana kargo varsayılanı) */
function mainCargoOf(list) {
  const n = new Map();
  for (const o of list || []) { const k = cargoKey(o); n.set(k, (n.get(k) || 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'))[0]?.[0] || null;
}
/** Listedeki kargolar: [{ key, name, count }] (çoktan aza) */
function cargoList(list) {
  const m = new Map();
  for (const o of list || []) { const k = cargoKey(o); const x = m.get(k) || { key: k, name: cargoName(o), count: 0 }; x.count++; m.set(k, x); }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'tr'));
}

/**
 * @param {object} [opts]
 * @param {string} [opts.mainCargo]  ana kargo anahtarı: her grupta önce ana kargonun paketleri, diğer kargolar grubun sonunda
 */
function labelGroups(items, { mainCargo = null } = {}) {
  const open = (items || []).filter((o) => o && OPEN_FOR_LABEL.has(o.status) && o.shipmentPackageId && Array.isArray(o.lines) && o.lines.length && units(o) >= 1);
  const count = new Map();
  for (const o of open) count.set(String(o.orderNumber), (count.get(String(o.orderNumber)) || 0) + 1);
  const split = open.filter((o) => count.get(String(o.orderNumber)) > 1);
  const list = open.filter((o) => count.get(String(o.orderNumber)) === 1);
  const m = new Map();
  for (const o of list) {
    const k = groupKey(o);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  const name = (o) => String(o.lines[0].productName || '');
  const other = (o) => (mainCargo ? Number(cargoKey(o) !== mainCargo) : 0);
  for (const g of m.values()) g.sort((a, b) => other(a) - other(b) || Number(isMixed(a)) - Number(isMixed(b)) || name(a).localeCompare(name(b), 'tr') || String(a.lines[0].productColor || '').localeCompare(String(b.lines[0].productColor || ''), 'tr') || sizeRank(sizeKey(a.lines[0].productSize)) - sizeRank(sizeKey(b.lines[0].productSize)) || new Date(a.orderDate) - new Date(b.orderDate) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
  const rank = (k) => (k.startsWith('n:') ? 10000 + Number(k.slice(2)) : sizeRank(k));
  const groups = [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  return { groups, split, open: list };
}

/**
 * Etiket doğrulaması için beklenen kimlikler: her sipariş için açık paketin kargo takip numarası.
 * @returns {{ expect: Record<string,{ids:string[], split:boolean}>, others: string[] }}
 *   others: bilinen TÜM siparişlerin kimlikleri (başka siparişin etiketini yakalamak için)
 */
function labelExpectations(items, orderNumbers) {
  const byNo = new Map();
  for (const o of items || []) {
    if (!o) continue;
    const k = String(o.orderNumber);
    if (!byNo.has(k)) byNo.set(k, []);
    byNo.get(k).push(o);
  }
  const trk = (o) => { const t = String(o.cargoTrackingNumber == null ? '' : o.cargoTrackingNumber).trim(); return /^\d{8,}$/.test(t) ? t : ''; };
  const expect = {};
  for (const no of orderNumbers || []) {
    const recs = byNo.get(String(no)) || [];
    const open = recs.filter((o) => OPEN_FOR_LABEL.has(o.status));
    const src = open.length ? open : recs;
    expect[String(no)] = { ids: [...new Set(src.map(trk).filter(Boolean))], split: open.length > 1 };
  }
  const others = new Set();
  for (const [k, recs] of byNo) { if (/^\d{6,}$/.test(k)) others.add(k); for (const o of recs) { const t = trk(o); if (t) others.add(t); } }
  return { expect, others: [...others] };
}

module.exports = { labelGroups, labelExpectations, cargoName, cargoKey, mainCargoOf, cargoList, SIZE_ORDER, OPEN_FOR_LABEL, sizeKey, groupLabel, isMixed, sizeRank, units, groupKey };
