'use strict';
// Yeni sipariş izleyici: kısa aralıklarla yalnızca son siparişleri tek istekle sorar,
// daha önce görülmemiş "Yeni" (Created) paketleri döndürür. Yalnızca okuma yapar.
const { minimizeOrder, fixOrderDates, NEW_STATUSES } = require('./orders');

const HOUR = 3600 * 1000;
const LOOKBACK = 48 * HOUR;     // son 2 gün; uygulama kapalıyken gelenler de yakalanır
const PAGE_SIZE = 200;          // tek istek (API üst sınırı); son 2 günde değişen tüm paketler
const MAX_SEEN = 3000;

const keyOf = (o) => String(o.shipmentPackageId || o.orderNumber);

/**
 * @returns {{ primed: boolean, fresh: object[], checked: number }}
 * İlk çalışmada (veya izleyici sıfırlandığında) mevcut siparişler "görüldü" sayılır, bildirim üretilmez.
 */
async function checkNewOrders(client, store, { now = Date.now() } = {}) {
  const res = await client.getOrders({
    // Durum filtresi verilmez: Trendyol yeni paketleri "Created" veya "ReadyToShip" olarak döndürebiliyor
    startDate: now - LOOKBACK, endDate: now, page: 0, size: PAGE_SIZE,
    orderByField: 'PackageLastModifiedDate', orderByDirection: 'DESC',
  });
  const content = res && Array.isArray(res.content) ? res.content : null;
  if (!content) throw new Error('Sipariş yanıtı geçersiz');
  const list = content.map(minimizeOrder).filter((o) => NEW_STATUSES.has(o.status));

  const watch = store.get('orderWatch', null);
  const known = new Set(watch && Array.isArray(watch.seen) ? watch.seen : []);
  const primed = !watch;
  // İlk çalışmada sipariş sayfasında zaten görünen paketler de "görüldü" sayılır
  if (primed) for (const o of (store.get('orders', { items: [] }).items || [])) known.add(keyOf(o));

  const fresh = primed ? [] : list.filter((o) => !known.has(keyOf(o)));
  for (const o of list) known.add(keyOf(o));
  store.set('orderWatch', { seen: [...known].slice(-MAX_SEEN), checkedAt: new Date(now).toISOString(), primedAt: primed ? new Date(now).toISOString() : watch.primedAt });

  if (fresh.length) {
    // Siparişler sayfasında hemen görünsün diye yerel listeye ekle
    const prev = store.get('orders', { items: [], syncedAt: null });
    const merged = new Map((fixOrderDates(prev.items) || []).map((o) => [keyOf(o), o]));
    for (const o of fresh) merged.set(keyOf(o), o);
    store.set('orders', { ...prev, items: [...merged.values()].sort((a, b) => (b.orderDate || 0) - (a.orderDate || 0)) });
  }
  return { primed, fresh: fresh.sort((a, b) => (a.orderDate || 0) - (b.orderDate || 0)), checked: list.length };
}

/** Bildirim kartında gösterilecek özet (kişisel veri içermez). */
function orderSummary(o) {
  const lines = o.lines || [];
  const units = lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0) || lines.length;
  const first = lines[0];
  return {
    orderNumber: o.orderNumber,
    packageId: o.shipmentPackageId,
    amount: o.totalPrice,
    currency: o.currencyCode || 'TRY',
    units,
    product: first ? `${first.productName || ''}${first.productSize ? ' · ' + first.productSize : ''}` : '',
    more: Math.max(0, lines.length - 1),
    fast: !!o.fastDelivery,
    abroad: !!(o.countryCode && o.countryCode !== 'TR'),
    agreedDeliveryDate: o.agreedDeliveryDate || null,
  };
}

module.exports = { checkNewOrders, orderSummary, LOOKBACK };
