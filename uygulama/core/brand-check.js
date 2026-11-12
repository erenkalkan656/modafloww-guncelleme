'use strict';
/**
 * TÜRKPATENT marka araştırma sonuçlarının yorumlanması (saf fonksiyonlar).
 * Sonuç tablosu sütun başlıklarına göre okunur; sayfanın yapısına bağlı sabit seçici kullanılmaz.
 * Önemli: marka bulunamaması ancak arama gerçekten yapıldıysa ve sayfa "kayıt bulunamadı" dediyse "none" olur.
 * Okunamayan / doğrulanamayan her durum "unverified" kalır (tescilsiz gibi gösterilmez).
 */

const normBrandRaw = (s) => String(s || '').toLocaleLowerCase('tr-TR')
  .replace(/[çc]/g, 'c').replace(/[ğg]/g, 'g').replace(/[ıi̇i]/g, 'i').replace(/[öo]/g, 'o').replace(/[şs]/g, 's').replace(/[üu]/g, 'u')
  .replace(/[^a-z0-9]/g, '');
// Aynı markalar binlerce kez sorulur (Buybox listesindeki her sorgu, her ürün): sonuç önbellekten döner.
// Türkçe küçük harfe çevirme (ICU) pahalıdır; ölçümde Buybox sorgu süresinin yarısı buradaydı.
const NORM_CACHE = new Map();
const normBrand = (s) => {
  if (typeof s !== 'string') return normBrandRaw(s);
  let v = NORM_CACHE.get(s);
  if (v === undefined) {
    if (NORM_CACHE.size > 50000) NORM_CACHE.clear();
    v = normBrandRaw(s);
    NORM_CACHE.set(s, v);
  }
  return v;
};

const COLS = [
  ['name', /marka\s*ad|^marka$|trademark|^ad[ıi]?$/i],
  ['owner', /sahib|sahip|owner|başvuru\s*sahibi/i],
  ['appNo', /başvuru\s*(no|numara)|application\s*no/i],
  ['regNo', /tescil\s*(no|numara)|registration\s*no/i],
  ['status', /durum|status|karar/i],
  ['classes', /s[ıi]n[ıi]f|nice|class/i],
  ['date', /başvuru\s*tarih|tarih|date/i],
];

/**
 * Nice sınıfları hücresi. TÜRKPATENT tabloda en fazla 6 sınıf gösterir, fazlası "..": "03 / 14 / 16 / 18 / 24 / 25 / .."
 * Uluslararası kayıtlarda "99 / *" yazar (sınıflar listelenmez). İkisinde de 25/35'in olup olmadığı tablodan okunamaz.
 */
function parseClasses(raw) {
  const s = String(raw || '');
  const nums = s.match(/\d{1,2}/g) || [];
  return {
    classes: nums.filter((c) => c !== '99'),
    classesTruncated: /\.\.|…/.test(s),
    classesAll: /\*/.test(s) || nums.includes('99'),
  };
}

/** tables: [{ headers: [...], rows: [[...], ...] }] → kayıt listesi */
function parseTables(tables) {
  const out = [];
  for (const t of tables || []) {
    const headers = (t.headers || []).map((h) => String(h || '').trim());
    const map = {};
    headers.forEach((h, i) => { for (const [k, re] of COLS) if (map[k] == null && re.test(h)) { map[k] = i; break; } });
    if (map.name == null || (map.status == null && map.regNo == null && map.appNo == null)) continue; // marka tablosu değil
    for (const r of t.rows || []) {
      const get = (k) => (map[k] != null ? String(r[map[k]] ?? '').replace(/\s+/g, ' ').trim() || null : null);
      const rec = { name: get('name'), owner: get('owner'), appNo: get('appNo'), regNo: get('regNo'), status: get('status'), ...parseClasses(get('classes')), date: get('date') };
      if (rec.name) out.push(rec);
    }
  }
  return out.slice(0, 300);
}

// Geçersiz kayıtlar: reddedilen, iptal edilen, süresi dolan, feragat edilen / geri çekilen
const DEAD = /red|ret\b|reddedil|geçersiz|gecersiz|iptal|sona\s*er|süresi\s*dol|hükümsüz|hukumsuz|vazgeç|vazgec|feragat|geri\s*çekil|geri\s*cekil|withdrawn|yenilenmedi|expired|refused|invalid/i;
// Tescilli: tescil numarası olan ya da durumu tescil/kabul (uluslararası kayıtlarda "Kabul Edildi")
const REG = /tescil|registered|kabul\s*edildi/i;

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const nClass = (c) => String(Number(c));

