'use strict';
// Kâr hesaplama çekirdeği. Ağ işlemi yapmaz; hem ana süreçte hem arayüzde kullanılır.
//
// Varsayılan ücretler — Trendyol satıcı panelinden (Ekim 2026):
//  - Kargo: resmi "Güncel Kargo Fiyatları" listesi (5 Ekim 2026, KDV hariç) + Barem Altı Uygulaması (10 Ağustos 2026)
//    → core/cargo-rates.js. Barem, termini 1 gün / Bugün Kargoda olan ve zamanında kargolanan siparişlerde daha ucuzdur.
//  - Komisyon: panel "KDV Dahil Komisyon Oranı" der → KDV dahil satış fiyatı × oran, KDV tutarın içinde.
//  - Platform hizmet bedeli: satıcının faturalarında gönderi başı 10,99 TL + KDV (13,19 TL).
//  - E-ticaret stopajı: %1 (KDV hariç satış tutarı üzerinden, ödemeden kesilir; yıllık vergiden mahsup edilir)
// Komisyon oranı ürün bazında Trendyol API'sinden gelir.
const { OFFICIAL_RATES, OFFICIAL_BAREM, desiPrice } = require('./cargo-rates');
const { orderTime } = require('./orders');

const DEFAULT_PROFIT_SETTINGS = {
  vatRegistered: true, // KDV mükellefi: kâr KDV hariç tutarlardan hesaplanır, ödenecek KDV ayrıca gösterilir
  commissionBase: 'gross', // 'gross': KDV dahil fiyat × oran (KDV içinde, panelde böyle) | 'net_plus_vat': KDV hariç fiyat × oran + %20 KDV
  serviceFee: 10.99, // KDV hariç, gönderi başı (standart)
  serviceFeeFast: 4.99, // KDV hariç; "Bugün Kargoda" etiketiyle gelip aynı gün kargolanan gönderilerde (faturalarda 5,99 ₺ KDV dahil)
  sameDayCutoff: '14:00', // "Bugün Kargoda" son sipariş saati (panel: Termin & Hızlı Kargolama, 11:00–15:00); '' = etiket kullanılmıyor
  vatCreditUsable: false, // devreden KDV'yi kâra say (giyimde %10 satış KDV'si < %20 gider KDV'si olduğundan genelde birikir, nakde dönmez)
  cargoMode: 'official', // 'official': Trendyol resmi listesi + barem | 'custom': kendi anlaşmam (aşağıdaki tablolar)
  carrier: 'TEX',
  fastShipping: 'auto', // 'auto': siparişte termin ≤ 1 iş günü ve zamanında kargolandıysa hızlı barem (ürün hesabında: ürünün/mağazanın termini) | 'always' | 'never'
  stopajPct: 1,
  packaging: 0, // gönderi başı ambalaj/ek gider, KDV dahil
  defaultVat: 10,
  costVat: null, // null: alış KDV oranı satış KDV oranıyla aynı
  defaultDesi: 1,
  // Yalnızca cargoMode = 'custom' iken kullanılır
  barem: [{ max: 200, fee: 73.33 }, { max: 350, fee: 78.74 }],
  baremMaxDesi: 10,
  desiTable: [81.95, 81.95, 81.95, 100.2, 107.2, 114.1, 125.6, 133.41, 142.32, 150.64, 164.18],
  extraPerDesi: 9.24,
  targetMargin: 15,
  lowMargin: 10,
};
const SERVICE_VAT = 0.2;

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function normalizeProfitSettings(s) {
  const d = DEFAULT_PROFIT_SETTINGS;
  const o = { ...d, ...(s || {}) };
  for (const k of ['serviceFee', 'serviceFeeFast', 'stopajPct', 'packaging', 'defaultVat', 'defaultDesi', 'baremMaxDesi', 'extraPerDesi', 'targetMargin', 'lowMargin']) {
    const n = num(o[k]);
    o[k] = n == null || n < 0 ? d[k] : n;
  }
  o.costVat = num(o.costVat);
  o.vatRegistered = o.vatRegistered !== false;
  o.vatCreditUsable = o.vatCreditUsable === true;
  o.commissionBase = o.commissionBase === 'net_plus_vat' ? 'net_plus_vat' : 'gross';
  o.cargoMode = o.cargoMode === 'custom' ? 'custom' : 'official';
  o.fastShipping = ['auto', 'always', 'never'].includes(o.fastShipping) ? o.fastShipping : 'auto';
  o.sameDayCutoff = o.sameDayCutoff === '' || o.sameDayCutoff === null ? '' : /^(0?\d|1\d|2[0-3]):[0-5]\d$/.test(String(o.sameDayCutoff)) ? String(o.sameDayCutoff).padStart(5, '0') : d.sameDayCutoff;
  o._sameDayShare = s && Number.isFinite(s._sameDayShare) ? Math.min(1, Math.max(0, s._sameDayShare)) : null;
  o.carrier = typeof o.carrier === 'string' && o.carrier ? o.carrier : 'TEX';
  o._storeFast = s && typeof s._storeFast === 'boolean' ? s._storeFast : null;
  o._rates = s && s._rates && Array.isArray(s._rates.carriers) ? s._rates : OFFICIAL_RATES;
  o.barem = (Array.isArray(o.barem) ? o.barem : d.barem).map((t) => ({ max: num(t.max), fee: num(t.fee) })).filter((t) => t.max > 0 && t.fee >= 0).sort((a, b) => a.max - b.max);
  o.desiTable = (Array.isArray(o.desiTable) && o.desiTable.length ? o.desiTable : d.desiTable).map((x, i) => { const n = num(x); return n == null || n < 0 ? d.desiTable[i] ?? 0 : n; });
  return o;
}

