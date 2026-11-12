'use strict';
/**
 * Müşteri sorularına kural tabanlı otomatik cevap motoru (bilgisayar, telefon ve ortak sunucu aynı modülü kullanır).
 *
 *  - Kurallar ürün grubu bazlıdır: her kuralın ürün listesi (model kodu) vardır; listede olmayan ürünün sorusu cevaplanmaz.
 *  - Beden: sorudaki boy/kilo okunur, kuralın beden tablosuyla karşılaştırılır (A–E durumları).
 *  - Ürün bilgisi: SSS kalıplarıyla eşleşen konuların hepsi aynı cevapta yanıtlanır.
 *  - Siparişe özel, şikâyet, bilinmeyen konular otomatik cevaplanmaz (kişiye bırakılır).
 *  - Reklam/bot yönlendirmesi: kesin olanlar cevaplanmaz, satıcı panelinden bildirilmek üzere işaretlenir.
 * Hiçbir koşulda stok, teslim tarihi veya fiyat uydurulmaz.
 */

// ---------------------------------------------------------------- metin yardımcıları
function fold(s) {
  return String(s || '')
    .replace(/İ/g, 'i').replace(/I/g, 'ı').toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .replace(/\s+/g, ' ').trim();
}
const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'];
const normSize = (s) => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/^2XL$/, 'XXL').replace(/^XXXL$/, '3XL');

// ---------------------------------------------------------------- boy / kilo okuma
const W_AFTER = /^\s*(kg|kğ|kilo\w*|kil[aiou]\w*|kilu\w*|gk)\b/;
const W_BEFORE = /(kilo\w*|kil[iou]m|kg|agirlig\w*)\s*:?\s*$/;
const H_AFTER = /^\s*(cm|boy\w*|b[o0]y\w*|santim\w*|metre)\b/;
const H_BEFORE = /(boy\w*|b[o0]y\w*|uzunlug\w*)\s*:?\s*$/;