/** Arama sayfada 25/35 sınıf filtresiyle mi yapıldı? (filter: { equal, classes }) */
function filterApplied(filter, classes) {
  const want = (classes || []).map(nClass);
  const got = filter && Array.isArray(filter.classes) ? filter.classes.map(nClass) : [];
  return want.length > 0 && sameSet(want, got);
}

/**
 * Okunmuş kayıtlardan marka durumu.
 * filtered: arama sitede 25/35 filtresiyle yapıldı → listelenen her kayıt bu sınıflardan en az birini kapsar.
 * complete: sonuçların hepsi okundu mu (sayfalama). Eksikse "yok / sona ermiş" sonucuna varılmaz.
 */
function classifyRecords(brand, records, { classes = [], filtered = false, complete = true, total = null, noResult = false } = {}) {
  const at = Date.now();
  const key = normBrand(brand);
  if (!key) return { status: 'unverified', reason: 'Marka adı yok', records: [], at };
  const want = classes.map(nClass);
  const exact = records.filter((r) => normBrand(r.name) === key);
  // Sınıf kapsamı: filtreli aramada hepsi; değilse tabloda 25/35 görünen kayıtlar kesin, sınıfları kısaltılmış/okunamayanlar belirsiz
  const inScope = (r) => !want.length || filtered || (r.classes || []).some((c) => want.includes(nClass(c)));
  const unsure = (r) => !inScope(r) && (r.classesTruncated || r.classesAll || !(r.classes || []).length);
  const scoped = exact.filter(inScope);
  const unsureL = exact.filter(unsure);
  const other = exact.filter((r) => !inScope(r) && !unsure(r));
  // Durum metni Türkçe küçük harfe çevrilerek karşılaştırılır ("GEÇERSİZ", "İPTAL": büyük İ, /i bayrağıyla "i" ile eşleşmez)
  const st = (r) => String(r.status || '').toLocaleLowerCase('tr-TR');
  const alive = (r) => !DEAD.test(st(r));
  const registered = (r) => REG.test(st(r)) || !!r.regNo;
  // Gösterilecek kayıtlar sonucu açıklayan sırayla: geçerli tescil, başvuru, sınıfı belirsiz geçerli kayıt, geçersizler, başka sınıflar
  const order = [scoped.filter((r) => alive(r) && registered(r)), scoped.filter((r) => alive(r) && !registered(r)), unsureL.filter(alive), scoped.filter((r) => !alive(r)), unsureL.filter((r) => !alive(r)), other];
  const shown = [...new Set(order.flat())].slice(0, 10);
  const meta = { records: shown, filtered: !!filtered, at, ...(total != null ? { total, read: records.length } : {}) };
  const clothing = (list) => list.some((r) => (r.classes || []).some((c) => Number(c) === 25));
  const liveScoped = scoped.filter(alive);
  const regScoped = liveScoped.filter(registered);
  const where = want.length ? `${want.join('/')} sınıflarında ` : '';
  if (regScoped.length) return { status: 'active', reason: `Aktif tescil ${where}var${clothing(regScoped) ? ' (25. sınıf giyim dahil)' : ''}`.replace('  ', ' '), clothing: clothing(regScoped), ...meta };
  if (liveScoped.length) return { status: 'application', reason: `Başvuru aşamasında / karar bekleyen kayıt${where ? ' (' + want.join('/') + ' sınıfları)' : ''}`, clothing: clothing(liveScoped), ...meta };
  // Buradan sonrası "kayıt yok / geçersiz" sonucu: ancak sonuçların hepsi okunduysa ve sınıfı belirsiz yaşayan kayıt yoksa
  if (!complete) return { status: 'unverified', reason: `Sonuçların hepsi okunamadı${total != null ? ` (${records.length}/${total} kayıt)` : ''}`, ...meta };
  if (!records.length) return noResult ? { status: 'none', reason: `TÜRKPATENT'te bu adla ${where}kayıt bulunamadı`.replace('  ', ' '), records: [], filtered: !!filtered, at } : { status: 'unverified', reason: 'Sonuç tablosu okunamadı', records: [], at };
  if (!exact.length) return { status: 'none', reason: `Aynı adla kayıt yok (${records.length} benzer kayıt listelendi)`, similar: true, ...meta, records: records.slice(0, 10) };
  if (unsureL.some(alive)) return { status: 'unverified', reason: 'Sınıf listesi kısaltılmış kayıt var; 25/35 sınıflarını kapsayıp kapsamadığı tablodan okunamadı', ...meta };
  if (scoped.length || unsureL.length) return { status: 'expired', reason: 'Kayıtlar sona ermiş, reddedilmiş, geri çekilmiş veya geçersiz', ...meta };
  return { status: 'none', reason: `Aynı adla kayıt var ama ${want.join('/')} sınıflarında değil (${[...new Set(other.flatMap((r) => r.classes))].join(', ')})`, otherClasses: true, ...meta };
}

