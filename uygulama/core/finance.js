'use strict';
const cal = require('./calendar');
// Hakediş / cari hesap.
//  • Kesinti dökümü: Trendyol cari hesap ekstresi servisleri (settlements, otherfinancials) — yalnızca okuma.
//  • Yatacak tutarlar ve ödeme günleri: satıcı panelindeki "Ödemeler" ekranı (Trendyol'un kendi hesapladığı takvim).
//    Panel verisi yoksa API kayıtlarından vade tarihine göre kaba bir tahmin gösterilir.
// Gerçek veriyle doğrulandı (Ekim 2026): API transactionType alanını Türkçe etiketle döndürür ("Satış", "Kargo Fatura"...),
// bu yüzden istenen tür kodu ayrıca saklanır. Avrupa/Azerbaycan ödemeleri Türkiye'den ayrı takvimle yapılır.

const SETTLEMENT_TYPES = [
  'Sale', 'Return', 'Discount', 'DiscountCancel', 'Coupon', 'CouponCancel', 'ProvisionPositive', 'ProvisionNegative',
  'TyDiscount', 'TyDiscountCancel', 'TyCoupon', 'TyCouponCancel',
  'SellerRevenuePositive', 'SellerRevenueNegative', 'CommissionPositive', 'CommissionNegative',
  'SellerRevenuePositiveCancel', 'SellerRevenueNegativeCancel', 'CommissionPositiveCancel', 'CommissionNegativeCancel',
  'ManualRefund', 'ManualRefundCancel', 'DeliveryFee', 'DeliveryFeeCancel', 'PayByLink',
];
const OTHER_TYPES = ['Stoppage', 'CashAdvance', 'WireTransfer', 'IncomingTransfer', 'ReturnInvoice', 'CommissionAgreementInvoice', 'PaymentOrder', 'DeductionInvoices', 'FinancialItem'];
const KNOWN = new Set([...SETTLEMENT_TYPES, ...OTHER_TYPES]);
const PAYMENT_HISTORY_DAYS = 365;

// Eski kayıtlar (Türkçe etiketle saklanmış) için etiket → tür kodu
const LABEL_TO_TYPE = {
  'Satış': 'Sale', 'İade': 'Return', 'İndirim': 'Discount', 'İndirim İptal': 'DiscountCancel', 'Kupon': 'Coupon', 'Kupon İptal': 'CouponCancel',
  'Ödeme': 'PaymentOrder', 'E-ticaret Stopajı': 'Stoppage', 'Virman Ödemesi': 'WireTransfer', 'Erken Ödeme': 'CashAdvance',
};

const BUCKETS = [
  ['sales', 'Brüt satış'],
  ['returns', 'İadeler'],
  ['sellerDiscounts', 'İndirim ve kuponlar (sizin karşıladığınız)'],
  ['tySupport', 'Trendyol destekli indirim / kupon'],
  ['otherSale', 'Satış düzeltmeleri'],
  ['commission', 'Komisyon'],
  ['deduction_cargo', 'Kargo faturaları'],
  ['deduction_service', 'Platform hizmet bedeli'],
  ['deduction_intl', 'Uluslararası hizmet bedeli'],
  ['deduction_intl_return', 'Yurt dışı iade operasyon bedeli'],
  ['deduction_ads', 'Reklam'],
  ['deduction_penalty', 'Ceza / tazmin (tedarik edememe, yanlış ürün…)'],
  ['deduction_other', 'Diğer faturalar (e-fatura kontör vb.)'],
  ['stopaj', 'E-ticaret stopajı'],
  ['corrections', 'Diğer düzeltmeler'],
  ['advance', 'Erken ödeme (önceden alındı)'],
  ['transfers', 'Virman / transfer'],
];
const BUCKET_LABEL = Object.fromEntries(BUCKETS);
const REGIONS = { TR: 'Türkiye & Körfez', EU: 'Avrupa', AZ: 'Azerbaycan', COMMON: 'Faturalar (bölgesiz)' };
const EU_COUNTRIES = new Set(['romanya', 'bulgaristan', 'yunanistan', 'moldova', 'almanya', 'avusturya', 'hollanda', 'belçika', 'fransa', 'italya', 'ispanya', 'polonya', 'macaristan', 'çekya', 'slovakya', 'hırvatistan', 'slovenya', 'portekiz', 'irlanda', 'isveç', 'danimarka', 'finlandiya', 'litvanya', 'letonya', 'estonya', 'lüksemburg', 'kıbrıs', 'malta', 'isviçre']);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const numOr0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const toMs = (d) => (d == null || d === '' ? null : typeof d === 'number' ? d : /^\d+$/.test(String(d)) ? Number(d) : Date.parse(d) || null);
const lower = (s) => String(s || '').toLocaleLowerCase('tr-TR').trim();

