'use strict';
const { round2 } = require('./num');

/** Desteklenen fiyat işlemleri */
const PRICE_OPS = {
  set: 'Sabit fiyat',
  add: 'TL ekle',
  sub: 'TL düş',
  pct_up: '% artır',
  pct_down: '% azalt',
};

const ENDINGS = {
  none: 'Kuruş hassasiyeti (2 basamak)',
  int: 'Tam sayıya yuvarla',
  '90': 'Sonu ,90 (en yakın)',
  '99': 'Sonu ,99 (en yakın)',
};

const LIST_MODES = {
  keep: 'Liste fiyatını koru (satış fiyatından düşük kalırsa eşitle)',
  same: 'Liste fiyatına da aynı kuralı uygula',
  equal: 'Liste fiyatını yeni satış fiyatına eşitle',
};

function parseNumber(input) {
  if (typeof input === 'number') return input;
  if (input == null) return NaN;
  let s = String(input).trim().replace(/\s/g, '').replace(/₺|TL/gi, '');
  if (!s) return NaN;
  // Türkçe biçim: 1.234,56 -> 1234.56 ; 250,5 -> 250.5
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

/** Bir kural değerinin geçerliliğini kontrol eder. Hata mesajı veya null döner. */
function validateRule(rule) {
  if (!rule || !PRICE_OPS[rule.op]) return 'Geçersiz işlem türü';
  const v = parseNumber(rule.value);
  if (!Number.isFinite(v)) return 'Geçersiz sayısal değer';
  if (v < 0) return 'Değer negatif olamaz';
  if (rule.op === 'set' && v <= 0) return 'Sabit fiyat sıfırdan büyük olmalı';
  if (rule.op === 'pct_down' && v >= 100) return 'Yüzde indirim 100 veya üzeri olamaz';
  if ((rule.op === 'pct_up' || rule.op === 'pct_down') && v > 1000) return 'Yüzde değeri çok yüksek';
  if (rule.op !== 'set' && v === 0) return 'Değer sıfır olamaz';
  return null;
}

function applyOp(base, op, value) {
  const v = parseNumber(value);
  switch (op) {
    case 'set': return v;
    case 'add': return base + v;
    case 'sub': return base - v;
    case 'pct_up': return base * (1 + v / 100);
    case 'pct_down': return base * (1 - v / 100);
    default: return NaN;
  }
}

/**
 * Fiyat sonu kuralını uygular.
 * - none: 2 basamağa yuvarlama (ör. 274.999 -> 275.00)
 * - int: en yakın tam sayı
 * - 90/99: en yakın X,90 / X,99 değeri (alt ve üst aday arasından yakın olan; eşitlikte alttaki)
 */
function applyEnding(value, ending = 'none') {
  if (!Number.isFinite(value)) return NaN;
  const v = round2(value);
  if (ending === 'int') return Math.round(v);
  if (ending === '90' || ending === '99') {
    const frac = ending === '90' ? 0.9 : 0.99;
    const lower = round2(Math.floor(v - frac) + frac);
    const upper = round2(lower + 1);
    const pick = Math.abs(v - lower) <= Math.abs(upper - v) ? lower : upper;
    return pick > 0 ? pick : upper;
  }
  return v;
}

function describeRule(rule) {
  const v = parseNumber(rule.value);
  const n = Number.isFinite(v) ? v.toLocaleString('tr-TR', { maximumFractionDigits: 2 }) : '?';
  const sizes = rule.sizes && rule.sizes.length ? rule.sizes.join(', ') + ': ' : '';
  switch (rule.op) {
    case 'set': return `${sizes}Sabit ${n} ₺`;
    case 'add': return `${sizes}+${n} ₺`;
    case 'sub': return `${sizes}−${n} ₺`;
    case 'pct_up': return `${sizes}%${n} artış`;
    case 'pct_down': return `${sizes}%${n} indirim`;
    default: return sizes + '?';
  }
}

/**
 * Kurallardan varyanta uyan İLK kuralı döndürür (ilk eşleşen kazanır, kurallar üst üste uygulanmaz).
 * Bedeni boş olan kural tüm bedenleri kapsar. Bedeni bilinmeyen varyanta yalnızca
 * "tüm bedenler" kuralı uygulanabilir.
 */
function matchRule(rules, variant) {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.enabled === false) continue;
    if (!r.sizes || r.sizes.length === 0) return { rule: r, index: i };
    if (variant.size && r.sizes.includes(variant.size)) return { rule: r, index: i };
  }
  return null;
}

/**
 * Seçili varyantlar için fiyat planı üretir. Hiçbir ağ işlemi yapmaz.
 * @param {Array} variants seçili varyantlar (barcode, title, size, salePrice, listPrice)
 * @param {object} cfg { rules:[{sizes, op, value}], ending, listMode, unusualPct, overrides:{barcode: price} }
 */