/**
 * Bir markanın arama sonucunu sınıflar.
 * page: { searched, noResultText, tables, blocked, filter|form: { equal, classes }, pager: { total, read } }
 */
function classifyBrand(brand, page, { classes = [] } = {}) {
  const at = Date.now();
  if (!page || page.blocked) return { status: 'unverified', reason: page && page.blocked ? 'Sorgu sayfası doğrulama istedi ya da erişimi sınırladı' : 'Sorgu yapılamadı', records: [], at };
  if (!normBrand(brand)) return { status: 'unverified', reason: 'Marka adı yok', records: [], at };
  const records = parseTables(page.tables);
  const filtered = filterApplied(page.form || page.filter, classes);
  const total = page.pager && Number.isFinite(page.pager.total) ? page.pager.total : null;
  const complete = total == null || records.length >= total;
  return classifyRecords(brand, records, { classes, filtered, complete, total, noResult: !!(page.searched && page.noResultText) });
}

/**
 * 25/35 sınıf filtresi olmadan (eski yöntemle) yapılmış sorgu sonuçlarını ayıklar (tek seferlik geçiş).
 * - Hiçbir ürünün markası olmayan sorgular silinir (eski hatalı marka adları: fiyat, emoji, ürün adının tamamı…).
 * - Filtresiz sonuçlar saklanan kayıtlarla yeniden değerlendirilir: 25/35 sınıfında geçerli kayıt tabloda AÇIKÇA görünüyorsa
 *   (tescilli / başvurulu) sonuç kesindir ve korunur; diğerleri silinir ve 25/35 filtresiyle yeniden sorgulanır.
 *   Eski tabloda sınıf listesi 6 sınıfta kesildiği için 6 sınıflı kayıtlar "kısaltılmış" sayılır.
 */
function pruneStaleChecks(checks, usedKeys, classes = ['25', '35']) {
  const out = {};
  const stats = { kept: 0, revalidated: 0, requery: 0, orphan: 0 };
  for (const [k, c] of Object.entries(checks || {})) {
    if (!c || typeof c !== 'object') continue;
    if (filterApplied(c.filter, classes)) { out[k] = c; stats.kept++; continue; }
    if (!usedKeys.has(k)) { stats.orphan++; continue; }
    const recs = (c.records || []).map((r) => {
      const cls = (r.classes || []).map(String);
      return { ...r, classes: cls.filter((x) => x !== '99'), classesTruncated: r.classesTruncated ?? cls.length >= 6, classesAll: r.classesAll ?? cls.includes('99') };
    });
    const re = classifyRecords(c.brand || k, recs, { classes, filtered: false, complete: false });
    if (re.status === 'active' || re.status === 'application') {
      out[k] = { ...c, ...re, at: c.at, filter: c.filter || null, revalidated: true };
      stats.revalidated++;
    } else stats.requery++;
  }
  return { checks: out, stats };
}

/** Trendyol yükleme sonucu mesajını sınıflar. */
function classifyJoinMessage(text) {
  const t = String(text || '');
  if (/başar[ıi]l[ıi]|success|onayland/i.test(t) && !/başar[ıi]s[ıi]z/i.test(t)) return 'ok';
  if (/belge|yetki\s*belgesi|fatura|distribütör|distributor|sertifika/i.test(t)) return 'docRequired';
  if (/marka/i.test(t) && /red|ret|izin|yetki|kısıt|kisit|engel|satamaz|satış.*kapalı/i.test(t)) return 'rejected';
  if (/başar[ıi]s[ıi]z|hata|error|fail|reddedil/i.test(t)) return 'failed';
  return null;
}

module.exports = { normBrand, parseClasses, parseTables, filterApplied, classifyRecords, classifyBrand, pruneStaleChecks, classifyJoinMessage };
