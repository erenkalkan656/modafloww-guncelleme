'use strict';
// Trendyol "Güncel Kargo Fiyatları" PDF'ini (satıcı paneli › Kargo İşlemleri › Kargo Fiyatları & Desi) okur.
// Saf JavaScript: Node'da zlib, tarayıcıda DecompressionStream ile çalışır (inflate dışarıdan verilir).
// Çıktı: { effectiveDate, carriers: [...], rows: { desi: [fiyatlar...] } }  — fiyatlar KDV hariç TL.

function latin1(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; }

function parseCMap(t) {
  const m = {};
  const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
  let r;
  while ((r = re.exec(t))) { const a = parseInt(r[1], 16), b = parseInt(r[2], 16), c = parseInt(r[3], 16); for (let i = a; i <= b; i++) m[i] = String.fromCharCode(c + i - a); }
  return m;
}

function decodeLiteral(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push(c.charCodeAt(0)); continue; }
    const n = raw[i + 1];
    if (/[0-7]/.test(n)) { const o = raw.substr(i + 1, 3).match(/^[0-7]{1,3}/)[0]; out.push(parseInt(o, 8)); i += o.length; continue; }
    const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (n in map) { out.push(map[n]); i++; continue; }
    if (n === '\n' || n === '\r') { i++; continue; }
    out.push(n.charCodeAt(0)); i++;
  }
  return out;
}

/** PDF'ten nesneleri ve (sıkıştırılmışsa açılmış) akışları çıkarır. */
async function readObjects(bytes, inflate) {
  const s = latin1(bytes);
  const objs = {};
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const end = s.indexOf('endobj', re.lastIndex);
    if (end < 0) break;
    const body = s.slice(re.lastIndex, end);
    const si = body.indexOf('stream');
    let dict = body, stream = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      let start = re.lastIndex + si + 6;
      if (s[start] === '\r') start++;
      if (s[start] === '\n') start++;
      const se = s.indexOf('endstream', start);
      let raw = bytes.subarray(start, se);
      if (/FlateDecode/.test(dict)) { try { raw = await inflate(raw); } catch (_) { raw = null; } }
      stream = raw ? latin1(raw) : null;
    }
    objs[num] = { dict, stream };
    re.lastIndex = end + 6;
  }
  return objs;
}

const ref = (dict, key) => { const r = new RegExp('/' + key + '\\s+(\\d+)\\s+0\\s+R').exec(dict); return r ? Number(r[1]) : null; };

/** Bir sayfa içerik akışındaki metin parçalarını, okunma sırasıyla döndürür. */
function pageTokens(content, fonts) {
  const out = [];
  let font = null;
  const re = /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj|\[((?:\\[\s\S]|[^\]])*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1]) { font = fonts[m[1]] || null; continue; }
    let codes = [];
    if (m[2] !== undefined) codes = decodeLiteral(m[2]);
    else { const pr = /\(((?:\\[\s\S]|[^\\)])*)\)/g; let p; while ((p = pr.exec(m[3]))) codes.push(...decodeLiteral(p[1])); }
    const txt = codes.map((c) => (font ? (font[c] || '') : String.fromCharCode(c))).join('');
    out.push(txt);
  }
  return out;
}

const MONTHS = { ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6, temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12 };

async function parseCargoPdf(bytes, inflate) {
  const objs = await readObjects(bytes, inflate);
  const pages = Object.entries(objs).filter(([, o]) => /\/Type\s*\/Page\b/.test(o.dict)).map(([n, o]) => ({ n: Number(n), o }));
  const carriers = [];
  const rows = {};
  let effectiveDate = null;
  for (const { o } of pages) {
    const resNum = ref(o.dict, 'Resources');
    const resDict = resNum != null && objs[resNum] ? objs[resNum].dict : o.dict;
    const fonts = {};
    const fm = /\/Font\s*<<([^>]*)>>/.exec(resDict);
    if (fm) {
      const fr = /\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g; let f;
      while ((f = fr.exec(fm[1]))) {
        const fo = objs[Number(f[2])];
        const tu = fo ? ref(fo.dict, 'ToUnicode') : null;
        fonts[f[1]] = tu != null && objs[tu] && objs[tu].stream ? parseCMap(objs[tu].stream) : null;
      }
    }
    const cn = ref(o.dict, 'Contents');
    const content = cn != null && objs[cn] ? objs[cn].stream : null;
    if (!content) continue;
    const toks = pageTokens(content, fonts).map((t) => t.trim()).filter(Boolean);
    const joined = toks.join(' ');
    const dm = /(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})\s+İ?\s*T[İI]BAR/i.exec(joined);
    if (dm && !effectiveDate) { const mo = MONTHS[dm[2].toLocaleLowerCase('tr-TR')]; if (mo) effectiveDate = `${dm[3]}-${String(mo).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`; }
    const hi = toks.findIndex((t) => /^Desi\s*\/\s*KG$/i.test(t));
    if (hi < 0) continue;
    const head = [];
    let i = hi + 1;
    while (i < toks.length && !/^\d+$/.test(toks[i])) head.push(toks[i++]);
    if (!carriers.length) carriers.push(...head);
    const n = head.length;
    // Satırlar: tam sayı desi + n adet ondalıklı fiyat. Eksik sütunlu (100 desi üstü) satırlar atlanır.
    while (i < toks.length) {
      if (!/^\d+$/.test(toks[i])) { i++; continue; }
      const d = Number(toks[i]);
      const vals = toks.slice(i + 1, i + 1 + n);
      if (vals.length === n && vals.every((v) => /^\d+\.\d+$/.test(v))) {
        rows[d] = vals.map(Number);
        i += 1 + n;
      } else i++;
    }
  }
  const desis = Object.keys(rows).map(Number).sort((a, b) => a - b);
  if (!carriers.length || desis.length < 10 || desis[0] !== 0) throw new Error('Kargo fiyat listesi okunamadı (beklenmeyen PDF yapısı)');
  return { effectiveDate, carriers, rows, maxDesi: desis[desis.length - 1] };
}

module.exports = { parseCargoPdf };