function minimizeRecord(x, kind, requestedType) {
  return {
    id: String(x.id ?? ''), kind, type: requestedType || x.transactionType || null, label: x.transactionType || null, subType: x.transactionSubType || null,
    date: toMs(x.transactionDate), paymentDate: toMs(x.paymentDate), paymentOrderId: x.paymentOrderId ?? null, paymentPeriod: x.paymentPeriod ?? null,
    credit: x.credit ?? null, debt: x.debt ?? null, commissionRate: x.commissionRate ?? null, commissionAmount: x.commissionAmount ?? null, sellerRevenue: x.sellerRevenue ?? null,
    orderNumber: x.orderNumber != null ? String(x.orderNumber) : null, shipmentPackageId: x.shipmentPackageId ?? null, barcode: x.barcode != null ? String(x.barcode) : null,
    receiptId: x.receiptId ?? null, description: x.description ? String(x.description).slice(0, 200) : null,
    country: x.country || null, affiliate: x.affiliate || null, orderDate: toMs(x.orderDate),
  };
}

/** Eski/yeni kayıtları ortak biçime getirir (tür kodu + etiket). */
function normalizeRecord(r) {
  if (KNOWN.has(r.type)) return r.label ? r : { ...r, label: r.type };
  const label = r.label || r.type;
  const type = LABEL_TO_TYPE[label] || (r.kind === 'otherfinancials' ? 'DeductionInvoices' : 'SellerRevenuePositive');
  return { ...r, type, label };
}

/**
 * Kayıtları 14 günlük pencerelerle, her işlem türü için ayrı ayrı çeker (eşzamanlı, hız sınırına uyarak).
 * Önceki senkron 7 günden yeniyse yalnızca son 42 gün yeniden okunur; daha eskiler korunur.
 */
