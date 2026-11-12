'use strict';
/**
 * Trendyol "Katalogdan Ürün Ekle > Ürün Transferi" Excel dosyası.
 * Şablon (Trendyol'dan indirilen urun-transferi.xlsx): tek sayfa "Ürün Transferi",
 * sütunlar: Barkod | Stok Kodu | Trendyol'da Satılacak Fiyat (KDV Dahil) | Ürün Stok Adedi | KDV Oranı
 * KDV Oranı listesi gizli "VAT_RATE_LIST" sayfasından gelir (0, 1, 10, 20).
 * Barkod, Trendyol'da zaten satılan ürünün ilgili bedeninin barkodudur (eklenti ürün sayfasından okur).
 */
const zlib = require('zlib');

const HEADERS = ['Barkod', 'Stok Kodu', "Trendyol'da Satılacak Fiyat (KDV Dahil)", 'Ürün Stok Adedi', 'KDV Oranı'];
const VAT_RATES = [0, 1, 10, 20];

const normSize = (s) => String(s || '').trim().toLocaleUpperCase('tr-TR').replace(/\s+/g, '');
const money = (v) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 && n < 1e6 ? Math.round(n * 100) / 100 : null; };
const qtyOf = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : NaN; };
const stockCode = (prefix, contentId, size) => `${String(prefix || 'MF').replace(/[^A-Za-z0-9-]/g, '').slice(0, 10) || 'MF'}-${contentId}-${normSize(size).replace(/[^A-Z0-9]/g, '') || 'TEK'}`.slice(0, 60);

/**
 * plans: { [contentId]: { price, qty: { [size]: n } } }, items: opp kayıtları, opts: { kdv, prefix, ownContent: Set }
 * Sonuç: satırlar + ürün bazında durum (hazır / sorun). Hiçbir şey göndermez.
 */
function buildTransfer({ items, plans = {}, kdv = 10, prefix = 'MF', ownContent = new Set() }) {
  if (!VAT_RATES.includes(Number(kdv))) throw new Error('KDV oranı 0, 1, 10 veya 20 olmalı');
  const rows = [], products = [];
  for (const it of items) {
    const plan = plans[it.contentId] || {};
    const p = { contentId: it.contentId, title: it.title, problems: [], notes: [], rows: 0 };
    products.push(p);
    if (ownContent.has(String(it.contentId))) { p.problems.push('Bu ürün zaten senin kataloğunda'); continue; }
    if (!it.variants || !it.variants.length) { p.problems.push('Beden barkodları okunmadı (eklentiden "Eksik bilgileri kontrol et")'); continue; }
    const price = money(plan.price);
    if (price == null) { p.problems.push('Satış fiyatı girilmedi'); continue; }
    const want = Object.entries(plan.qty || {}).map(([size, q]) => [size, qtyOf(q)]).filter(([, q]) => q != null);
    if (want.some(([, q]) => Number.isNaN(q))) { p.problems.push('Stok adedi tam sayı olmalı'); continue; }
    const chosen = want.filter(([, q]) => q > 0);
    if (!chosen.length) { p.problems.push('Hiçbir bedene stok girilmedi'); continue; }
    for (const [size, q] of chosen) {
      const v = it.variants.find((x) => normSize(x.size) === normSize(size));
      if (!v) { p.notes.push(`${size} bedeni bu üründe yok, atlandı`); continue; }
      if (v.inStock === false) p.notes.push(`${v.size}: Trendyol'da şu an stokta görünmüyor`);
      rows.push({ contentId: it.contentId, size: v.size, barcode: v.barcode, stockCode: stockCode(prefix, it.contentId, v.size), price, qty: q, kdv: Number(kdv) });
      p.rows++;
    }
    if (!p.rows && !p.problems.length) p.problems.push('Girilen bedenlerin hiçbiri bu üründe yok');
  }
  return { rows, products, ready: products.filter((p) => p.rows && !p.problems.length).length };
}

// ---------- Basit .xlsx yazıcı (bağımlılıksız) ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const col = (i) => String.fromCharCode(65 + i);
const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);

function sheetXml(rows, extra = '') {
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v == null || v === '' ? '' : cell(col(ci) + (ri + 1), v))).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${body}</sheetData>${extra}</worksheet>`;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Trendyol şablonuyla aynı yapıda .xlsx üretir. */
function transferXlsx(rows) {
  const data = [HEADERS, ...rows.map((r) => [String(r.barcode), r.stockCode, r.price, r.qty, String(r.kdv)])];
  const dv = `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="E2:E1048576"><formula1>VAT_RATE_LIST</formula1></dataValidation></dataValidations>`;
  const ns = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${ns}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Ürün Transferi" sheetId="1" r:id="rId1"/><sheet name="VAT_RATE_LIST" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="VAT_RATE_LIST">VAT_RATE_LIST!$A$1:$A$4</definedName></definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${ns}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>`],
    ['xl/worksheets/sheet1.xml', sheetXml(data, dv)],
    ['xl/worksheets/sheet2.xml', sheetXml(VAT_RATES.map((v) => [String(v)]))],
  ]);
}

module.exports = { HEADERS, VAT_RATES, buildTransfer, transferXlsx, stockCode, normSize, money };
