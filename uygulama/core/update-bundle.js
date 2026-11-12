'use strict';
// Bilgisayar uygulamasının güncelleme paketi: uygulama dosyalarının (build/, core/, dist/, electron/, package.json,
// build-info.json) tek dosyada sıkıştırılmış hali. Paket açılırken HER dosya yolu denetlenir (yalnızca bu klasörler,
// ".." ya da mutlak yol yok) ve her dosyanın SHA-256 özeti doğrulanır; kurallara uymayan paket tümden reddedilir.
const zlib = require('zlib');
const crypto = require('crypto');

const ALLOWED = /^(?:(?:build|core|dist|electron)\/[A-Za-z0-9._\-/]+|package\.json|build-info\.json)$/;
const MAX_FILES = 600;
const MAX_BYTES = 60 * 1024 * 1024;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Paket içindeki göreli yol güvenli mi? */
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.length > 200) return false;
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || p.endsWith('/') || /(^|\/)\.\.?(\/|$)/.test(p) || p.includes('//') || /^[A-Za-z]:/.test(p)) return false;
  return ALLOWED.test(p);
}

/** files: [{ path, data: Buffer }] → sıkıştırılmış paket (Buffer). */
function packBundle(files, { build }) {
  if (!Number.isInteger(build) || build < 1) throw new Error('Geçersiz sürüm numarası');
  const out = [];
  const seen = new Set();
  for (const f of files) {
    if (!safeRel(f.path)) throw new Error('Pakete alınamayan yol: ' + f.path);
    if (seen.has(f.path)) throw new Error('Yinelenen yol: ' + f.path);
    seen.add(f.path);
    out.push({ p: f.path, h: sha256(f.data), d: f.data.toString('base64') });
  }
  for (const need of ['electron/main.js', 'package.json', 'build-info.json']) if (!seen.has(need)) throw new Error('Pakette eksik: ' + need);
  return zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, build, files: out })), { level: 9 });
}

/** Paketi açar ve doğrular → { build, files: [{ path, data }] }. Sorun varsa hata fırlatır (hiçbir dosya dönmez). */
function unpackBundle(buf, { expectBuild } = {}) {
  let json;
  try { json = JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: MAX_BYTES * 2 }).toString('utf8')); } catch (_) { throw new Error('Güncelleme paketi açılamadı (bozuk dosya).'); }
  if (!json || json.v !== 1 || !Number.isInteger(json.build) || !Array.isArray(json.files)) throw new Error('Güncelleme paketi tanınmadı.');
  if (expectBuild != null && json.build !== expectBuild) throw new Error('Güncelleme paketi beklenen sürüm değil.');
  if (!json.files.length || json.files.length > MAX_FILES) throw new Error('Güncelleme paketindeki dosya sayısı beklenenin dışında.');
  const files = [];
  const seen = new Set();
  let total = 0;
  for (const f of json.files) {
    if (!f || !safeRel(f.p) || seen.has(f.p) || typeof f.d !== 'string' || !/^[0-9a-f]{64}$/.test(String(f.h))) throw new Error('Güncelleme paketinde izin verilmeyen bir dosya var; paket reddedildi.');
    const data = Buffer.from(f.d, 'base64');
    total += data.length;
    if (total > MAX_BYTES) throw new Error('Güncelleme paketi çok büyük.');
    if (sha256(data) !== f.h) throw new Error('Güncelleme paketindeki bir dosya bozuk: ' + f.p);
    seen.add(f.p);
    files.push({ path: f.p, data });
  }
  for (const need of ['electron/main.js', 'package.json', 'build-info.json']) if (!seen.has(need)) throw new Error('Güncelleme paketi eksik: ' + need);
  let info;
  try { info = JSON.parse(files.find((f) => f.path === 'build-info.json').data.toString('utf8')); } catch (_) { info = null; }
  if (!info || info.build !== json.build) throw new Error('Güncelleme paketinin sürüm bilgisi tutarsız.');
  return { build: json.build, files };
}

/** latest.json doğrulaması → temiz nesne ya da null. */
function parseLatest(x) {
  if (!x || typeof x !== 'object') return null;
  const build = Number(x.build);
  if (!Number.isInteger(build) || build < 1) return null;
  if (typeof x.file !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(x.file) || x.file.includes('..')) return null;
  if (!/^[0-9a-f]{64}$/.test(String(x.sha256 || ''))) return null;
  const size = Number(x.size);
  if (!(size > 0 && size <= MAX_BYTES)) return null;
  return { build, version: String(x.version || '1.0.' + build).slice(0, 20), file: x.file, sha256: x.sha256, size, notes: String(x.notes || '').slice(0, 800), publishedAt: String(x.publishedAt || '').slice(0, 40) };
}

module.exports = { safeRel, packBundle, unpackBundle, parseLatest, sha256, MAX_BYTES };