async function syncFinance(client, store, { days = 70, now = Date.now(), onProgress, concurrency = 6, full = false } = {}) {
  const prev = store.get('finance', null);
  const incremental = !full && prev && prev.syncedAt && now - Date.parse(prev.syncedAt) < 7 * 86400000 && Array.isArray(prev.records) && prev.version === 2;
  const fetchDays = incremental ? Math.min(42, days) : days;
  const from = now - fetchDays * 86400000;
  const windows = [];
  const step = 14 * 86400000;
  for (let end = now; end > from; end -= step) windows.push([Math.max(end - step, from), end]);
  const jobs = [];
  for (const t of SETTLEMENT_TYPES) for (const w of windows) jobs.push(['settlements', t, w]);
  for (const t of OTHER_TYPES) for (const w of windows) jobs.push(['otherfinancials', t, w]);
  // Geçmiş aylardaki ödemeler: yalnızca ödeme talimatları (PaymentOrder) son 1 yıl için ayrıca okunur (az istek).
  // Haftada bir yenilenir; okunamazsa (Trendyol eski tarihe izin vermezse) hakediş senkronu bozulmaz.
  const histFrom = now - PAYMENT_HISTORY_DAYS * 86400000;
  const needHist = full || !prev || !Array.isArray(prev.paymentHistory) || !prev.paymentHistoryAt || now - Date.parse(prev.paymentHistoryAt) > 7 * 86400000;
  if (needHist) for (let end = from; end > histFrom; end -= step) jobs.push(['otherfinancials', 'PaymentOrder', [Math.max(end - step, histFrom), end], true]);
  const histByKey = new Map();
  let histFailed = false;
  const byKey = new Map();
  const keyOf = (rec) => rec.kind + ':' + rec.type + ':' + rec.id + ':' + (rec.receiptId ?? '') + ':' + (rec.barcode ?? '');
  if (incremental) for (const r of prev.records) if (r.date != null && r.date < from && r.date >= now - days * 86400000) byKey.set(keyOf(r), r);
  const errors = [];
  const badTypes = new Set();
  let done = 0, next = 0, fatal = null;
  const worker = async () => {
    while (next < jobs.length && !fatal) {
      const [kind, type, [startDate, endDate], hist] = jobs[next++];
      try {
        if (hist && histFailed) { /* geçmiş okunamıyor: kalan geçmiş isteklerini atla */ }
        else if (!badTypes.has(type)) {
          for (let page = 0; page < 200; page++) {
            const res = await client.getFinance(kind, { transactionType: type, startDate, endDate, page, size: 1000 });
            const content = (res && res.content) || [];
            for (const x of content) { const rec = minimizeRecord(x, kind, type); (hist ? histByKey : byKey).set(keyOf(rec), rec); }
            const totalPages = res && Number.isFinite(res.totalPages) ? res.totalPages : 1;
            if (page + 1 >= totalPages || !content.length) break;
          }
        }
      } catch (e) {
        if (hist) histFailed = true; // geçmiş ödemeler isteğe bağlıdır; hata senkronu durdurmaz
        else if (e && (e.kind === 'bad_request' || e.kind === 'not_found')) { if (!badTypes.has(type)) { badTypes.add(type); errors.push({ type, message: e.message }); } }
        else fatal = e;
      }
      done++;
      if (onProgress && (done % 5 === 0 || done === jobs.length)) onProgress({ stage: 'finance', done, total: jobs.length });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (fatal) { if (onProgress) onProgress({ stage: 'done' }); throw fatal; }
  // Ödeme geçmişi: önceki geçmiş + yeni okunan + son kayıtlardaki ödemeler (ödeme no ile tekilleştirilir)
  const hmap = new Map();
  for (const h of (prev && Array.isArray(prev.paymentHistory) ? prev.paymentHistory : [])) if (h && h.date >= histFrom) hmap.set(String(h.id), h);
  for (const r of [...histByKey.values(), ...byKey.values()]) { const pmt = paymentOf(r); if (pmt) hmap.set(String(pmt.id), pmt); }
  const histOk = needHist && !histFailed;
  const data = { version: 2, syncedAt: new Date(now).toISOString(), from: now - days * 86400000, to: now, records: [...byKey.values()], errors, incremental: !!incremental,
    paymentHistory: [...hmap.values()].sort((a, b) => b.date - a.date),
    paymentHistoryAt: histOk ? new Date(now).toISOString() : (prev && prev.paymentHistoryAt) || null,
    paymentHistoryFrom: histOk ? histFrom : (prev && prev.paymentHistoryFrom) || now - days * 86400000 };
  store.set('finance', data);
  if (onProgress) onProgress({ stage: 'done' });
  return { records: data.records.length, errors: errors.length, requests: jobs.length };
}

/** Ödeme talimatı kaydını sade ödeme satırına çevirir (banka hesabına aktarılan tutar). */
function paymentOf(r) {
  if (!r || r.type !== 'PaymentOrder') return null;
  const date = toMs(r.paymentDate) || toMs(r.date);
  if (date == null) return null;
  return { id: r.paymentOrderId || r.id, date, amount: r2(-(numOr0(r.credit) - numOr0(r.debt))), region: r.affiliate === 'TRENDYOLAZJV' ? 'AZ' : null };
}

function regionOf(rec) {
  if (rec.affiliate === 'TRENDYOLAZJV' || lower(rec.country) === 'azerbaycan') return { region: 'AZ', country: 'Azerbaycan' };
  const c = String(rec.country || '').trim();
  if (EU_COUNTRIES.has(lower(c))) return { region: 'EU', country: c };
  // Fatura kayıtlarında ülke alanı hep satıcının ülkesi (Türkiye) geliyor; bölgeye ayrılamaz
  if (rec.kind === 'otherfinancials' && rec.type !== 'PaymentOrder') return { region: 'COMMON', country: null };
  return { region: 'TR', country: c || 'Türkiye' };
}

function deductionBucket(rec) {
  const b = bucketFromText(lower((rec.label || '') + ' ' + (rec.subType || '')));
  if (b !== 'deduction_other' || !rec.description) return b;
  const d = bucketFromText(lower(rec.description));
  return d === null ? 'deduction_other' : d;
}
function bucketFromText(t) {
  if (/komisyon fatura/.test(t)) return null; // bilgilendirme: komisyon satış kayıtlarında zaten düşülüyor
  if (/kargo|cargo|desi/.test(t)) return 'deduction_cargo';
  if (/uluslararası hizmet/.test(t)) return 'deduction_intl';
  if (/yurtdışı operasyon|yurt dışı operasyon/.test(t)) return 'deduction_intl_return';
  if (/platform hizmet|platformservice/.test(t)) return 'deduction_service';
  if (/reklam|ads/.test(t)) return 'deduction_ads';
  if (/tedarik edememe|yanlış ürün|ceza|tazmin|ihlal|gecikme/.test(t)) return 'deduction_penalty';
  return 'deduction_other';
}

/** Bir kaydın cari hesaba etkileri: [{bucket, amount}] (pozitif = satıcının alacağı artar). Bilgi amaçlı kayıtlar için []. */
function effects(rec0) {
  const rec = normalizeRecord(rec0);
  const g = numOr0(rec.credit) - numOr0(rec.debt);
  const sign = g > 0 ? 1 : g < 0 ? -1 : (numOr0(rec.sellerRevenue) < 0 ? -1 : 1);
  const t = rec.type || '';
  if (rec.kind === 'settlements') {
    if (/^Commission/.test(t)) return [{ bucket: 'commission', amount: g }];
    const bucket = t === 'Sale' ? 'sales' : t === 'Return' ? 'returns' : /^(Discount|Coupon)/.test(t) ? 'sellerDiscounts' : /^Ty(Discount|Coupon)/i.test(t) ? 'tySupport'
      : /^SellerRevenue/.test(t) ? 'corrections' : 'otherSale';
    const out = [{ bucket, amount: g }];
    const ca = Number(rec.commissionAmount);
    if (Number.isFinite(ca) && ca !== 0) out.push({ bucket: 'commission', amount: -sign * Math.abs(ca) });
    else if (rec.sellerRevenue != null && g !== 0) {
      const net = sign * Math.abs(Number(rec.sellerRevenue));
      if (Number.isFinite(net) && Math.abs(net - g) > 0.005) out.push({ bucket: 'commission', amount: net - g });
    }
    return out;
  }
  if (t === 'Stoppage') return [{ bucket: 'stopaj', amount: g }];
  if (t === 'DeductionInvoices' || t === 'CommissionAgreementInvoice') { const b = deductionBucket(rec); return b ? [{ bucket: t === 'CommissionAgreementInvoice' && b === 'deduction_other' ? 'commission' : b, amount: g }] : []; }
  if (t === 'CashAdvance') return [{ bucket: 'advance', amount: g }];
  if (t === 'WireTransfer' || t === 'IncomingTransfer') return [{ bucket: 'transfers', amount: g }];
  if (t === 'PaymentOrder') return [{ bucket: 'payment', amount: g }];
  return [{ bucket: 'corrections', amount: g }];
}

/** Sıradaki ödeme günü: o günkü tüm bölgelerin toplamı ve dökümü (ör. Türkiye + Azerbaycan aynı gün). */
function nextDayOf(upcoming) {
  const first = upcoming.find((u) => u.amount > 0);
  if (!first) return null;
  const parts = upcoming.filter((u) => u.date === first.date && Math.abs(u.amount) >= 0.005);
  return { date: first.date, amount: r2(parts.reduce((a, u) => a + u.amount, 0)), parts, estimated: parts.some((u) => u.estimated), source: first.source || 'api' };
}

function monthRange(now, offset = 0) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + offset + 1, 1).getTime() - 1;
  const label = new Date(start).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
  return { start, end, label };
}
const dayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** İlk pazartesi veya perşembe (Trendyol Türkiye ödeme günleri) — tahmin için. */
function nextPayDay(ms) {
  let d = new Date(dayStart(ms));
  for (let i = 0; i < 7 && ![1, 4].includes(d.getDay()); i++) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return d.getTime();
}
/** Ayın 4. pazartesisi (Avrupa ödeme günü, panelde 26.10 / 23.11 / 28.12.2026) — tahmin için. */
function fourthMonday(y, m) { const first = new Date(y, m, 1); const add = (8 - first.getDay()) % 7; return new Date(y, m, 1 + add + 21).getTime(); }
function nextEuPayDay(ms) { const d = new Date(ms); let t = fourthMonday(d.getFullYear(), d.getMonth()); if (t < dayStart(ms)) t = fourthMonday(d.getFullYear(), d.getMonth() + 1); return t; }