/** Sorudaki boy (cm) ve kilo (kg) değerlerini bulur. Bulunamayan null döner. */
function parseMeasures(raw) {
  let t = fold(raw);
  let height = null, weight = null;
  // "173,75 kg" → boy 173, kilo 75 (virgülle yazılmış iki ölçü)
  t = t.replace(/\b(1[4-9]\d|20\d)[,.](\d{2,3})\b(?=\s*(kg|kilo))/, (m, a, b) => { const w = Number(b); if (w >= 30 && w <= 180) { height = Number(a); weight = w; return ' '; } return m; });
  // "1.55", "1,60", "1:81" → 155 / 160 / 181 cm
  t = t.replace(/\b1\s?[.,:]\s?([4-9]\d|0\d)\b/g, (m, d) => { if (height == null) height = 100 + Number(d); return ' '; });
  const nums = [];
  const re = /(?<![\d#])(\d{2,3})(?:[.,](\d))?(?![\d])/g; // "62.5 kilo" gibi tek ondalıklı değerler de
  let m;
  while ((m = re.exec(t))) nums.push({ v: Number(m[1] + (m[2] ? '.' + m[2] : '')), i: m.index, j: m.index + m[0].length });
  const rest = [];
  for (const n of nums) {
    const after = t.slice(n.j, n.j + 14), before = t.slice(Math.max(0, n.i - 14), n.i);
    // "38 beden", "3 adet" gibi sayılar ölçü değildir; ama "boy 165 beden ne olur" gibi önünde etiket varsa ölçüdür
    if (/^\s*(yas|ay\b|tl|lira|adet|beden|numara|cm bel|bel|basen|gun|saat|dk|dakika|%)/.test(after) && !(/^\s*beden/.test(after) && (W_BEFORE.test(before) || H_BEFORE.test(before)))) continue;
    // Sayıdan sonraki etiketin hemen ardından başka bir sayı geliyorsa ("168 kilom 53") etiket o sayıya aittir
    // (sayıya bitişik etiket — "155boy" — her zaman o sayıya aittir)
    const nextOwns = (re) => { const mm = after.match(re); return mm && /^\s/.test(after) && !/^\s*(cm|kg|kğ|gk)$/.test(mm[0]) && /^\s*:?\s*\d{2,3}(?![\d.,]?\d*\s*x)/.test(t.slice(n.j + mm[0].length, n.j + mm[0].length + 8)); };
    const wB = W_BEFORE.test(before), hB = H_BEFORE.test(before);
    const wA = W_AFTER.test(after) && !nextOwns(W_AFTER), hA = H_AFTER.test(after) && !nextOwns(H_AFTER);
    const isW = wB || wA, isH = hB || hA;
    if (isW && isH) {
      // İki etiket de uyuyorsa: henüz bulunmamış ölçü; ikisi de boşsa bitişik/sonraki etiket
      if (height != null && weight == null) weight = n.v;
      else if (weight != null && height == null) height = n.v;
      else if (weight == null && height == null) { if (wA) weight = n.v; else height = n.v; }
      continue;
    }
    if (isW) { if (weight == null) weight = n.v; continue; }
    if (isH) { if (height == null) height = n.v; continue; }
    rest.push(n.v);
  }
  // Etiketsiz sayılar: diğer ölçü biliniyorsa aralığa göre tamamla ("180-94 kilo" → boy 180)
  for (const v of rest) {
    if (height == null && v >= 140 && v <= 210 && (weight != null || rest.length > 1)) height = v;
    else if (weight == null && v >= 30 && v <= 135 && (height != null || rest.length > 1)) weight = v;
  }
  if (height != null && (height < 90 || height > 220)) height = null;
  if (weight != null && (weight < 25 || weight > 200)) weight = null;
  return { height, weight };
}

/** Kullanım tercihi: bol / dar / normal (olumsuzlamaları dikkate alır) */
function parsePreference(raw) {
  const t = fold(raw);
  if (/(dar|yapis\w*|oturan|vucuda)\b.{0,40}(istemiyor|istemem|olmasin|olmasini istemi|sevmiyor)/.test(t)) return 'bol';
  if (/\bbol\b|bol (dur|olsun|olmasi|kalip|gelsin)|rahat (dur|olsun|olmasi)|salas|oversize/.test(t)) return 'bol';
  if (/\bdar\b|yapis|oturan|slim|vucudu sar/.test(t)) return 'dar';
  if (/normal (dur|olsun|kalip|giy)|tam (otursun|olsun)/.test(t)) return 'normal';
  return null;
}

// ---------------------------------------------------------------- spam / kişiye bırakılacaklar
const SPAM_STRONG = [
  /magaza ?ivme/, /tarayici(ya|dan)?.{0,40}(yaz|ara)/, /satis(lar)?(in|iniz)? (yavas|dusuk|az)/, /satislarini(zi)? (artir|katla|patlat)/,
  /(takipci|yorum|degerlendirme) (sat|al|kasma|hizmeti)/, /(magazana|magazaniza) (ziyaretci|trafik)/, /ucretsiz (danismanlik|analiz).{0,30}(magaza|satis)/,
];
const SPAM_LINK = /(https?:\/\/|www\.|\.com\b|\.net\b|instagram|whatsapp|telegram|t\.me|wa\.me|\b0?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b)/;
const SPAM_PROMO = /(magaza|satis|reklam|kazan|ciro|sipari?s artir|musteri bul|tanitim|e-?ticaret|danisman)/;

function spamCheck(raw) {
  const t = fold(raw);
  const strong = SPAM_STRONG.find((r) => r.test(t));
  if (strong) return { spam: true, sure: true, reason: 'Reklam/bot yönlendirme kalıbı' };
  if (SPAM_LINK.test(t) && SPAM_PROMO.test(t)) return { spam: true, sure: true, reason: 'Bağlantı/iletişim + tanıtım içeriği' };
  if (SPAM_LINK.test(t)) return { spam: true, sure: false, reason: 'Bağlantı veya iletişim bilgisi içeriyor' };
  return { spam: false };
}

// Siparişe özel sorular, iade ve şikâyetler: müşteriye sipariş sorusu oluşturması söylenir (texts.orderRedirect / complaintRedirect)
const REDIRECT = [
  [/gelmedi|ulasmadi|eksik geldi|yanlis (urun|beden|renk)|farkli (urun|renk|beden) geldi|ayni urun gelmedi|hasarli|defolu|yirtik|sokuk|(ama|fakat|ancak|istedi\w*|aldi\w*|siparis\w*).{0,40}\bgeldi\b|\bgeldi\b.{0,30}(neden|niye|sebebi|ne alaka)/, 'Teslimat veya ürün sorunu', 'complaintRedirect'],
  [/rezalet|berbat|dolandir|sikayet|magdur|tuketici|kalitesiz|cok kotu|begenmedim/, 'Şikâyet', 'complaintRedirect'],
  [/siparis(im|imi|imin|imiz|imde)|siparis (verdim|ettim|olusturdum)|kargom|paketim|#\s?\d{6,}|\b\d{9,}\b/, 'Siparişe özel soru', 'orderRedirect'],
  [/iade|degisim|degistir/, 'İade/değişim', 'orderRedirect'],
];
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
const HUMAN = [
  [/gramaj|gsm\b/, 'Gramaj bilgisi kurallarda yok'],
];
// Ürün başlığı genel cevapla çelişiyorsa (ör. "Kışlık", "Termal Astarlı") o konu otomatik cevaplanmaz
const TITLE_CONFLICT = {
  mevsim: /kislik|termal|sardon|kalin kumas|polar/, kalinlik: /kislik|termal|sardon|kalin kumas|polar/,
  tuy: /sardon|astarli|termal|polar|tuylu/, esneme: /likra/,
};
const COLORS = ['siyah', 'gri', 'lacivert', 'beyaz', 'bej', 'mavi', 'kahverengi', 'kahve', 'antrasit', 'haki', 'pembe', 'mor', 'yesil', 'kirmizi', 'krem', 'vizon'];
// Ürünün kendi ölçüsü (boy/uzunluk) soruluyor: ölçü tablosu olmadığı için müşterinin boy-kilosu istenir
const PRODUCT_LEN = /urun(un)? boy|boyu (kac|ne|nedir)|paca boyu|uzunlug|manken (boy|kac)|\bcm\b.{0,15}(mi|kac)\b.{0,10}(urun|pantolon|esofman)/;
const iplikNo = (s) => { const m = fold(s).match(/\b(\d|iki|uc)\s*ipli/); return m ? ({ iki: '2', uc: '3' }[m[1]] || m[1]) : null; };

const STOCK_CARGO = /(\b(\d?x+l|xs|s|m|l|beden\w*)\b.{0,12}(var mi|kaldi mi|gelir mi|gelecek mi)|stok|stokta|tukendi|ne zaman gel|gelecek mi|kargo|teslim|kac gun|ne zaman (cik|gonder|ulas)|fiyat|indirim|kampanya|ucret)/;

// ---------------------------------------------------------------- beden tablosu
/**
 * Değerin tablodaki en yakın bedeni (sıra numarası; tablo kiloya göre küçükten büyüğe sıralanır).
 * Aralık içindeyse o beden; iki beden arasındaysa yakın olan (eşitse büyük olan — bol olan dar olandan az iade getirir).
 * Tablonun dışında kalan değer: marginAbove kadar üstüyse en büyük beden, daha fazlası 'above'; altı 'below'.
 */
function nearestSize(value, order, key, { marginAbove = 0, clamp = false } = {}) {
  if (value == null || !order.length) return null;
  const lo = (r) => Number(r[key][0]), hi = (r) => Number(r[key][1]);
  for (let k = 0; k < order.length; k++) if (value >= lo(order[k]) && value <= hi(order[k])) return { k };
  if (value < lo(order[0])) return clamp ? { k: 0 } : { below: true };
  const last = order.length - 1;
  if (value > hi(order[last])) return clamp || value - hi(order[last]) <= marginAbove ? { k: last } : { above: true };
  for (let k = 0; k < last; k++) {
    if (value > hi(order[k]) && value < lo(order[k + 1])) return { k: value - hi(order[k]) < lo(order[k + 1]) - value ? k : k + 1 };
  }
  return null;
}

/**
 * Beden önerisi. Varsayım: müşteri aksini yazmadıkça normal kalıp ister; soru sorulmaz, beden önerilir.
 *  - Kilo önceliklidir (aralıkta değilse en yakın beden).
 *  - Boy, kiloya göre 2 beden veya daha büyükse bir beden büyütülür (boy uzunluğu).
 *  - "Bol" → bir büyük, "dar" → bir küçük.
 *  - Kilo tablonun en üstünü 4 kg'dan fazla aşıyor veya en altın altındaysa tablo dışı cevabı.
 *  - Yalnız boy veya yalnız kilo verildiyse eksik olan sorulur.
 * @returns {{ kind, text, size?, auto }} auto=false ise kişiye bırakılır.
 */
function sizeAdvice(rule, q, productSizes) {
  const T = rule.texts || {};
  const order = (rule.sizeTable || []).filter((r) => r && r.size && [...r.kg, ...r.cm].every((x) => Number.isFinite(Number(x)))).slice().sort((a, b) => Number(a.kg[0]) - Number(b.kg[0]));
  const { height, weight } = q.measures;
  const pref = q.preference;
  const has = (sz) => !productSizes || !productSizes.length || productSizes.map(normSize).includes(normSize(sz));
  if (height == null && weight == null) return { kind: 'size_ask_both', text: T.askBoth, auto: true };
  if (weight == null) return { kind: 'size_ask_weight', text: T.askWeight, auto: true };
  if (height == null) return { kind: 'size_ask_height', text: T.askHeight, auto: true };
  if (!order.length) return { kind: 'size_unknown', auto: false, reason: 'Beden tablosu eksik' };
  const w = nearestSize(weight, order, 'kg', { marginAbove: 4 });
  if (!w) return { kind: 'size_unknown', auto: false, reason: 'Beden tablosu okunamadı' };
  if (w.above) return { kind: 'size_out_above', text: T.outAbove, auto: true };
  if (w.below) return { kind: 'size_out_below', text: T.outBelow, auto: true };
  const h = nearestSize(height, order, 'cm', { clamp: true });
  let k = w.k;
  if (h && h.k - w.k >= 2) k = Math.min(order.length - 1, w.k + 1); // uzun boy: bir beden büyüt
  if (pref === 'bol' && k + 1 < order.length) k += 1;
  else if (pref === 'dar' && k > 0) k -= 1;
  const size = order[k].size;
  if (!has(size)) return { kind: 'size_missing', auto: false, reason: `${size} bu üründe yok` };
  if (pref === 'bol' || pref === 'dar') return { kind: 'size_pref', size, text: fill(T.recommendPref, { size, pref: pref === 'bol' ? 'daha bol' : 'daha dar' }), auto: true };
  const up = k + 1 < order.length && has(order[k + 1].size) ? order[k + 1].size : null;
  return { kind: 'size_recommend', size, text: fill(T.recommend, { size }) + (up && T.recommendUp ? ' ' + fill(T.recommendUp, { up }) : ''), auto: true };
}

// ---------------------------------------------------------------- karar
const SIZE_INTENT = /(\b(xxs|xs|s|m|l|xl|xxl|2xl|3xl)\b.{0,15}\bmi\b.{0,25}(al[iı]?y|alay|olur|almal|uygun)|hangi beden|kac beden|ne beden|beden (oner|tavsiye|olur|almal|secmel|uygun)|bedenim|hangisini alay|hangi bedeni|olur mu.{0,10}beden|beden.{0,20}(olur|almaliyim|alayim|uygun))/;

/**
 * Bir soru için karar verir.
 * @param question { id, text, productMainId }
 * @param config   { rules: [...], spamReportText }
 * @param catalogSizes  (productMainId) => string[] | null  (ürünün beden seçenekleri)
 * @returns { action: 'answer'|'spam'|'human'|'skip', text?, rule?, parts, reason }
 */
function decide(question, config, catalogSizes = () => null) {
  const raw = String(question.text || '');
  const t = fold(raw);
  const sp = spamCheck(raw);
  if (sp.spam) return { action: sp.sure ? 'spam' : 'human', reason: sp.reason, sure: !!sp.sure, parts: [] };
  const rule = (config.rules || []).find((r) => r.enabled !== false && (r.products || []).some((p) => String(p.id || p) === String(question.productMainId)));
  if (!rule) return { action: 'skip', reason: 'Bu ürün hiçbir kurala bağlı değil', parts: [] };
  for (const [re, why, key] of REDIRECT) if (re.test(t)) {
    const txt = rule.texts && rule.texts[key];
    return txt ? { action: 'answer', text: txt, rule: rule.id, reason: why, parts: [{ topic: key, text: txt }] } : { action: 'human', reason: why, rule: rule.id, parts: [] };
  }
  for (const [re, why] of HUMAN) if (re.test(t)) return { action: 'human', reason: why, rule: rule.id, parts: [] };

  const parts = [];
  const measures = parseMeasures(raw);
  const preference = parsePreference(raw);
  const SIZE_LIST_Q = /(kac|hangi|ne) beden(ler)?(iniz|i)? (var|mevcut)|bedenler(iniz)? (neler|ne)\b|beden secenek|\b(\d?\s?x+l|xxs|xs|s|m|l)\b\s*(beden(i|iniz)?)?\s*(var mi|yok mu|kaldi mi|bulunur mu|mevcut mu)/;
  const listOnly = SIZE_LIST_Q.test(t) && measures.height == null && measures.weight == null;
  const sizeAsked = !listOnly && (SIZE_INTENT.test(t) || measures.height != null || measures.weight != null || /\bbeden\b/.test(t));
  const prod = (rule.products || []).find((p) => String(p.id || p) === String(question.productMainId));
  if (PRODUCT_LEN.test(t) && (measures.height == null || measures.weight == null) && rule.texts && rule.texts.lengthAsk) {
    parts.push({ topic: 'length_ask', text: rule.texts.lengthAsk });
  } else if (sizeAsked) {
    const sizes = (prod && prod.sizes) || catalogSizes(question.productMainId);
    const adv = sizeAdvice(rule, { measures, preference }, sizes);
    if (!adv.auto) return { action: 'human', reason: adv.reason || 'Beden önerisi verilemiyor', rule: rule.id, measures, parts: [] };
    parts.push({ topic: adv.kind, text: adv.text, size: adv.size || null });
  }
  // Ürünün kendi bilgileri (başlık ve beden seçenekleri)
  const title = fold((prod && prod.title) || question.productName || '');
  const T = rule.texts || {};
  if (/yuksek bel|normal bel|dusuk bel/.test(t) || /\bbel(i)? (yuksek|normal|dusuk)/.test(t)) {
    if (/yuksek bel/.test(title) && T.highWaist) parts.push({ topic: 'high_waist', text: T.highWaist });
    else return { action: 'human', reason: 'Bel yüksekliği ürün başlığında yazmıyor', rule: rule.id, parts: [] };
  }
  if (/(kac|iki|2) (tane|adet)|\b2 ?(li|adet) mi|tek mi geli|ikili mi|set mi/.test(t)) {
    const set = /\b2\s*'?\s*li\b|ikili|2 adet|iki adet|\bset/.test(title);
    if (set && T.packTwo) parts.push({ topic: 'pack', text: T.packTwo }); else if (title && T.packOne) parts.push({ topic: 'pack', text: T.packOne });
  }
  const askedColors = COLORS.filter((c) => new RegExp('\\b' + c + '\\s?(renk\\w*\\s?)?mi\\b').test(t) || new RegExp('\\b' + c + ' ve \\w+ renk').test(t) || new RegExp('\\w+ ve ' + c + ' renk').test(t));
  if (askedColors.length) {
    const tc = [...new Set(COLORS.filter((c) => new RegExp('\\b' + c).test(title)).map((c) => (c === 'kahve' ? 'kahverengi' : c)))];
    const ac = [...new Set(askedColors.map((c) => (c === 'kahve' ? 'kahverengi' : c)))];
    // Yalnızca sorulan renkler başlıktaki renklerin tamamıysa "evet" denir (ör. siyah-gri sete "siyah mı" sorusu kişiye kalır)
    if (tc.length && ac.length === tc.length && ac.every((c) => tc.includes(c)) && T.colorYes) parts.push({ topic: 'color', text: T.colorYes.replace('{color}', askedColors.join(' ve ')) });
    else return { action: 'human', reason: 'Sorulan renk ürün başlığında yok', rule: rule.id, parts: [] };
  }
  const sizesOf = ((prod && prod.sizes) || []).filter((x, i, a) => a.indexOf(x) === i);
  const specific = t.match(/\b(\d?\s?x+l|xxs|xs|s|m|l)\b\s*(beden(i|iniz)?)?\s*(var mi|yok mu|kaldi mi|bulunur mu|mevcut mu)/);
  if (sizesOf.length && listOnly) {
    const list = sizesOf.join(', ');
    if (specific) {
      specific[1] = specific[1].replace(/\s/g, '');
      const want = normSize(specific[1]);
      const ok = sizesOf.map(normSize).includes(want);
      parts.push({ topic: 'size_list', text: fill(ok ? T.sizeHas : T.sizeNo, { size: specific[1].toUpperCase(), list }) });
    } else parts.push({ topic: 'size_list', text: fill(T.sizeList, { list }) });
  }
  if (/\b\d{1,2} ?yas|yetiskin|cocug|cocuk|beden tablo|olcu tablo|boyutlar/.test(t) && (measures.height == null || measures.weight == null) && T.lengthAsk && !parts.some((p) => p.topic === 'length_ask' || /^size_/.test(p.topic))) parts.push({ topic: 'length_ask', text: T.lengthAsk });
  for (const f of rule.faq || []) {
    if (f.enabled === false) continue;
    if (TITLE_CONFLICT[f.id] && TITLE_CONFLICT[f.id].test(title) && (f.patterns || []).some((p) => new RegExp(p).test(t))) return { action: 'human', reason: `Ürün başlığı genel "${f.label || f.id}" cevabıyla çelişiyor`, rule: rule.id, parts: [] };
    const pats = (f.patterns || []).map((p) => (p instanceof RegExp ? p : new RegExp(p)));
    if (!pats.some((re) => re.test(t))) continue;
    // İplik: ürün başlığında farklı bir iplik sayısı yazıyorsa tahmin yürütülmez
    if (f.id === 'iplik') { const a = iplikNo(f.answer), b = iplikNo((prod && prod.title) || question.productName || ''); if (a && b && a !== b) return { action: 'human', reason: `Ürün başlığında ${b} iplik yazıyor`, rule: rule.id, parts: [] }; }
    parts.push({ topic: f.id, text: f.answer });
  }
  // Teşekkür yalnızca başka bir soru yoksa cevaplanır
  if (parts.length > 1) { const i = parts.findIndex((p) => p.topic === 'tesekkur'); if (i >= 0) parts.splice(i, 1); }
  if (!parts.length && STOCK_CARGO.test(t) && rule.texts && rule.texts.stockCargo) parts.push({ topic: 'stock_cargo', text: rule.texts.stockCargo });
  // Aynı cevap iki kez eklenmesin
  const seen = new Set();
  const uniq = parts.filter((p) => p.text && !seen.has(p.text) && seen.add(p.text));
  if (!uniq.length) return { action: 'human', reason: 'Kurallarda karşılığı yok', rule: rule.id, measures, parts: [] };
  const text = uniq.map((p) => p.text.trim()).join(' ');
  if (text.length < 10 || text.length > 2000) return { action: 'human', reason: 'Cevap uzunluğu uygun değil', rule: rule.id, parts: uniq };
  return { action: 'answer', text, rule: rule.id, parts: uniq, measures, preference };
}

// ---------------------------------------------------------------- kullanıcının kuralları (varsayılan)
const SIZE_TABLE = [
  { size: 'XXS', kg: [35, 39], cm: [140, 145] },
  { size: 'XS', kg: [40, 44], cm: [145, 150] },
  { size: 'S', kg: [45, 50], cm: [155, 160] },
  { size: 'M', kg: [55, 60], cm: [160, 165] },
  { size: 'L', kg: [65, 70], cm: [170, 175] },
  { size: 'XL', kg: [75, 80], cm: [175, 180] },
  { size: 'XXL', kg: [85, 90], cm: [180, 185] },
];
const TEXTS = {
  askWeight: 'Size doğru beden konusunda yardımcı olabilmemiz için kilonuzu da öğrenebilir miyiz?',
  askHeight: 'Size daha doğru beden önerebilmemiz için boyunuzu da öğrenebilir miyiz?',
  askBoth: 'Size yardımcı olmak isteriz. Boy ve kilonuzu paylaşabilir misiniz? Size uygun bedeni değerlendirelim.',
  recommend: 'Paylaştığınız boy ve kilo bilgilerine göre {size} beden öneririz.',
  recommendUp: 'Daha bol kullanım isterseniz {up} beden de tercih edebilirsiniz.',
  recommendPref: 'Paylaştığınız bilgilere ve {pref} kullanım tercihinize göre {size} beden öneririz.',
  outAbove: "Size doğru beden konusunda yardımcı olmak isteriz. Paylaştığınız ölçüler mevcut beden tablomuzun dışında kalıyor. 3XL seçeneği için güncel ürün bedenlerini ve stok durumunu kontrol etmemiz gerekiyor.",
  outBelow: 'Size doğru beden konusunda yardımcı olmak isteriz. Paylaştığınız ölçüler mevcut beden tablomuzun dışında kalıyor; en küçük bedenimiz XXS (35–39 kg) içindir.',
  lengthAsk: 'Boy ve kilonuzu belirtirseniz size uygun bedeni önerelim.',
  orderRedirect: 'Siparişinizle ilgili size yardımcı olabilmemiz için lütfen Siparişlerim bölümünden ilgili siparişinize soru oluşturun; en kısa sürede dönüş yapacağız.',
  complaintRedirect: 'Yaşadığınız durum için üzgünüz. Size yardımcı olabilmemiz için lütfen Siparişlerim bölümünden ilgili siparişinize soru oluşturun; en kısa sürede ilgileneceğiz.',
  highWaist: 'Evet, ürünümüz yüksek bel modeldir.',
  packTwo: 'Ürünümüz 2 adet olarak gönderilmektedir.',
  packOne: 'Ürünümüz tek adet olarak gönderilmektedir.',
  colorYes: 'Evet, ürünümüz {color} renktedir.',
  sizeList: 'Ürünümüzün beden seçenekleri: {list}. Güncel stok durumunu ürün sayfasından görebilirsiniz.',
  sizeHas: '{size} beden seçeneğimiz bulunmaktadır; güncel stok durumunu ürün sayfasından görebilirsiniz.',
  sizeNo: 'Bu üründe {size} beden seçeneği bulunmamaktadır. Mevcut beden seçenekleri: {list}.',
  stockCargo: 'Güncel beden, stok, fiyat ve teslimat bilgilerini ürün ilanından görebilirsiniz; siparişinizle ilgili bilgiler için sipariş detaylarınızı kontrol edebilirsiniz.',
};
const FAQ = [
  { id: 'kalinlik', label: 'Kalın mı / ince mi', patterns: ['\\b(kalin|ince|kalinlig)'], answer: 'Ürünümüz orta kalınlıkta, mevsimlik kumaşa sahiptir.' },
  { id: 'mevsim', label: 'Yazlık / kışlık / mevsimlik', patterns: ['\\bkis(in|lik|a|ta)?\\b', '\\bkislik', '\\bkisin', 'soguk', '\\byaz(in|lik|a|da)?\\b', '\\byazlik', '\\byaz icin', '\\bmevsim'], answer: 'Ürünümüz mevsimliktir; özellikle mevsim geçişlerinde kullanıma uygundur. Çok soğuk havalar için kalın kışlık bir model değildir.' },
  { id: 'iplik', label: 'Kaç iplik', patterns: ['ipli(k|kli|k mi)', 'kac ipli'], answer: 'Ürünümüz 2 iplik kumaştan üretilmiştir.' },
  { id: 'teslimat', label: 'Ne zaman gelir', patterns: ['ne zaman gel', 'kac (is )?gun', 'yarin gel', 'gelis sures', 'teslim(at)? sures', 'kargo(ya)? ne zaman', 'ne zaman (cik|gonder|ulas|kargo)', 'hizli gel'], answer: 'Siparişiniz 1-3 iş günü içinde evinize ulaşır.' },
  { id: 'kontrol', label: 'Kontrol edip gönderin', patterns: ['kontrol (edip|ederek|ederseniz|edin|edermisiniz|eder misiniz)', 'ozenle (gonder|paketle|ilgilen)', 'yanlislik olmasin'], answer: 'Ürünlerimizi göndermeden önce kontrol edip özenle paketliyoruz.' },
  { id: 'kalip', label: 'Kalıbı nasıl', patterns: ['kalib(i|ini)? (nasil|dar|bol|kucuk|buyuk)', 'kalip (nasil|dar mi|bol mu)', 'ebatlar', '(kucuk|buyuk|dar|bol) mu (geliyor|kaliyor|duruyor)', 'kalip yapar'], answer: 'Ürünümüz normal (tam) kalıptır.' },
  { id: 'tesekkur', label: 'Teşekkür', patterns: ['tesekkur', '\\bsag ?ol'], answer: 'Rica ederiz, iyi günlerde kullanmanızı dileriz.' },
  { id: 'tuy', label: 'İçi tüylü mü / astar', patterns: ['tuy(lu|su)', 'astar', 'sardon', 'polar', 'polor'], answer: 'Ürünümüz astarsız ve iç yüzeyi tüysüz kumaştan üretilmiştir.' },
  { id: 'esneme', label: 'Likralı mı / esner mi', patterns: ['likra', 'esne', 'streç', 'strec', 'elastik'], answer: 'Kumaşımız çok az esneme özelliğine sahiptir.' },
  { id: 'ic_gosterir', label: 'İç gösterir mi', patterns: ['ic(i|ini)? goster', 'transparan', 'seffaf', 'gosterir mi'], answer: 'Ürün bilgimize göre kumaş iç göstermez.' },
  { id: 'renk_fark', label: 'Siyah ve gri farkı', patterns: ['(siyah|gri).{0,30}(fark|ayni mi|ayni ozellik)', 'fark.{0,20}(siyah|gri)'], answer: 'Siyah ve gri modellerimizin özellikleri aynıdır; yalnızca renkleri farklıdır.' },
  { id: 'bel', label: 'Bel lastikli / ayarlanabilir', patterns: ['\\bbel(i|inde|den)?\\b.{0,25}(lastik|ayar|bag|ip)', 'bagcik', '\\bbel lastig', 'ipi var', '\\bip(i|leri)? (var|yok)'], answer: 'Ürünümüzün beli lastikli ve ayarlanabilir bağcıklıdır.' },
  { id: 'paca', label: 'Paça lastikli mi', patterns: ['paca'], answer: 'Ürünümüzün paçası lastiklidir ve paçaya doğru daralan normal kesime sahiptir.' },
  { id: 'cep', label: 'Cep var mı', patterns: ['\\bcep'], answer: 'Ürünümüzde iki yan cep bulunur; arka cebi yoktur.' },
  { id: 'telefon_cep', label: 'Telefon cebe sığar mı', patterns: ['telefon'], answer: 'Yan cepler normal derinliktedir; telefonunuzun ölçüsüne göre kullanım değişebilir.' },
  { id: 'cinsiyet', label: 'Kadın / erkek', patterns: ['\\b(kadin|erkek|bayan|bay|unisex)\\b.{0,25}(mi|icin|uygun|olur)', 'erkekler', 'kadinlar'], answer: 'Ürünümüz kadın ve erkek kullanıcılar için tercih edilebilir.' },
  { id: 'icerik', label: 'Kumaş içeriği', patterns: ['icerig', 'pamuk', 'polyester', 'materyal', 'keten', 'kadife', 'kumas(i)? (ne|nedir|nasil)', 'kumasi ne'], answer: "Ürünümüzün kumaş içeriği %75 pamuk ve %25 diğer elyaflar şeklindedir; pamuk-polyester karışımı olarak tanımlanmıştır." },
  { id: 'uretim', label: 'Nerede üretiliyor', patterns: ['nerede uretil', 'uretim yeri', 'yerli mi', 'turk mali', 'mensei', 'ithal mi'], answer: "Ürünümüz Türkiye'de üretilmektedir." },
  { id: 'cekme', label: 'Yıkamada çeker / solar mı', patterns: ['cek(er|me|iyor)', 'sol(ar|ma|uyor)', 'tuylen', 'tuglen', 'tiftik', 'topaklan', 'boncuk'], answer: 'Ürün bilgimize göre normal yıkamada çekme, renk solması veya tüylenme sorunu yaşanmamaktadır. 30°C\'de, tersten yıkamanızı öneririz.' },
  { id: 'yikama', label: 'Nasıl yıkanmalı', patterns: ['yika(ma|nir|nmali|yabil)', 'kac derece'], answer: "Ürünümüzün 30°C'de tersten yıkanmasını öneriyoruz." },
  { id: 'set_renk', label: 'İkili sette renkler', patterns: ['(ikili|2 ?li|iki ?li|set).{0,30}renk', 'renk.{0,20}(ikili|2 ?li|set)'], answer: 'İkili setimiz siyah ve gri eşofman altından oluşmaktadır.' },
  { id: 'set_beden', label: 'İkili sette ayrı beden', patterns: ['(ikili|2 ?li|iki ?li|set).{0,40}(farkli|ayri|ayri ayri).{0,20}beden', 'farkli beden.{0,20}(secebil|olur|mumkun)'], answer: 'Beden seçimi ürün ilanındaki seçeneklere göre değişebiliyor; sipariş vermeden önce ilgili ilandaki beden seçeneklerini kontrol etmenizi öneririz.' },
];

function defaultRule(id, name) {
  return { id, name, enabled: true, products: [], sizeTable: SIZE_TABLE.map((r) => ({ ...r, kg: [...r.kg], cm: [...r.cm] })), texts: { ...TEXTS }, faq: FAQ.map((f) => ({ ...f, patterns: [...f.patterns], enabled: true })) };
}
function defaultConfig() {
  return { mode: 'off', spamReportText: 'BOT YÖNLENDİRME MESAJI', reportSpam: true, rules: [defaultRule('siyah-esofman', 'Siyah eşofman'), defaultRule('gri-esofman', 'Gri eşofman')] };
}

/** Sunucuya/ayarlara yazılmadan önce yapılandırmayı doğrular ve temizler. */
function normalizeConfig(c) {
  const out = { mode: ['off', 'simulate', 'auto'].includes(c && c.mode) ? c.mode : 'off', spamReportText: String((c && c.spamReportText) || 'BOT YÖNLENDİRME MESAJI').slice(0, 300), reportSpam: !(c && c.reportSpam === false), rules: [] };
  for (const r of ((c && c.rules) || []).slice(0, 50)) {
    const rule = {
      id: String(r.id || '').slice(0, 60) || 'kural-' + out.rules.length, name: String(r.name || 'Kural').slice(0, 80), enabled: r.enabled !== false,
      products: (r.products || []).slice(0, 2000).map((p) => (typeof p === 'object' ? { id: String(p.id).slice(0, 80), title: String(p.title || '').slice(0, 160), sizes: Array.isArray(p.sizes) ? p.sizes.slice(0, 40).map(String) : [] } : { id: String(p).slice(0, 80), title: '', sizes: [] })),
      sizeTable: (r.sizeTable || []).slice(0, 15).map((x) => ({ size: String(x.size).slice(0, 10), kg: [Number(x.kg[0]), Number(x.kg[1])], cm: [Number(x.cm[0]), Number(x.cm[1])] })).filter((x) => x.size && x.kg.every(Number.isFinite) && x.cm.every(Number.isFinite)),
      texts: Object.fromEntries(Object.keys(TEXTS).map((k) => [k, String((r.texts && r.texts[k]) ?? TEXTS[k]).slice(0, 1000)])),
      faq: (r.faq || []).slice(0, 80).map((f) => ({ id: String(f.id).slice(0, 40), label: String(f.label || '').slice(0, 80), enabled: f.enabled !== false, patterns: (f.patterns || []).slice(0, 20).map((p) => String(p).slice(0, 200)).filter((p) => { try { new RegExp(p); return true; } catch (_) { return false; } }), answer: String(f.answer || '').slice(0, 1000) })),
    };
    out.rules.push(rule);
  }
  return out;
}

module.exports = { fold, parseMeasures, parsePreference, spamCheck, sizeAdvice, nearestSize, decide, defaultConfig, defaultRule, normalizeConfig, normSize, SIZE_TABLE, TEXTS, FAQ, SIZE_ORDER };