function buildPricePlan(variants, cfg) {
  const rules = cfg.rules || [];
  const ending = cfg.ending || 'none';
  const listMode = cfg.listMode || 'keep';
  const unusualPct = Number.isFinite(cfg.unusualPct) ? cfg.unusualPct : 30;
  const overrides = cfg.overrides || {};
  const ruleErrors = rules.map(validateRule);

  const rows = variants.map((v) => {
    const row = {
      barcode: v.barcode,
      title: v.title,
      size: v.size,
      image: v.image,
      oldSale: v.salePrice,
      oldList: v.listPrice,
      newSale: null,
      newList: null,
      ruleLabel: null,
      status: 'ok', // ok | unchanged | error | skipped
      warnings: [],
      error: null,
      overridden: false,
      changePct: null,
    };
    if (v.conflict) {
      row.status = 'error';
      row.error = 'Barkod çakışması var, işlem dışı bırakıldı';
      return row;
    }
    const base = Number(v.salePrice);
    const hasBase = Number.isFinite(base) && base > 0;
    let newSale;
    const ov = overrides[v.barcode];
    let matched = ov != null && ov !== '' ? null : matchRule(rules, v);
    // Fiyatı 0/boş olan varyant: sabit fiyat veya özel fiyatla düzenlenebilir; yüzde/ekle-düş için mevcut fiyat gerekir
    if (!hasBase && !(ov != null && ov !== '') && !(matched && matched.rule.op === 'set')) {
      row.status = matched ? 'error' : 'skipped';
      row.error = matched ? 'Mevcut fiyat 0; bu varyant için sabit fiyat kullanın' : (v.size ? `${v.size} bedeni için kural yok` : 'Beden bilgisi yok, uyan kural yok');
      return row;
    }
    if (ov != null && ov !== '') {
      newSale = parseNumber(ov);
      row.overridden = true;
      row.ruleLabel = 'Özel fiyat';
      if (!Number.isFinite(newSale)) {
        row.status = 'error';
        row.error = 'Özel fiyat geçersiz';
        return row;
      }
      newSale = round2(newSale);
    } else {
      if (!matched) {
        row.status = 'skipped';
        row.error = v.size ? `${v.size} bedeni için kural yok` : 'Beden bilgisi yok, uyan kural yok';
        return row;
      }
      if (ruleErrors[matched.index]) {
        row.status = 'error';
        row.error = ruleErrors[matched.index];
        return row;
      }
      row.ruleLabel = describeRule(matched.rule);
      newSale = applyEnding(applyOp(base, matched.rule.op, matched.rule.value), ending);
    }
    if (!Number.isFinite(newSale)) {
      row.status = 'error';
      row.error = 'Hesaplanan fiyat geçersiz';
      return row;
    }
    if (newSale <= 0) {
      row.status = 'error';
      row.error = 'Sıfır veya negatif fiyat engellendi';
      row.newSale = newSale;
      return row;
    }
    // Zarar kilidi: maliyeti girilmiş varyantlarda başabaş fiyatının altına inilmez
    const minP = cfg.minPrices ? cfg.minPrices[v.barcode] : null;
    if (minP != null && newSale < minP) {
      row.status = 'error';
      row.newSale = newSale;
      row.error = `Zarar kilidi: bu fiyatta zarar edilir (başabaş ${String(minP.toFixed(2)).replace('.', ',')} ₺)`;
      return row;
    }
    // Liste fiyatı
    const oldList = Number.isFinite(Number(v.listPrice)) && Number(v.listPrice) > 0 ? Number(v.listPrice) : hasBase ? base : newSale;
    let newList;
    if (listMode === 'equal') newList = newSale;
    else if (listMode === 'same' && matched) newList = applyEnding(applyOp(oldList, matched.rule.op, matched.rule.value), ending);
    else newList = oldList;
    if (!Number.isFinite(newList) || newList < newSale) newList = newSale;
    newList = round2(newList);

    row.newSale = newSale;
    row.newList = newList;
    row.changePct = hasBase ? round2(((newSale - base) / base) * 100) : null;
    if (hasBase && newSale === round2(base) && newList === round2(oldList)) {
      row.status = 'unchanged';
      return row;
    }
    if (row.changePct != null && Math.abs(row.changePct) >= unusualPct) row.warnings.push(`Olağandışı değişim (%${row.changePct.toLocaleString('tr-TR')})`);
    if (newSale < 1) row.warnings.push('Fiyat 1 ₺ altında');
    if (newList > newSale * 3) row.warnings.push('Liste fiyatı satış fiyatının 3 katından fazla');
    return row;
  });

  const summary = {
    total: rows.length,
    toSend: rows.filter((r) => r.status === 'ok').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    errors: rows.filter((r) => r.status === 'error').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    warnings: rows.filter((r) => r.status === 'ok' && r.warnings.length).length,
  };
  return { rows, summary, ruleErrors };
}

/** Stok planı: set (sabit), add (ekle), sub (düş). Trendyol stok üst sınırı 20.000. */
const STOCK_OPS = { set: 'Sabit stok', add: 'Stok ekle', sub: 'Stok düş' };
const MAX_STOCK = 20000;

