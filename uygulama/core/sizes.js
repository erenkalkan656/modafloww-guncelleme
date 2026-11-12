'use strict';

/**
 * Beden bilgisi yalnızca Trendyol'un varyant/nitelik (attribute) alanlarından okunur.
 * Ürün adındaki harflere bakılarak beden TAHMİN EDİLMEZ.
 */
const SIZE_ATTRIBUTE_NAMES = ['beden', 'numara', 'yaş', 'yas', 'yaş grubu', 'beden/yaş'];

function trLower(s) {
  return String(s).toLocaleLowerCase('tr-TR');
}
function trUpper(s) {
  return String(s).toLocaleUpperCase('tr-TR');
}

function isSizeAttributeName(name) {
  if (!name) return false;
  return SIZE_ATTRIBUTE_NAMES.includes(trLower(name).trim());
}

const WORD_MAP = {
  'XXXS': '3XS', 'XXS': 'XXS', '2XS': 'XXS', 'XSMALL': 'XS', 'X-SMALL': 'XS', 'EXTRA SMALL': 'XS',
  'SMALL': 'S', 'MEDIUM': 'M', 'LARGE': 'L', 'X-LARGE': 'XL', 'XLARGE': 'XL', 'EXTRA LARGE': 'XL', 'X LARGE': 'XL',
  'XXL': '2XL', 'XXXL': '3XL', 'XXXXL': '4XL', 'XXXXXL': '5XL', 'XXXXXXL': '6XL',
  'STD': 'STANDART', 'STANDART': 'STANDART', 'STANDARD': 'STANDART', 'TEK EBAT': 'STANDART', 'TEK BEDEN': 'STANDART',
};

/**
 * Bir beden değerini standart biçime getirir.
 * Örn: " xxl " -> "2XL", "Medium" -> "M", "2 XL" -> "2XL", "s / m" -> "S/M".
 * Tanınmayan değerler büyük harfe çevrilip boşlukları sadeleştirilerek korunur.
 * Boş/geçersiz değerler için null döner (ürün hiçbir bedene atanmaz).
 */
function normalizeSize(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '-' || /^(yok|none|null|undefined)$/i.test(s)) return null;
  s = s.toUpperCase().replace(/\s+/g, ' ');
  // "2 XL" -> "2XL", "3 X L" gibi yazımları birleştir
  const compact = s.replace(/\s+/g, '');
  if (/^\d?X+[SL]$/.test(compact) || /^\d+X[SL]$/.test(compact)) s = compact;
  if (/^\d+XL$/.test(s)) return s.replace(/^1XL$/, 'XL');
  if (WORD_MAP[s]) return WORD_MAP[s];
  // Bileşik bedenler: "S / M" -> "S/M", "xxl-xxxl" -> "2XL-3XL"
  if (/[\/-]/.test(s) && !/^\d/.test(s)) {
    const sep = s.includes('/') ? '/' : '-';
    const parts = s.split(sep).map((p) => normalizeSize(p));
    if (parts.every(Boolean)) return parts.join(sep);
  }
  // Sayısal bedenler (36, 38-40, 42,5) olduğu gibi korunur
  return s.replace(/\s*([\/-])\s*/g, '$1');
}

const LETTER_ORDER = ['3XS', 'XXS', 'XS', 'S', 'S/M', 'M', 'M/L', 'L', 'L/XL', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL', '8XL', 'STANDART'];

/** Bedenleri doğal sıraya göre karşılaştırır: harf bedenleri, sonra sayısal, sonra diğerleri. */
function compareSizes(a, b) {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const ia = LETTER_ORDER.indexOf(a);
  const ib = LETTER_ORDER.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  const na = parseFloat(String(a).replace(',', '.'));
  const nb = parseFloat(String(b).replace(',', '.'));
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  if (!isNaN(na) && isNaN(nb)) return -1;
  if (isNaN(na) && !isNaN(nb)) return 1;
  return String(a).localeCompare(String(b), 'tr');
}

/**
 * Varyantın beden bilgisini tespit eder.
 * 1) Varyant nitelikleri (variant.attributes) içindeki "Beden"/"Numara"/"Yaş" alanı.
 * 2) Ürünün tek varyantı varsa içerik (content.attributes) düzeyindeki beden alanı.
 * Hiçbiri yoksa beden = null (bedensiz ürün).
 */
function detectSize(variant, content) {
  const fromAttrs = (attrs) => {
    if (!Array.isArray(attrs)) return null;
    for (const a of attrs) {
      if (a && isSizeAttributeName(a.attributeName)) {
        const v = a.attributeValue != null ? a.attributeValue : a.customAttributeValue;
        const norm = normalizeSize(v);
        if (norm) return { size: norm, raw: String(v), source: 'variant', attributeName: a.attributeName };
      }
    }
    return null;
  };
  const v = fromAttrs(variant && variant.attributes);
  if (v) return v;
  const variantCount = content && Array.isArray(content.variants) ? content.variants.length : 0;
  if (variantCount <= 1) {
    const c = fromAttrs(content && content.attributes);
    if (c) return { ...c, source: 'content' };
  }
  return { size: null, raw: null, source: null, attributeName: null };
}

module.exports = { normalizeSize, compareSizes, detectSize, isSizeAttributeName, trLower, trUpper };