/**
 * Satıcı paneli › Ödemeler ekranı metnini çözer.
 * "Toplam Güncel Bakiye\n52.857,94₺" ve "<tutar>₺\n(Sıradaki Ödeme|Ödeme Günü): gg/aa/yyyy\n<Bölge>\nTahmini Hesaplanmıştır"
 */
function parsePaymentDashboard(text) {
  const t = String(text || '').replace(/\r/g, '');
  const money = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
  const bal = /Toplam Güncel Bakiye\s*\n\s*(-?[\d.]+,\d{2})\s*₺/.exec(t);
  const early = /([\d.]+,\d{2})\s*₺\s*Bakiyeni Al/.exec(t);
  const items = [];
  const re = /(-?[\d.]+,\d{2})\s*₺\s*\n\s*(Sıradaki Ödeme|Ödeme Günü)\s*:\s*(\d{2})\/(\d{2})\/(\d{4})\s*\n\s*([^\n]+?)\s*\n\s*(Tahmini Hesaplanmıştır)?/g;
  let m;
  while ((m = re.exec(t))) {
    const name = m[6].trim();
    const region = /avrupa/i.test(name) ? 'EU' : /azerbaycan/i.test(name) ? 'AZ' : 'TR';
    items.push({ date: new Date(Number(m[5]), Number(m[4]) - 1, Number(m[3])).getTime(), regionName: name, region, amount: money(m[1]), estimated: !!m[7], next: m[2] === 'Sıradaki Ödeme' });
  }
  if (!bal && !items.length) return null;
  return { balance: bal ? money(bal[1]) : null, earlyAvailable: early ? money(early[1]) : null, items };
}