function buildStockPlan(variants, cfg) {
  const op = cfg.op;
  const val = parseNumber(cfg.value);
  const overrides = cfg.overrides || {};
  let ruleError = null;
  if (!STOCK_OPS[op]) ruleError = 'Geçersiz işlem türü';
  else if (!Number.isInteger(val) || val < 0) ruleError = 'Stok değeri 0 veya pozitif tam sayı olmalı';
  else if (op !== 'set' && val === 0) ruleError = 'Değer sıfır olamaz';

  const rows = variants.map((v) => {
    const row = { barcode: v.barcode, title: v.title, size: v.size, image: v.image, oldQty: v.quantity, newQty: null, status: 'ok', warnings: [], error: null, overridden: false };
    if (v.conflict) return { ...row, status: 'error', error: 'Barkod çakışması var, işlem dışı bırakıldı' };
    const base = Number(v.quantity);
    let q;
    const ov = overrides[v.barcode];
    if (ov != null && ov !== '') {
      q = parseNumber(ov);
      row.overridden = true;
    } else {
      if (ruleError) return { ...row, status: 'error', error: ruleError };
      if (op !== 'set' && !Number.isFinite(base)) return { ...row, status: 'error', error: 'Mevcut stok bilinmiyor' };
      q = op === 'set' ? val : op === 'add' ? base + val : base - val;
    }
    if (!Number.isInteger(q)) return { ...row, status: 'error', error: 'Stok tam sayı olmalı' };
    if (q < 0) return { ...row, newQty: q, status: 'error', error: 'Stok negatif olamaz' };
    if (q > MAX_STOCK) return { ...row, newQty: q, status: 'error', error: `Stok ${MAX_STOCK.toLocaleString('tr-TR')} üst sınırını aşıyor` };
    row.newQty = q;
    if (q === base) row.status = 'unchanged';
    else if (q === 0) row.warnings.push('Stok sıfırlanacak (satışa kapanır)');
    return row;
  });
  const summary = {
    total: rows.length,
    toSend: rows.filter((r) => r.status === 'ok').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    errors: rows.filter((r) => r.status === 'error').length,
    skipped: 0,
    warnings: rows.filter((r) => r.status === 'ok' && r.warnings.length).length,
  };
  return { rows, summary, ruleErrors: [ruleError] };
}

/**
 * Fiyat + stok birlikte: iki plan aynı varyantlar için birleştirilir.
 *  - Birinde hata varsa varyant gönderilmez.
 *  - Fiyat kuralı uymayan (veya fiyatı değişmeyen) varyantta yalnızca stok değişir; mevcut fiyat aynen gönderilir.
 *  - Stoğu değişmeyen varyantta yalnızca fiyat değişir; mevcut stok aynen gönderilir.
 */
function mergePriceStockPlans(pricePlan, stockPlan) {
  const st = new Map(stockPlan.rows.map((r) => [r.barcode, r]));
  const rows = pricePlan.rows.map((p) => {
    const q = st.get(p.barcode) || { status: 'error', error: 'Stok planı yok', warnings: [] };
    const row = { ...p, oldQty: q.oldQty, newQty: q.newQty, qtyOverridden: !!q.overridden, priceStatus: p.status, stockStatus: q.status, warnings: [...(p.warnings || []), ...(q.warnings || [])] };
    if (p.status === 'error' || q.status === 'error') return { ...row, status: 'error', error: [p.status === 'error' ? p.error : null, q.status === 'error' ? 'Stok: ' + q.error : null].filter(Boolean).join(' · ') };
    const priceChanges = p.status === 'ok';
    const stockChanges = q.status === 'ok';
    if (!priceChanges) { row.newSale = round2(Number(p.oldSale)); row.newList = round2(Math.max(Number(p.oldList) || 0, Number(p.oldSale))); }
    if (!stockChanges) row.newQty = q.oldQty;
    if (!priceChanges && !stockChanges) return { ...row, status: p.status === 'skipped' ? 'skipped' : 'unchanged' };
    if (!priceChanges && p.status === 'skipped') row.warnings.push('Fiyat kuralı uymadı; yalnızca stok değişecek');
    if (!(row.newSale > 0) || !Number.isInteger(row.newQty)) return { ...row, status: 'error', error: 'Mevcut fiyat veya stok bilinmiyor' };
    return { ...row, status: 'ok' };
  });
  const summary = {
    total: rows.length,
    toSend: rows.filter((r) => r.status === 'ok').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    errors: rows.filter((r) => r.status === 'error').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    warnings: rows.filter((r) => r.status === 'ok' && r.warnings.length).length,
  };
  return { rows, summary, ruleErrors: [...(pricePlan.ruleErrors || []), ...(stockPlan.ruleErrors || [])] };
}

module.exports = {
  PRICE_OPS, ENDINGS, LIST_MODES, STOCK_OPS, MAX_STOCK,
  parseNumber, validateRule, applyOp, applyEnding, describeRule, matchRule, buildPricePlan, buildStockPlan, mergePriceStockPlans,
};