/** Gönderi başı kargo ücreti (KDV hariç). orderAmount: KDV dahil sipariş tutarı; fast: hızlı kargolama barem fiyatı. */
function cargoFee(orderAmount, desi, s, fast = false) {
  const d = Math.max(0, Math.ceil(Number(desi) || 0));
  if (s.cargoMode === 'official') {
    const B = OFFICIAL_BAREM;
    const fees = (fast ? B.fast : B.slow)[s.carrier];
    if (fees && d <= B.maxDesi) {
      const ti = B.tiers.findIndex((max) => orderAmount < max);
      if (ti >= 0) return { fee: fees[ti], label: `Barem ${ti === 0 ? '0–199,99' : '200–349,99'} ₺ · ${fast ? 'hızlı kargolama' : 'standart'}`, barem: true, fast };
    }
    const p = desiPrice(s._rates, s.carrier, d);
    if (p != null) return { fee: p, label: `${s.carrier} · ${d} desi` };
  }
  if (d <= s.baremMaxDesi && s.barem.length) {
    const tier = s.barem.find((t) => orderAmount < t.max);
    if (tier) return { fee: tier.fee, label: `Barem (${tier.max.toLocaleString('tr-TR')} ₺ altı)`, barem: true };
  }
  const t = s.desiTable;
  if (d < t.length) return { fee: t[d], label: `${d} desi` };
  return { fee: r2(t[t.length - 1] + (d - (t.length - 1)) * s.extraPerDesi), label: `${d} desi` };
}

// Öncelik: ayar (hep/hiç) → siparişten çıkarılan durum (it.fast) → ürünün termini → mağazanın son siparişlerdeki termini
const isFast = (it, s) => {
  if (s.fastShipping === 'always') return true;
  if (s.fastShipping === 'never') return false;
  if (it.fast != null) return !!it.fast;
  const dd = num(it.deliveryDuration);
  if (dd != null) return dd <= 1;
  return s._storeFast === true;
};

