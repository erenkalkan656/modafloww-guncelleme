'use strict';
const nowIso = () => new Date().toISOString();

const DAY = 24 * 3600 * 1000;
const MAX_WINDOW = 14 * DAY; // V2: tarih aralığı en fazla 2 hafta
const MAX_HISTORY_DAYS = 30; // V2: erişilebilir geçmiş yaklaşık 1 ay
const PAGE_SIZE = 200;
const MAX_PAGES = 50; // 10.000 kayıt penceresi

const STATUS_LABELS = {
  Created: 'Yeni', Picking: 'Hazırlanıyor', Invoiced: 'Faturalandı', Shipped: 'Kargoda', Delivered: 'Teslim edildi',
  Cancelled: 'İptal', UnDelivered: 'Teslim edilemedi', Returned: 'İade', AtCollectionPoint: 'Teslim noktasında',
  UnPacked: 'Paket bozuldu', UnSupplied: 'Tedarik edilemedi', Awaiting: 'Beklemede', Verified: 'Onaylandı',
  ReadyToShip: 'Yeni', UnDeliveredAndReturned: 'Teslim edilemedi, iade',
};
// Trendyol yeni paketleri "Created" yerine "ReadyToShip" durumuyla da gönderiyor; ikisi de "Yeni" sayılır
const NEW_STATUSES = new Set(['Created', 'ReadyToShip']);
const NON_REVENUE = new Set(['Cancelled', 'UnSupplied', 'Returned', 'UnDelivered', 'UnDeliveredAndReturned']);

// Trendyol sipariş tarihini (orderDate) İstanbul saatini UTC gibi yazarak, yani 3 saat ileri kaymış döndürür
// (packageHistories ve agreedDeliveryDate ise gerçek zamandır). Diske gerçek zaman yazılır; tz: 1 bunu işaretler.
const TR_SHIFT = 3 * 3600 * 1000;
/** Siparişin gerçek oluşturulma zamanı (ms). Eski kayıtlarda (tz yok) kaymayı geri alır. */
function orderTime(o) {
  if (!o || o.orderDate == null || o.orderDate === '') return null;
  const t = typeof o.orderDate === 'number' || /^\d+$/.test(String(o.orderDate)) ? Number(o.orderDate) : Date.parse(o.orderDate);
  if (!Number.isFinite(t)) return null;
  return o.tz === 1 ? t : t - TR_SHIFT;
}
/** Eski (kaymış) kayıtları gerçek zamana çevirir; değişiklik yoksa aynı diziyi döndürür. */
function fixOrderDates(items) {
  if (!Array.isArray(items) || items.every((o) => !o || o.tz === 1)) return items;
  return items.map((o) => (!o || o.tz === 1 ? o : { ...o, orderDate: orderTime(o), tz: 1 }));
}
/** Paket oluşmadan (shipmentPackageId yok) kaydedilmiş geçici siparişi, aynı siparişin gerçek paketi gelince atar. */
function dropPlaceholders(items) {
  if (!Array.isArray(items)) return items;
  const withPkg = new Set(items.filter((o) => o && o.shipmentPackageId).map((o) => String(o.orderNumber)));
  const out = items.filter((o) => !o || o.shipmentPackageId || !withPkg.has(String(o.orderNumber)));
  return out.length === items.length ? items : out;
}
/** Saklanan sipariş listesini bir kez gerçek zamana taşır (uygulama açılışında çağrılır). */
function migrateOrderDates(store) {
  const cur = store.get('orders', { items: [] });
  if (!cur || !Array.isArray(cur.items)) return false;
  const items = dropPlaceholders(fixOrderDates(cur.items));
  if (items === cur.items) return false;
  store.set('orders', { ...cur, items });
  return true;
}

/**
 * Siparişten yalnızca operasyon için gereken alanları tutar.
 * Adres, telefon, e-posta, TC kimlik, vergi no gibi kişisel veriler DİSKE YAZILMAZ.
 */
function minimizeOrder(o) {
  return {
    orderNumber: String(o.orderNumber || ''),
    shipmentPackageId: o.shipmentPackageId ?? o.id ?? null,
    status: o.shipmentPackageStatus || o.status || null,
    orderDate: o.orderDate ? orderTime({ orderDate: o.orderDate }) : null,
    tz: 1,
    lastModifiedDate: o.lastModifiedDate || null,
    customerName: [o.customerFirstName, o.customerLastName ? String(o.customerLastName).charAt(0) + '.' : null].filter(Boolean).join(' ') || null,
    city: (o.shipmentAddress && o.shipmentAddress.city) || null,
    district: (o.shipmentAddress && o.shipmentAddress.district) || null,
    cargoProviderName: o.cargoProviderName || null,
    cargoTrackingNumber: o.cargoTrackingNumber != null ? String(o.cargoTrackingNumber) : null,
    cargoTrackingLink: o.cargoTrackingLink || null,
    grossAmount: o.packageGrossAmount ?? o.grossAmount ?? null,
    totalDiscount: o.packageTotalDiscount ?? o.totalDiscount ?? null,
    totalPrice: o.packageTotalPrice ?? o.totalPrice ?? null,
    currencyCode: o.currencyCode || 'TRY',
    countryCode: o.countryCode || (o.shipmentAddress && o.shipmentAddress.countryCode) || null,
    micro: !!o.micro,
    agreedDeliveryDate: o.agreedDeliveryDate || null,
    estimatedDeliveryEndDate: o.estimatedDeliveryEndDate || null,
    fastDelivery: !!o.fastDelivery,
    isCod: !!o.isCod,
    cargoDeci: Number.isFinite(Number(o.cargoDeci)) && o.cargoDeci !== null ? Number(o.cargoDeci) : null,
    // Faturanın Trendyol'a yüklenip yüklenmediği (bağlantı fatura dosyasına gider; kişisel veri alanı değildir)
    invoiceLink: typeof o.invoiceLink === 'string' && /^https:\/\//.test(o.invoiceLink) ? o.invoiceLink : null,
    plus: !!(o.isPlusCustomer || o.plus),
    lines: (o.lines || []).map((l) => ({
      lineId: l.lineId ?? l.id ?? null,
      barcode: l.barcode != null ? String(l.barcode) : null,
      stockCode: l.stockCode || l.merchantSku || null,
      productName: l.productName || null,
      productSize: l.productSize || null,
      productColor: l.productColor || null,
      quantity: Number(l.quantity) || 0,
      unitPrice: l.lineUnitPrice ?? l.price ?? null,
      grossAmount: l.lineGrossAmount ?? l.amount ?? null,
      discount: l.lineTotalDiscount ?? l.discount ?? null,
      status: l.orderLineItemStatusName || null,
      commission: l.commission ?? null,
    })),
    history: (o.packageHistories || []).map((h) => ({ date: h.createdDate, status: h.status })),
  };
}