function emptyBuckets() { return Object.fromEntries(BUCKETS.map(([k]) => [k, 0])); }
const ESTIMATE_STATUSES = new Set(['Created', 'ReadyToShip', 'Picking', 'Invoiced', 'Shipped', 'AtCollectionPoint', 'Delivered']);

/**
 * Özet (offset 0 = bu ay, 1 = gelecek ay):
 *  - paid: ay içinde yapılmış ödemeler (API "Ödeme" kayıtları)
 *  - upcoming: panel takvimi (varsa) yoksa API tahmini
 *  - activity: ay içindeki hareketlerin kalem kalem dökümü, bölgelere göre
 */
function summarizeFinance(data, { now = Date.now(), offset = 0, orders = null, estimateFn = null, panel = null, packageFees = null } = {}) {
  const recs = ((data && data.records) || []).map(normalizeRecord);
  const feePkgs = new Set();
  const periods0 = recs.filter((r) => r.type === 'Sale' && Number.isFinite(Number(r.paymentPeriod))).map((r) => Number(r.paymentPeriod)).sort((a, b) => a - b);
  const period0 = periods0.length ? periods0[Math.floor(periods0.length / 2)] : 28;
  const m = monthRange(now, offset);
  const act = { TR: emptyBuckets(), EU: emptyBuckets(), AZ: emptyBuckets(), COMMON: emptyBuckets() };
  const countries = {};
  const payments = [];
  const deductionDetail = new Map();
  const apiUpcoming = new Map();
  let paid = 0;
  const settledOrders = new Set();
  const periods = [];
  for (const r of recs) {
    if (r.kind === 'settlements' && r.orderNumber) settledOrders.add(r.orderNumber);
    if (r.type === 'Sale' && Number.isFinite(Number(r.paymentPeriod))) periods.push(Number(r.paymentPeriod));
    if (r.type === 'PaymentOrder') {
      const when = r.paymentDate || r.date;
      const amount = r2(-(numOr0(r.credit) - numOr0(r.debt)));
      payments.push({ date: when, amount, id: r.paymentOrderId || r.id, region: r.affiliate === 'TRENDYOLAZJV' ? 'AZ' : null });
      if (when >= m.start && when <= m.end) paid += amount;
      continue;
    }
    const effs = effects(r);
    if (!effs.length) continue;
    const { region, country } = regionOf(r);
    // Ay içindeki hareketler (işlem tarihine göre)
    if (r.date >= m.start && r.date <= m.end) {
      for (const e of effs) {
        act[region][e.bucket] = (act[region][e.bucket] || 0) + e.amount;
        if (/^deduction_|^stopaj$/.test(e.bucket)) {
          const k = e.bucket + '|' + (r.label || BUCKET_LABEL[e.bucket]);
          const d = deductionDetail.get(k) || { bucket: e.bucket, label: r.label || BUCKET_LABEL[e.bucket], amount: 0, count: 0 };
          d.amount += e.amount; d.count++;
          deductionDetail.set(k, d);
        }
      }
      if (country && region !== 'COMMON' && r.type === 'Sale') countries[country] = (countries[country] || 0) + effs.reduce((a, e) => a + e.amount, 0);
    }
    // API tahmini takvim: ödenmemiş kalemler (gerçek ödemeler ve satıcı paneli ekranıyla karşılaştırılarak ayarlandı)
    //  • Satış/iade/indirim (TR, AZ): vadesinden ÖNCEKİ (veya aynı) ilk Pzt/Per ödemesinde
    //  • Kesinti faturaları: vadesinden SONRAKİ ilk Pzt/Per ödemesinde
    //  • Avrupa (ve bölgesiz faturalar): ayın 4. pazartesi; vadesi belli olmayan (teslim bekleyen) satış, kayıttan 18 gün sonraki ödemede
    //  • Ödeme günü resmi tatile denk gelirse sonraki iş gününe kayar
    if (r.paymentOrderId == null) {
      const reg = region === 'COMMON' ? 'EU' : region; // bölgesiz faturalar Avrupa ödemesinden düşülüyor (panelle doğrulandı)
      const settle = r.kind === 'settlements';
      const vadeKnown = r.paymentDate && (!settle || r.paymentDate - (r.date || 0) >= 86400000);
      let ymd;
      if (reg === 'EU') ymd = cal.euPayDayOnOrAfter(Math.max(vadeKnown ? r.paymentDate : (r.date || now) + 18 * 86400000, now));
      else if (settle) {
        const vade = vadeKnown ? r.paymentDate : (r.date || now) + period0 * 86400000;
        let vd = cal.istDate(vade);
        for (let i = 0; i < 10 && cal.isHoliday(vd); i++) vd = cal.addDays(vd, -1); // tatile denk gelen vade bir önceki güne çekilir
        ymd = cal.payDayOnOrBefore(cal.ymdToMs(vd));
        if (ymd < cal.istDate(now)) ymd = cal.payDayOnOrAfter(now);
      } else ymd = cal.payDayOnOrAfter(Math.max((r.paymentDate || now) + 86400000, now));
      const day = cal.ymdToMs(cal.shiftHoliday(ymd));
      const key = day + ':' + reg;
      const u = apiUpcoming.get(key) || { date: day, region: reg, amount: 0, estimated: true, source: 'api', feesEstimated: 0 };
      u.amount += effs.reduce((a, e) => a + e.amount, 0);
      // Henüz faturası kesilmemiş kargo + hizmet bedeli + stopaj (panel de bunları tahmini düşer)
      if (packageFees && (reg === 'TR' || reg === 'AZ') && r.type === 'Sale' && r.shipmentPackageId != null && !feePkgs.has(String(r.shipmentPackageId))) {
        feePkgs.add(String(r.shipmentPackageId));
        const pkgRecs = recs.filter((x) => x.type === 'Sale' && String(x.shipmentPackageId) === String(r.shipmentPackageId) && x.paymentOrderId == null);
        const fee = Number(packageFees({ orderNumber: r.orderNumber, shipmentPackageId: r.shipmentPackageId, records: pkgRecs }));
        if (Number.isFinite(fee) && fee > 0) { u.amount -= fee; u.feesEstimated += fee; }
      }
      apiUpcoming.set(key, u);
    }
  }
  const sortedP = periods.sort((a, b) => a - b);
  const period = sortedP.length ? sortedP[Math.floor(sortedP.length / 2)] : 28;

  // Ödeme takvimi: panel (kesin kaynak) varsa onu kullan
  const usePanel = panel && Array.isArray(panel.items) && panel.items.length > 0;
  const upcoming = (usePanel ? panel.items.map((i) => ({ ...i, source: 'panel' })) : [...apiUpcoming.values()].map((u) => ({ ...u, amount: r2(u.amount), feesEstimated: r2(u.feesEstimated) })))
    .filter((u) => u.date >= cal.istDayStart(now) && Math.abs(u.amount) >= 0.005)
    .sort((a, b) => a.date - b.date || a.region.localeCompare(b.region));
  const inPeriod = (u) => (offset === 0 ? u.date <= m.end : u.date >= m.start && u.date <= m.end);
  const pending = r2(upcoming.filter(inPeriod).reduce((a, u) => a + u.amount, 0));
  const pendingByRegion = { TR: 0, EU: 0, AZ: 0 };
  for (const u of upcoming.filter(inPeriod)) pendingByRegion[u.region] = r2((pendingByRegion[u.region] || 0) + u.amount);
  const nextByRegion = {};
  for (const u of upcoming) if (!nextByRegion[u.region] && u.amount > 0) nextByRegion[u.region] = u;

  // Henüz cari hesaba düşmemiş siparişler (bilgi amaçlı; ay toplamına eklenmez)
  const estimate = { count: 0, amount: 0, byRegion: { TR: 0, EU: 0, AZ: 0 }, periodDays: period, items: [] };
  if (orders && estimateFn) {
    for (const o of orders) {
      if (!ESTIMATE_STATUSES.has(o.status) || settledOrders.has(String(o.orderNumber))) continue;
      const payout = estimateFn(o);
      if (payout == null || !Number.isFinite(payout)) continue;
      const cc = String(o.countryCode || 'TR').toUpperCase();
      const region = cc === 'AZ' ? 'AZ' : ['RO', 'BG', 'GR', 'MD', 'DE', 'AT', 'NL', 'BE', 'FR', 'IT', 'ES', 'PL', 'HU', 'CZ', 'SK', 'HR', 'SI', 'PT'].includes(cc) ? 'EU' : 'TR';
      estimate.count++; estimate.amount += payout; estimate.byRegion[region] += payout;
      estimate.items.push({ orderNumber: o.orderNumber, status: o.status, payout: r2(payout), region });
    }
    estimate.amount = r2(estimate.amount);
    for (const k of Object.keys(estimate.byRegion)) estimate.byRegion[k] = r2(estimate.byRegion[k]);
  }

  // Ödeme geçmişi (aylara göre): cari hesap kayıtları + ayrıca okunan 1 yıllık ödeme talimatları
  const hist = new Map();
  for (const h of (data && Array.isArray(data.paymentHistory) ? data.paymentHistory : [])) if (h && h.date != null) hist.set(String(h.id), { id: h.id, date: h.date, amount: r2(h.amount), region: h.region || null });
  for (const p of payments) hist.set(String(p.id), p);
  const allPayments = [...hist.values()].sort((a, b) => b.date - a.date);
  paid = allPayments.filter((p) => p.date >= m.start && p.date <= m.end).reduce((a, p) => a + p.amount, 0);
  const byMonth = new Map();
  for (const p of allPayments) {
    const k = cal.istDate(p.date).slice(0, 7);
    const g = byMonth.get(k) || { key: k, label: new Date(k + '-15T12:00:00Z').toLocaleDateString('tr-TR', { month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul' }), total: 0, count: 0, items: [] };
    g.total = r2(g.total + p.amount); g.count++; g.items.push(p);
    byMonth.set(k, g);
  }
  const paymentHistory = [...byMonth.values()].sort((a, b) => (a.key < b.key ? 1 : -1));

  const activity = BUCKETS.map(([key, label]) => {
    const row = { key, label };
    let total = 0;
    for (const reg of Object.keys(act)) { row[reg] = r2(act[reg][key] || 0); total += row[reg]; }
    row.total = r2(total);
    return row;
  }).filter((r) => r.total !== 0 || ['sales', 'returns', 'commission'].includes(r.key));
  const activityNet = {};
  for (const reg of Object.keys(act)) activityNet[reg] = r2(Object.values(act[reg]).reduce((a, v) => a + v, 0));
  activityNet.total = r2(Object.values(activityNet).reduce((a, v) => a + v, 0));

  return {
    month: { ...m, offset, paid: r2(paid), pending, total: r2(paid + pending) },
    source: usePanel ? 'panel' : 'api', panelFetchedAt: panel ? panel.fetchedAt || null : null, balance: panel ? panel.balance : null, earlyAvailable: panel ? panel.earlyAvailable : null,
    upcoming, pendingByRegion, nextByRegion, nextPayment: upcoming.find((u) => u.amount > 0) || null, nextPaymentDay: nextDayOf(upcoming),
    activity, activityNet, countries: Object.fromEntries(Object.entries(countries).map(([k, v]) => [k, r2(v)])),
    payments: payments.sort((a, b) => b.date - a.date),
    paymentHistory, paymentHistoryFrom: data ? data.paymentHistoryFrom || data.from || null : null,
    deductions: [...deductionDetail.values()].map((d) => ({ ...d, amount: r2(d.amount) })).sort((a, b) => a.amount - b.amount),
    estimate, syncedAt: data ? data.syncedAt : null, coverageFrom: data ? data.from : null, errors: data ? data.errors || [] : [], recordCount: recs.length,
    regionNames: REGIONS,
  };
}

module.exports = { PAYMENT_HISTORY_DAYS, paymentOf, SETTLEMENT_TYPES, OTHER_TYPES, BUCKETS, REGIONS, syncFinance, summarizeFinance, effects, regionOf, minimizeRecord, normalizeRecord, parsePaymentDashboard, nextPayDay, nextEuPayDay, monthRange };