// ---- Sipariş bazında hızlı kargolama (barem Tablo 1) ----
// Trendyol: termini 1 gün olan ve zamanında (agreedDeliveryDate'e kadar) kargoya verilen siparişler hızlı tablodan ücretlendirilir.
// Cumartesi akşamı/Pazar gelen siparişin termini Pazartesi olur; Pazar kargo günü sayılmadığından bu da 1 iş günüdür.
const { IST, istDate, isWorkday, workdaysBetween } = require('./calendar');
const SHIPPED_LIKE = new Set(['Shipped', 'Delivered', 'AtCollectionPoint', 'UnDelivered', 'UnDeliveredAndReturned', 'Returned']);
const istMinutes = (ms) => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const cutoffMinutes = (c) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(c || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/** Bugün Kargoda etiketi yalnızca hafta içi (Pzt–Cum, resmi tatil hariç) ve son sipariş saatinden önce görünür. */
function sameDayEligible(placed, cutoff) {
  const cm = cutoffMinutes(cutoff);
  if (cm == null) return false;
  const day = istDate(placed);
  const wd = new Date(day + 'T00:00:00Z').getUTCDay();
  return wd >= 1 && wd <= 5 && isWorkday(day) && istMinutes(placed) < cm;
}
/**
 * Siparişin kargo/hizmet bedeli sınıfı.
 *  fast    → barem Tablo 1 (termin ≤ 1 iş günü ve zamanında kargolandı / henüz süresi dolmadı)
 *  sameDay → Bugün Kargoda indirimi (etiket saatinden önce, hafta içi gelip AYNI GÜN kargolandı); null: bugün kargolanırsa
 * @returns {{ fast: boolean, sameDay: boolean|null, reason: string, kind: 'today'|'fast'|'slow', terminDays: number }|null}
 */
function orderFastInfo(o, now = Date.now(), cutoff = DEFAULT_PROFIT_SETTINGS.sameDayCutoff) {
  const placed = orderTime(o);
  const due = num(o && o.agreedDeliveryDate);
  if (placed == null || due == null) return null;
  const terminDays = workdaysBetween(istDate(placed), istDate(due));
  const shippedAt = (o.history || []).filter((h) => h && h.status === 'Shipped').map((h) => num(h.date)).filter((t) => t != null).sort((a, b) => a - b)[0];
  const shipped = shippedAt != null || SHIPPED_LIKE.has(o.status);
  const eligible = sameDayEligible(placed, cutoff);
  let sameDay = false;
  if (eligible) {
    if (shippedAt != null) sameDay = istDate(shippedAt) === istDate(placed);
    else if (shipped) sameDay = false; // kargo zamanı bilinmiyor: indirim varsayılmaz
    else sameDay = istDate(now) === istDate(placed) ? null : false;
  }
  const kind = eligible ? 'today' : terminDays <= 1 ? 'fast' : 'slow';
  if (terminDays > 1) return { fast: false, sameDay, reason: 'termin', kind, terminDays };
  if (shippedAt != null) return { fast: shippedAt <= due, sameDay, reason: shippedAt <= due ? 'onTime' : 'late', kind, terminDays };
  if (shipped) return { fast: true, sameDay, reason: 'onTime', kind, terminDays }; // kargo zamanı kayıtlı değil
  if (now > due) return { fast: false, sameDay, reason: 'late', kind, terminDays };
  return { fast: true, sameDay, reason: 'pending', kind, terminDays };
}
function fastNoteOf(fi) {
  if (!fi) return null;
  const tag = fi.kind === 'today' ? 'Bugün Kargoda' : fi.kind === 'fast' ? 'Hızlı teslimat' : 'Termin 1 günden uzun';
  if (fi.reason === 'termin') return tag;
  if (fi.reason === 'late') return tag + ' · termin geçti';
  if (fi.kind === 'today') {
    if (fi.sameDay === true) return tag + ' · aynı gün kargolandı';
    if (fi.sameDay === null) return tag + ' · bugün kargolanırsa';
    return tag + ' · ertesi gün kargolandı (indirim yok)';
  }
  return tag + (fi.reason === 'pending' ? ' · termine kadar kargolanırsa' : ' · zamanında kargolandı');
}

/** Son siparişlerin çoğu 1 iş günü terminliyse mağaza "hızlı" sayılır (ürün termini API'de gelmediğinde ürün hesapları için). */
function inferStoreFast(orders) {
  let n = 0, fast = 0;
  for (const o of orders || []) {
    const placed = orderTime(o), due = num(o && o.agreedDeliveryDate);
    if (placed == null || due == null) continue;
    n++;
    if (workdaysBetween(istDate(placed), istDate(due)) <= 1) fast++;
  }
  return n >= 5 ? fast / n >= 0.8 : null;
}
/** Son siparişlerde Bugün Kargoda indirimini alan paketlerin oranı (ürün bazlı hesaplarda hizmet bedeli için). */
function inferSameDayShare(orders, cutoff, now = Date.now()) {
  if (!cutoffMinutes(cutoff)) return 0;
  let n = 0, yes = 0;
  for (const o of orders || []) {
    if (!o || EXCLUDED_ORDER_STATUS.has(o.status)) continue;
    const fi = orderFastInfo(o, now, cutoff);
    if (!fi || fi.sameDay === null) continue;
    n++; if (fi.sameDay) yes++;
  }
  return n >= 5 ? yes / n : null;
}

/**
 * Bir gönderinin (paket) kâr dökümü.
 * items: [{ price (KDV dahil satır tutarı), commissionPct, vatPct, cost (KDV dahil toplam alış), desi (toplam), costVatPct? }]
 * Komisyon oranı veya maliyet eksikse profit null döner ve missing alanı doldurulur.
 */
function calcShipment(items, settings) {
  const s = normalizeProfitSettings(settings);
  const missing = new Set();
  let price = 0, netSale = 0, saleVat = 0, commissionNet = 0, commissionVat = 0, costNet = 0, costVat = 0, desi = 0;
  for (const it of items) {
    const P = Number(it.price) || 0;
    const v = (num(it.vatPct) ?? s.defaultVat) / 100;
    const rate = num(it.commissionPct);
    if (rate == null) missing.add('commission');
    const cost = num(it.cost);
    if (cost == null) missing.add('cost');
    const cv = (num(it.costVatPct) ?? s.costVat ?? (num(it.vatPct) ?? s.defaultVat)) / 100;
    const S = P / (1 + v);
    price += P; netSale += S; saleVat += P - S;
    if (rate != null) {
      if (s.commissionBase === 'gross') { const tot = Math.round(P * rate + 1e-7) / 100; /* Trendyol komisyonu kuruşa yuvarlar */ commissionNet += tot / (1 + SERVICE_VAT); commissionVat += tot - tot / (1 + SERVICE_VAT); }
      else { const n = S * rate / 100; commissionNet += n; commissionVat += n * SERVICE_VAT; }
    }
    if (cost != null) { costNet += cost / (1 + cv); costVat += cost - cost / (1 + cv); }
    desi += num(it.desi) ?? s.defaultDesi;
  }
  const fast = items.length > 0 && items.every((it) => isFast(it, s));
  const info = items.find((it) => it.fastInfo) ? items.find((it) => it.fastInfo).fastInfo : null;
  const fastNote = s.fastShipping === 'auto' ? fastNoteOf(info) : null;
  const cargo = cargoFee(price, desi, s, fast);
  const cargoNet = cargo.fee, cargoVat = cargo.fee * SERVICE_VAT;
  // Platform hizmet bedeli: Bugün Kargoda (aynı gün kargolanan) gönderide indirimli. Sipariş bilinmiyorsa mağazanın son siparişlerindeki orana göre ortalama.
  const itemSameDay = items.find((it) => typeof it.sameDay === 'boolean');
  let sameDay = info ? info.sameDay !== false : itemSameDay ? itemSameDay.sameDay : null;
  if (info && !cutoffMinutes(s.sameDayCutoff)) sameDay = false;
  const serviceNet = sameDay != null ? (sameDay ? s.serviceFeeFast : s.serviceFee)
    : s._sameDayShare != null && cutoffMinutes(s.sameDayCutoff) ? s._sameDayShare * s.serviceFeeFast + (1 - s._sameDayShare) * s.serviceFee : s.serviceFee;
  const serviceVat = serviceNet * SERVICE_VAT;
  const packGross = s.packaging, packNet = packGross / (1 + SERVICE_VAT), packVat = packGross - packNet;
  const stopaj = netSale * s.stopajPct / 100;
  const trendyolDeductions = commissionNet + commissionVat + cargoNet + cargoVat + serviceNet + serviceVat;
  const orderPayout = price - trendyolDeductions; // sipariş detayındaki 'Ödenecek' tutar
  const payout = orderPayout - stopaj; // stopaj cari hesaptan ayrıca kesilir
  const vatPayable = saleVat - commissionVat - cargoVat - serviceVat - costVat - packVat;
  let profit = null, marginPct = null, markupPct = null, vatCreditIgnored = 0;
  if (!missing.size) {
    profit = s.vatRegistered
      ? netSale - commissionNet - cargoNet - serviceNet - costNet - packNet
      : price - (commissionNet + commissionVat) - (cargoNet + cargoVat) - (serviceNet + serviceVat) - (costNet + costVat) - packGross;
    // Devreden KDV (negatif ödenecek KDV) nakde dönmüyorsa kâra sayılmaz → kâr = elde kalan nakit
    if (s.vatRegistered && vatPayable < 0 && !s.vatCreditUsable) { vatCreditIgnored = -vatPayable; profit += vatPayable; }
    const base = s.vatRegistered ? netSale : price;
    marginPct = base > 0 ? r2((profit / base) * 100) : null;
    const cb = s.vatRegistered ? costNet : costNet + costVat;
    markupPct = cb > 0 ? r2((profit / cb) * 100) : null;
    profit = r2(profit);
  }
  return {
    price: r2(price), netSale: r2(netSale), saleVat: r2(saleVat),
    commission: r2(commissionNet + commissionVat), commissionNet: r2(commissionNet), commissionVat: r2(commissionVat),
    cargo: r2(cargoNet + cargoVat), cargoNet: r2(cargoNet), cargoLabel: cargo.label, cargoBarem: !!cargo.barem, fast, fastNote, sameDay, fastKind: info ? info.kind : null,
    service: r2(serviceNet + serviceVat), serviceNet: r2(serviceNet),
    cost: r2(costNet + costVat), costNet: r2(costNet), costVat: r2(costVat),
    packaging: r2(packGross), stopaj: r2(stopaj), orderPayout: r2(orderPayout), payout: r2(payout), vatPayable: r2(vatPayable), vatCreditIgnored: r2(vatCreditIgnored),
    profit, marginPct, markupPct, missing: [...missing], vatRegistered: s.vatRegistered,
  };
}

const calcProfit = (item, settings) => calcShipment([item], settings);

/**
 * Hedef marjı (KDV hariç satışa göre %) sağlayan en düşük satış fiyatı. marginPct=0 → başabaş fiyatı.
 * Kâr, barem aralıkları içinde fiyatla doğrusaldır; her aralık ayrı çözülür.
 */
function priceForMargin(item, settings, marginPct = 0) {
  const s = normalizeProfitSettings(settings);
  if (num(item.cost) == null || num(item.commissionPct) == null) return null;
  const m = (Number(marginPct) || 0) / 100;
  const f = (P) => {
    const r = calcShipment([{ ...item, price: P }], s);
    return r.profit - m * (s.vatRegistered ? r.netSale : r.price);
  };
  const desi = num(item.desi) ?? s.defaultDesi;
  const breaks = s.cargoMode === 'official'
    ? (Math.ceil(desi) <= OFFICIAL_BAREM.maxDesi ? OFFICIAL_BAREM.tiers.slice() : [])
    : (Math.ceil(desi) <= s.baremMaxDesi ? s.barem.map((t) => t.max) : []);
  const segs = [0, ...breaks, Infinity];
  for (let i = 0; i < segs.length - 1; i++) {
    const lo = segs[i], hi = segs[i + 1];
    const x0 = lo, x1 = Number.isFinite(hi) ? Math.min(lo + 1, (lo + hi) / 2) : lo + 1;
    const f0 = f(x0), f1 = f(x1);
    const a = (f1 - f0) / (x1 - x0);
    if (f0 >= 0) return r2(Math.max(lo, 0.01));
    if (a <= 0) continue;
    const p = x0 - f0 / a;
    if (p < hi) {
      let c = Math.ceil(p * 100) / 100;
      while (f(c) < -1e-9 && c < hi) c = r2(c + 0.01);
      if (c < hi) return c;
    }
  }
  return null;
}

/** Varyant için maliyet/desi: önce barkoda özel değer, yoksa model (productMainId) değeri. */
function resolveCost(v, costs) {
  const c = costs || {};
  const b = (c.barcodes || {})[v.barcode] || {};
  const m = (c.models || {})[v.productMainId] || {};
  return { cost: num(b.cost) ?? num(m.cost), desi: num(b.desi) ?? num(m.desi), source: num(b.cost) != null ? 'barcode' : num(m.cost) != null ? 'model' : null };
}

function variantProfit(v, costs, settings, price) {
  const rc = resolveCost(v, costs);
  const item = { price: price != null ? price : v.salePrice, commissionPct: v.commission, vatPct: v.vatRate, cost: rc.cost, desi: rc.desi, deliveryDuration: v.deliveryDuration };
  return { ...calcProfit(item, settings), item, costSource: rc.source };
}

/** Siparişlerden gerçekleşen kâr (paket başına bir kargo + bir hizmet bedeli). */
function dayKey(d) {
  if (d == null || d === '') return null;
  const t = new Date(typeof d === 'number' || /^\d+$/.test(String(d)) ? Number(d) : d);
  if (!Number.isFinite(t.getTime())) return null;
  try { return t.toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' }); } catch (_) { return t.toISOString().slice(0, 10); }
}
const EXCLUDED_ORDER_STATUS = new Set(['Cancelled', 'UnSupplied', 'Returned', 'UnDelivered']);
const LINE_EXCLUDED = /Cancel|UnSupplied|Return/i;

/**
 * Bir sipariş paketinin kâr hesabı kalemleri. Hızlı kargolama durumu siparişin kendi termin/kargo bilgisinden gelir.
 * @returns {{ items: object[], missingBarcodes: string[] }}
 */
function orderShipmentItems(o, variantsByBarcode, costs, settings, { now = Date.now(), ignoreCost = false } = {}) {
  const s = normalizeProfitSettings(settings);
  const fi = orderFastInfo(o, now, s.sameDayCutoff);
  const items = [], missingBarcodes = [];
  for (const l of (o && o.lines) || []) {
    if (l.status && LINE_EXCLUDED.test(l.status)) continue;
    const v = (variantsByBarcode && variantsByBarcode.get(String(l.barcode))) || { barcode: String(l.barcode) };
    const rc = resolveCost(v, costs);
    const qty = Number(l.quantity) || 1;
    if (!ignoreCost && rc.cost == null) missingBarcodes.push(String(l.barcode));
    items.push({
      price: (Number(l.unitPrice) || 0) * qty - (Number(l.discount) || 0),
      commissionPct: num(l.commission) ?? v.commission ?? null,
      vatPct: v.vatRate,
      cost: ignoreCost ? 0 : rc.cost == null ? null : rc.cost * qty,
      desi: (rc.desi ?? s.defaultDesi) * qty,
      deliveryDuration: v.deliveryDuration,
      ...(fi ? { fast: fi.fast, fastInfo: fi } : {}),
    });
  }
  return { items, missingBarcodes };
}

/**
 * Bir paketten henüz kesilmemiş tahmini Trendyol kesintileri (kargo + platform hizmet bedeli + stopaj, KDV dahil).
 * Hakediş takviminde satış tutarından düşülür. Sipariş yerelde yoksa cari hesap satırlarından hesaplanır.
 */
function estimatePackageFees({ order, records, variantsByBarcode, costs, settings, now = Date.now() }) {
  const s = normalizeProfitSettings(settings);
  let items;
  if (order) items = orderShipmentItems(order, variantsByBarcode, costs, s, { now, ignoreCost: true }).items;
  else {
    items = (records || []).map((x) => {
      const v = (variantsByBarcode && variantsByBarcode.get(String(x.barcode))) || {};
      const rc = resolveCost(v, costs);
      return { price: Number(x.credit) || 0, commissionPct: num(x.commissionRate) ?? v.commission ?? 0, vatPct: v.vatRate, cost: 0, desi: rc.desi ?? s.defaultDesi, deliveryDuration: v.deliveryDuration };
    });
  }
  if (!items || !items.length) return null;
  const r = calcShipment(items, s);
  return r2(r.cargo + r.service + r.stopaj);
}

function ordersProfit(orders, variantsByBarcode, costs, settings, { now = Date.now() } = {}) {
  const s = normalizeProfitSettings(settings);
  const out = { packages: 0, revenue: 0, profit: 0, payout: 0, missingCost: 0, missingBarcodes: new Set(), byDay: {} };
  for (const o of orders || []) {
    if (EXCLUDED_ORDER_STATUS.has(o.status)) continue;
    const { items, missingBarcodes } = orderShipmentItems(o, variantsByBarcode, costs, s, { now });
    for (const b of missingBarcodes) out.missingBarcodes.add(b);
    const miss = missingBarcodes.length > 0;
    if (!items.length) continue;
    out.packages++;
    const r = calcShipment(items, s);
    out.revenue += r.price;
    out.payout += r.payout;
    if (miss || r.profit == null) { out.missingCost++; continue; }
    out.profit += r.profit;
    const day = dayKey(orderTime(o));
    if (day) out.byDay[day] = r2((out.byDay[day] || 0) + r.profit);
  }
  out.revenue = r2(out.revenue); out.profit = r2(out.profit); out.payout = r2(out.payout);
  out.missingBarcodes = [...out.missingBarcodes];
  return out;
}

module.exports = { OFFICIAL_RATES, OFFICIAL_BAREM, DEFAULT_PROFIT_SETTINGS, normalizeProfitSettings, cargoFee, calcShipment, calcProfit, priceForMargin, resolveCost, variantProfit, ordersProfit, orderShipmentItems, estimatePackageFees, orderFastInfo, inferStoreFast, inferSameDayShare, workdaysBetween, isWorkday, istDate };