function windows(startMs, endMs) {
  const out = [];
  let s = startMs;
  while (s < endMs) {
    const e = Math.min(s + MAX_WINDOW - 1000, endMs);
    out.push([s, e]);
    s = e + 1;
  }
  return out;
}

/**
 * Siparişleri son `days` gün için çeker (2 haftalık pencerelerle) ve yerelde birleştirir.
 */
async function syncOrders(client, store, { days = 14, onProgress } = {}) {
  days = Math.min(Math.max(1, days), MAX_HISTORY_DAYS);
  const end = Date.now();
  const start = end - days * DAY;
  const fetched = new Map();
  let truncated = false;
  for (const [s, e] of windows(start, end)) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.getOrders({ startDate: s, endDate: e, page, size: PAGE_SIZE, orderByField: 'PackageLastModifiedDate', orderByDirection: 'DESC' });
      const content = (res && Array.isArray(res.content)) ? res.content : null;
      if (!content) throw new Error('Sipariş yanıtı geçersiz');
      for (const o of content) {
        const m = minimizeOrder(o);
        fetched.set(String(m.shipmentPackageId || m.orderNumber), m);
      }
      if (onProgress) onProgress({ fetched: fetched.size });
      if (page + 1 >= (res.totalPages || 0) || content.length === 0) break;
      if (page + 1 === MAX_PAGES) truncated = true;
    }
  }
  const prev = store.get('orders', { items: [] });
  const merged = new Map((fixOrderDates(prev.items) || []).map((o) => [String(o.shipmentPackageId || o.orderNumber), o]));
  for (const [k, v] of fetched) merged.set(k, v);
  const cutoff = end - (MAX_HISTORY_DAYS + 5) * DAY;
  const items = dropPlaceholders([...merged.values()]).filter((o) => !o.orderDate || o.orderDate >= cutoff).sort((a, b) => (b.orderDate || 0) - (a.orderDate || 0));
  const data = { syncedAt: nowIso(), rangeDays: days, items, truncated, source: 'trendyol-api-v2' };
  store.set('orders', data);
  return { count: fetched.size, total: items.length, truncated };
}

function orderStats(items, { from, to } = {}) {
  const inRange = items.filter((o) => (!from || o.orderDate >= from) && (!to || o.orderDate <= to));
  const byStatus = {};
  let revenue = 0, units = 0, packages = 0;
  const byDay = {};
  const byProduct = new Map();
  const bySize = {};
  for (const o of inRange) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if (NON_REVENUE.has(o.status)) continue;
    packages++;
    revenue += Number(o.totalPrice) || 0;
    const day = o.orderDate ? new Date(o.orderDate + 3 * 3600 * 1000).toISOString().slice(0, 10) : 'bilinmiyor';
    byDay[day] = byDay[day] || { day, packages: 0, revenue: 0, units: 0 };
    byDay[day].packages++;
    byDay[day].revenue += Number(o.totalPrice) || 0;
    for (const l of o.lines) {
      units += l.quantity;
      byDay[day].units += l.quantity;
      const key = l.barcode || l.productName;
      const p = byProduct.get(key) || { barcode: l.barcode, productName: l.productName, size: l.productSize, units: 0, revenue: 0 };
      p.units += l.quantity;
      p.revenue += (Number(l.unitPrice) || 0) * l.quantity - (Number(l.discount) || 0);
      byProduct.set(key, p);
      const sz = l.productSize || 'Bedensiz';
      bySize[sz] = (bySize[sz] || 0) + l.quantity;
    }
  }
  return {
    count: inRange.length, packages, revenue: Math.round(revenue * 100) / 100, units, byStatus,
    byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    topProducts: [...byProduct.values()].sort((a, b) => b.units - a.units).slice(0, 50),
    bySize,
  };
}

module.exports = { syncOrders, minimizeOrder, orderTime, fixOrderDates, dropPlaceholders, migrateOrderDates, orderStats, windows, STATUS_LABELS, NON_REVENUE, NEW_STATUSES, MAX_HISTORY_DAYS };
