'use strict';
/**
 * İade analizi. Yalnızca Trendyol'dan gelen gerçek kayıtları birleştirir; tahmin üretmez.
 *  - İade nedenleri, beden/renk ve ürün kırılımı → iade talepleri (claims)
 *  - İade oranı (iade edilen ürün / satılan ürün) ve iade tutarı → hesap hareketleri (finance › settlements Sale/Return)
 *  - İade kaynaklı kesintiler → hesap hareketleri (yurt dışı iade bedeli, geri dönen gönderi kargo faturası, yanlış ürün faturası)
 * Bir kaynak yoksa ilgili bölüm boş döner (null); uydurma değer yazılmaz.
 */
const DAY = 86400000;

const fold = (s) => String(s || '').toLocaleLowerCase('tr-TR').replace(/[ıİ]/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');

const CATEGORIES = {
  undelivered: 'Teslim alınmadı / edilemedi',
  big: 'Büyük geldi',
  small: 'Küçük geldi',
  changed: 'Vazgeçti / beğenmedi',
  seller: 'Satıcı kaynaklı (yanlış, kusurlu, eksik)',
  other: 'Diğer',
};

function reasonCategory(reason) {
  const t = fold(reason);
  if (!t) return 'other';
  if (/teslim (almadig|alinmad|edilemey|edilemed)|teslim alinmayan|adreste bulunam/.test(t)) return 'undelivered';
  if (/buyuk geldi|bol geldi/.test(t)) return 'big';
  if (/kucuk geldi|dar geldi/.test(t)) return 'small';
  if (/yanlis urun|kusurlu|defolu|hasarli|eksik|kirik|lekeli|farkli urun|aciklama.*uyusm|bozuk/.test(t)) return 'seller';
  if (/vazgec|begenmed|istemiyorum|fikrimi/.test(t)) return 'changed';
  return 'other';
}

// Sayımlar kabul edilmeyen (iptal/ret) talepleri dışarıda bırakır
const COUNTED = (status) => !/^(Cancelled|Rejected)$/i.test(String(status || ''));
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const round2 = (n) => Math.round(n * 100) / 100;
const P = (v) => '%' + String(v).replace('.', ',');
const TL = (v) => Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';

function sizeKey(s) { return String(s || '').trim().toUpperCase().replace(/\s*[-–]\s*/g, '/') || 'Bedensiz'; }

/**
 * @param {object} p
 * @param {{items:Array}} [p.claims]   store 'claims'
 * @param {{records:Array,from?:number,to?:number}} [p.finance]   store 'finance'
 * @param {{variants:Array}} [p.catalog]
 * @param {number} [p.days]  son N gün (yoksa hesap hareketlerinin kapsadığı dönem; o da yoksa tüm talepler)
 */
function analyzeReturns({ claims, finance, catalog, days = null, now = Date.now() } = {}) {
  const variants = new Map(((catalog && catalog.variants) || []).map((v) => [String(v.barcode), v]));
  const records = (finance && Array.isArray(finance.records)) ? finance.records : [];
  const settle = records.filter((r) => r.kind === 'settlements' && (r.type === 'Sale' || r.type === 'Return'));
  // Dönem: seçilen gün sayısı, iade kayıtlarının ve cari hesap satışlarının ikisinin de bulunduğu aralığa kırpılır
  // (biri daha kısa ise oran yanlış düşük/yüksek çıkmasın)
  const cl = (claims && claims.items) || [];
  const claimMin = cl.length ? Math.min(...cl.map((c) => c.claimDate || now)) : null;
  const claimCov = claims && claims.coveredFrom ? Number(claims.coveredFrom) : claimMin;
  const finCov = settle.length ? Math.max(finance && finance.from ? Number(finance.from) : 0, Math.min(...settle.map((r) => r.date || now))) : null;
  const to = now;
  const wanted = days ? now - days * DAY : null;
  const from = Math.max(wanted || 0, claimCov || 0, finCov || 0) || null;
  const clipped = !!(wanted && from > wanted + DAY);
  const inRange = (t) => t != null && (!from || t >= from) && t <= to;

  // Sipariş numarası → ülke (hesap hareketlerinden)
  const countryOf = new Map();
  for (const r of records) if (r.orderNumber && r.country && !countryOf.has(String(r.orderNumber))) countryOf.set(String(r.orderNumber), r.country);

  const product = new Map();
  const productRow = (barcode, fallbackName) => {
    const v = variants.get(String(barcode));
    const id = (v && v.productMainId) || String(fallbackName || barcode || '—').replace(/,\s*[^,]{1,8}$/, '');
    if (!product.has(id)) product.set(id, { id, title: (v && v.title) || fallbackName || id, image: (v && v.image) || null, color: (v && v.color) || null, sold: 0, returned: 0, claimUnits: 0, big: 0, small: 0, undelivered: 0, seller: 0, changed: 0, other: 0 });
    return product.get(id);
  };
  const sizes = new Map();
  const sizeRow = (s) => { const k = sizeKey(s); if (!sizes.has(k)) sizes.set(k, { size: k, sold: 0, returned: 0, claimUnits: 0, big: 0, small: 0, undelivered: 0, changed: 0, seller: 0, other: 0, reasons: new Map() }); return sizes.get(k); };
  const colors = new Map();
  const colorRow = (c) => { const k = String(c || 'Belirtilmemiş').trim() || 'Belirtilmemiş'; if (!colors.has(k)) colors.set(k, { color: k, sold: 0, returned: 0, claimUnits: 0 }); return colors.get(k); };
  const countries = new Map();
  const countryRow = (c) => { const k = c || 'Bilinmiyor'; if (!countries.has(k)) countries.set(k, { country: k, sold: 0, returned: 0, claimUnits: 0, undelivered: 0 }); return countries.get(k); };

  // ---- Talepler: nedenler
  const claimList = cl.filter((c) => inRange(c.claimDate));
  const byCat = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  const byReason = new Map();
  const status = {};
  let units = 0, amount = 0, claimCount = 0;
  for (const c of claimList) {
    let counted = false;
    for (const it of c.items || []) {
      status[it.status || '—'] = (status[it.status || '—'] || 0) + 1;
      if (!COUNTED(it.status)) continue;
      counted = true;
      units++; amount += Number(it.price) || 0;
      const cat = reasonCategory(it.reason);
      byCat[cat]++;
      const rk = it.reason || 'Belirtilmemiş';
      const rr = byReason.get(rk) || { reason: rk, category: cat, units: 0 };
      rr.units++; byReason.set(rk, rr);
      const v = variants.get(String(it.barcode));
      const p = productRow(it.barcode, it.productName);
      p.claimUnits++; p[cat]++;
      const s = sizeRow((v && v.size) || it.size);
      s.claimUnits++; s[cat] = (s[cat] || 0) + 1; s.reasons.set(rk, (s.reasons.get(rk) || 0) + 1);
      colorRow((v && v.color) || it.color).claimUnits++;
      const cr = countryRow(countryOf.get(String(c.orderNumber)));
      cr.claimUnits++; if (cat === 'undelivered') cr.undelivered++;
    }
    if (counted) claimCount++;
  }
  const claimSpan = claimList.length ? { from: Math.min(...claimList.map((c) => c.claimDate)), to: Math.max(...claimList.map((c) => c.claimDate)) } : null;

  // ---- Hesap hareketleri: oran ve tutar
  let sales = null;
  const sr = settle.filter((r) => inRange(r.date));
  if (sr.length) {
    let sold = 0, returned = 0, returnAmount = 0, saleAmount = 0;
    for (const r of sr) {
      const v = variants.get(String(r.barcode));
      const p = productRow(r.barcode, null);
      const s = sizeRow(v && v.size);
      const col = colorRow(v && v.color);
      const cr = countryRow(r.country);
      if (r.type === 'Sale') { sold++; saleAmount += Number(r.credit) || 0; p.sold++; s.sold++; col.sold++; cr.sold++; }
      else { returned++; returnAmount += Number(r.debt) || 0; p.returned++; s.returned++; col.returned++; cr.returned++; }
    }
    sales = { sold, returned, refundRate: pct(returned, sold), claimRate: pct(units, sold), saleAmount: round2(saleAmount), returnAmount: round2(returnAmount), from: Math.min(...sr.map((r) => r.date)) };
  }

  // ---- İade kaynaklı kesintiler (yalnızca açıkça iadeye bağlı faturalar)
  const costMap = new Map();
  for (const r of records) {
    if (r.kind !== 'otherfinancials' || !inRange(r.date)) continue;
    const label = r.label || r.type; const d = fold(r.description);
    let key = null;
    if (/iade bedeli/i.test(label)) key = label;
    else if (/kargo/i.test(fold(label)) && /teslim edilemeyen|geri gotur|iade/.test(d)) key = 'Geri dönen gönderi kargo bedeli';
    else if (/yanlis urun/.test(fold(label))) key = label;
    if (!key) continue;
    const e = costMap.get(key) || { label: key, amount: 0, count: 0 };
    e.amount += (Number(r.debt) || 0) - (Number(r.credit) || 0); e.count++; costMap.set(key, e);
  }
  const costItems = [...costMap.values()].map((e) => ({ ...e, amount: round2(e.amount) })).sort((a, b) => b.amount - a.amount);
  const costs = records.length ? { items: costItems, total: round2(costItems.reduce((a, e) => a + e.amount, 0)) } : null;

  // Oran = iade talebi / satış (aynı dönem). Yurt dışında teslim alınmayan gönderiler hesap hareketlerine "İade" olarak düşmediği için talepler esas alınır.
  const withRate = (x) => ({ ...x, rate: x.sold ? pct(x.claimUnits, x.sold) : null });
  const products = [...product.values()].map(withRate).filter((p) => p.sold || p.returned || p.claimUnits)
    .sort((a, b) => (b.returned + b.claimUnits) - (a.returned + a.claimUnits) || b.sold - a.sold);
  const ORDER = ['XS', 'XS/S', 'S', 'S/M', 'M', 'M/L', 'L', 'L/XL', 'XL', 'XL/2XL', '2XL', 'XXL', '3XL'];
  // Beden başına: en sık iade nedeni (Trendyol'un yazdığı haliyle) ve neden grubu
  const sizeReasons = (x) => {
    const list = [...x.reasons.entries()].map(([reason, units]) => ({ reason, units, category: reasonCategory(reason) })).sort((a, b) => b.units - a.units);
    const cats = Object.keys(CATEGORIES).map((key) => ({ key, label: CATEGORIES[key], units: x[key] || 0 })).filter((c) => c.units).sort((a, b) => b.units - a.units);
    const { reasons: _r, ...rest } = x;
    return { ...rest, topReasons: list.slice(0, 3), topCategory: cats[0] || null };
  };
  const sizeList = [...sizes.values()].map(sizeReasons).map(withRate).filter((s) => s.sold || s.claimUnits)
    .sort((a, b) => { const ia = ORDER.indexOf(a.size), ib = ORDER.indexOf(b.size); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.size.localeCompare(b.size, 'tr'); });
  const colorList = [...colors.values()].map(withRate).filter((c) => c.sold || c.claimUnits).sort((a, b) => (b.returned + b.claimUnits) - (a.returned + a.claimUnits));
  const countryList = [...countries.values()].map(withRate).filter((c) => c.sold || c.claimUnits).sort((a, b) => b.sold - a.sold || b.claimUnits - a.claimUnits);

  const result = {
    period: { from, to, days: from ? Math.round((to - from) / DAY) : null, requestedDays: days || null, clipped, claimsFrom: claimCov, financeFrom: finCov },
    claims: {
      count: claimCount, units, amount: round2(amount), span: claimSpan, status,
      byCategory: Object.entries(byCat).filter(([, n]) => n).map(([key, n]) => ({ key, label: CATEGORIES[key], units: n, pct: pct(n, units) })).sort((a, b) => b.units - a.units),
      byReason: [...byReason.values()].map((r) => ({ ...r, pct: pct(r.units, units) })).sort((a, b) => b.units - a.units),
    },
    sales, costs, products, sizes: sizeList, colors: colorList, countries: countryList,
  };
  // "En çok hangi beden, neden?": adet olarak en çok iade edilen beden ve (yeterli satış varsa) oranı en yüksek beden
  const withClaims = sizeList.filter((s) => s.claimUnits > 0);
  const byUnits = [...withClaims].sort((a, b) => b.claimUnits - a.claimUnits)[0] || null;
  const byRate = [...withClaims].filter((s) => s.sold >= 10 && s.rate != null).sort((a, b) => b.rate - a.rate)[0] || null;
  const brief = (s) => (s ? { size: s.size, claimUnits: s.claimUnits, sold: s.sold, rate: s.rate, share: pct(s.claimUnits, units), topCategory: s.topCategory, topReasons: s.topReasons } : null);
  result.sizeSummary = { most: brief(byUnits), highestRate: byRate && (!byUnits || byRate.size !== byUnits.size) ? brief(byRate) : null };
  result.insights = insights(result);
  return result;
}

/** Verideki belirgin durumlar için kısa, kanıtı yazılı tespitler. Az veride iddia kurulmaz. */
function insights(r) {
  const out = [];
  const u = r.claims.units;
  const cat = Object.fromEntries(r.claims.byCategory.map((c) => [c.key, c.units]));
  if (u >= 5 && (cat.undelivered || 0) / u >= 0.3) {
    const abroad = r.countries.filter((c) => c.country !== 'Türkiye' && c.country !== 'Bilinmiyor').reduce((a, c) => a + c.undelivered, 0);
    const tr = (r.countries.find((c) => c.country === 'Türkiye') || {}).undelivered || 0;
    out.push({ tone: 'warning', key: 'undelivered', title: `İadelerin ${P(pct(cat.undelivered, u))} kadarı teslim alınmayan gönderi`,
      text: `${cat.undelivered} ürün müşteri teslim almadığı (veya teslim edilemediği) için geri döndü; ürünle ilgili bir şikâyet değil.` + (tr || abroad ? ` Bilinen ülkeler: Türkiye ${tr}, yurt dışı ${abroad}.` : '') + ' Bu gönderilerin kargo ve (yurt dışında) iade bedeli yine size yansır.' });
  }
  const big = cat.big || 0, small = cat.small || 0;
  if (big + small >= 5) {
    if (big >= small * 2) out.push({ tone: 'info', key: 'fit-big', title: 'Beden iadelerinin çoğu "büyük geldi"', text: `Beden kaynaklı iadelerde büyük geldi ${big}, küçük geldi ${small}. Ürünler beden tablosuna göre bir miktar büyük kalıyor olabilir; arada kalan müşteriye küçük bedeni önermek bu iadeleri azaltabilir.` });
    else if (small >= big * 2) out.push({ tone: 'info', key: 'fit-small', title: 'Beden iadelerinin çoğu "küçük geldi"', text: `Beden kaynaklı iadelerde küçük geldi ${small}, büyük geldi ${big}. Ürünler dar kalıyor olabilir; arada kalan müşteriye büyük bedeni önermek bu iadeleri azaltabilir.` });
    const worst = r.sizes.filter((s) => s.big + s.small >= 3).sort((a, b) => (b.big + b.small) - (a.big + a.small))[0];
    if (worst) out.push({ tone: 'info', key: 'fit-size', title: `En çok beden iadesi: ${worst.size}`, text: `${worst.size} bedende ${worst.big} büyük geldi, ${worst.small} küçük geldi iadesi var${worst.sold ? ` (${worst.sold} satış)` : ''}.` });
  }
  if (r.sales && r.sales.sold >= 30 && r.sales.claimRate != null) {
    const base = r.sales.claimRate;
    const hot = r.products.filter((p) => p.sold >= 10 && p.claimUnits >= 3 && p.rate >= Math.max(base * 1.5, base + 3)).sort((a, b) => b.rate - a.rate).slice(0, 3);
    for (const p of hot) {
      const why = [p.undelivered && `teslim alınmadı ${p.undelivered}`, p.big && `büyük geldi ${p.big}`, p.small && `küçük geldi ${p.small}`, p.changed && `vazgeçti ${p.changed}`, p.seller && `satıcı kaynaklı ${p.seller}`].filter(Boolean).join(', ');
      out.push({ tone: 'warning', key: 'product:' + p.id, title: `Yüksek iade: ${p.id}`, text: `${String(p.title).slice(0, 60)} — ${p.sold} satışta ${p.claimUnits} iade (${P(p.rate)}); mağaza ortalaması ${P(base)}.` + (why ? ` Nedenler: ${why}.` : '') });
    }
    const ctry = r.countries.filter((c) => c.country !== 'Bilinmiyor' && c.sold >= 20 && c.claimUnits >= 3 && c.rate >= Math.max(base * 1.5, base + 3)).sort((a, b) => b.rate - a.rate)[0];
    if (ctry) out.push({ tone: 'warning', key: 'country', title: `${ctry.country}: iade oranı ${P(ctry.rate)}`, text: `${ctry.sold} satışta ${ctry.claimUnits} iade` + (ctry.undelivered ? `, bunların ${ctry.undelivered}'i teslim alınmayan gönderi` : '') + `. Mağaza ortalaması ${P(base)}.` });
  }
  if (cat.seller) {
    const fee = r.costs && r.costs.items.find((c) => /yanlis urun/.test(fold(c.label)));
    out.push({ tone: 'danger', key: 'seller', title: `${cat.seller} iade satıcı kaynaklı`, text: 'Yanlış, kusurlu veya eksik ürün gerekçeli iadeler var.' + (fee ? ` Bu dönemde ${fee.count} yanlış ürün faturası kesildi (${TL(fee.amount)}).` : '') + ' Paketleme sırasında barkod/beden kontrolü bu iadeleri önler.' });
  }
  if (r.costs && r.costs.total > 0) out.push({ tone: 'info', key: 'costs', title: `İade kaynaklı kesintiler: ${TL(r.costs.total)}`, text: r.costs.items.map((c) => `${c.label} ${TL(c.amount)} (${c.count})`).join(' · ') + '.' });
  return out;
}

module.exports = { analyzeReturns, reasonCategory, CATEGORIES };
