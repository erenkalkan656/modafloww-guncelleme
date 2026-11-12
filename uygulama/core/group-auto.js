'use strict';
// Ürün grubu otomasyonu: seçili ürün/bedenlerin TOPLAM satışı hedefe ulaşınca grubun stoku 0'a çekilir
// (önceki stok saklanır, yeniden açınca geri yüklenir).
//
// Bu dosya saf iş kurallarıdır (ağ / depo erişimi yok). Ortak sunucu (Cloudflare Worker) tek yürütücüdür;
// bilgisayar ve telefon uygulamaları aynı doğrulama ve önizleme kurallarını bu dosyadan kullanır.
//
// Çift sayım koruması: her sipariş satırı "paketNo:satırNo" anahtarıyla bir kez tutulur. Aynı satır kaç kez
// okunursa okunsun (iki cihaz, tekrar eden zamanlanmış çalışma) toplam değişmez. İptal edilen satır sayımdan düşer.
const { orderTime } = require('./orders');

const LIMITS = { name: 80, items: 300, target: 100000, reopenHours: 24 * 60 };
const STATES = {
  draft: 'Pasif',
  active: 'Etkin · sayıyor',
  triggering: 'Kapatılıyor',
  closed: 'Kapatıldı (stok 0)',
  reopening: 'Yeniden açılıyor',
  uncertain: 'Sonuç belirsiz — kontrol gerekli',
  error: 'Hata',
};
// Bu durumlardaki satırlar satış sayılmaz
const NOT_SOLD = /cancel|unsupplied|returned|undelivered/i;
const BARCODE_RX = /^[A-Za-z0-9._-]{1,40}$/;

/** Sipariş satırının tekil anahtarı (paket + satır). Paket no yoksa sipariş no kullanılır. */
function lineKey(order, line, index = 0) {
  const pkg = order && (order.shipmentPackageId ?? order.id ?? order.orderNumber);
  const ln = line && (line.lineId ?? line.id ?? `i${index}`);
  return `${pkg}:${ln}`;
}

/**
 * Kural girdisini doğrular ve sadeleştirir. Hata varsa { errors } döner.
 * items: [{ barcode, title?, size?, productMainId?, image? }]
 */
function normalizeRule(input, { now = Date.now() } = {}) {
  const errors = [];
  const r = input || {};
  const name = String(r.name || '').trim().slice(0, LIMITS.name);
  if (!name) errors.push('Kural adı gerekli');
  const seen = new Set();
  const items = [];
  for (const it of Array.isArray(r.items) ? r.items : []) {
    const barcode = String((it && it.barcode) || '').replace(/\s+/g, '');
    if (!BARCODE_RX.test(barcode)) { errors.push(`Geçersiz barkod: ${barcode || '(boş)'}`); continue; }
    if (seen.has(barcode)) continue;
    seen.add(barcode);
    items.push({
      barcode,
      title: it.title ? String(it.title).slice(0, 200) : null,
      size: it.size ? String(it.size).slice(0, 20) : null,
      productMainId: it.productMainId ? String(it.productMainId).slice(0, 100) : null,
      image: typeof it.image === 'string' && /^https:\/\//.test(it.image) ? it.image.slice(0, 500) : null,
    });
  }
  if (!items.length) errors.push('En az bir ürün/beden seçin');
  if (items.length > LIMITS.items) errors.push(`Bir kuralda en fazla ${LIMITS.items} varyant olabilir`);
  const target = Number(r.target);
  if (!Number.isInteger(target) || target < 1 || target > LIMITS.target) errors.push('Satış hedefi 1 ile 100.000 arasında tam sayı olmalı');
  let reopenAfterHours = r.reopenAfterHours == null || r.reopenAfterHours === '' ? null : Number(r.reopenAfterHours);
  if (reopenAfterHours != null && (!Number.isInteger(reopenAfterHours) || reopenAfterHours < 1 || reopenAfterHours > LIMITS.reopenHours)) errors.push('Otomatik yeniden açma 1–1440 saat arası olmalı (boş: elle)');
  // Sayım başlangıcı: verilmezse etkinleştirildiği an. Geçmişe en fazla 30 gün (Trendyol sipariş geçmişi sınırı).
  let countFrom = r.countFrom == null || r.countFrom === '' ? null : Date.parse(r.countFrom);
  if (countFrom != null && !Number.isFinite(countFrom)) { errors.push('Sayım başlangıç tarihi geçersiz'); countFrom = null; }
  if (countFrom != null && countFrom < now - 30 * 86400000) errors.push('Sayım başlangıcı en fazla 30 gün öncesi olabilir');
  if (countFrom != null && countFrom > now + 365 * 86400000) errors.push('Sayım başlangıcı çok ileri bir tarih');
  if (errors.length) return { errors };
  return {
    rule: {
      name, items, target,
      reopenAfterHours: reopenAfterHours == null ? null : reopenAfterHours,
      countFrom: countFrom == null ? null : new Date(countFrom).toISOString(),
      note: r.note ? String(r.note).slice(0, 500) : null,
    },
  };
}

/**
 * Siparişlerden kurala ait satırları çıkarır. Dönen her kayıt tekil anahtar taşır; depoya "varsa güncelle"
 * mantığıyla yazılır (çift sayım olmaz, sonradan iptal edilen satır sayımdan düşer).
 * @returns {{ key, orderNumber, barcode, qty, sold, at }[]}
 */
function extractLines(orders, rule, countFromMs) {
  const set = new Set(rule.items.map((i) => i.barcode));
  const out = [];
  for (const o of orders || []) {
    const t = orderTime(o);
    if (t == null || t < countFromMs) continue;
    const pkgCancelled = NOT_SOLD.test(String(o.status || o.shipmentPackageStatus || ''));
    (o.lines || []).forEach((l, i) => {
      const bc = String(l.barcode || '');
      if (!set.has(bc)) return;
      const qty = Math.max(0, Math.floor(Number(l.quantity) || 0));
      const lineStatus = String(l.status || l.orderLineItemStatusName || '');
      const sold = !pkgCancelled && !NOT_SOLD.test(lineStatus);
      out.push({ key: lineKey(o, l, i), orderNumber: String(o.orderNumber || ''), barcode: bc, qty, sold, at: t });
    });
  }
  return out;
}

/** Tekil satırlardan toplam (yalnızca satılmış sayılanlar). lines: Map<key,{qty,sold}> veya dizi */
function totalSold(lines) {
  let n = 0;
  for (const l of lines instanceof Map ? lines.values() : lines || []) if (l.sold) n += l.qty;
  return n;
}

/** Bellek içi tekilleştirme (testler ve önizleme için): aynı anahtar son okunan değerle güncellenir. */
function mergeLines(map, lines) {
  for (const l of lines) map.set(l.key, l);
  return map;
}

/**
 * Kapatma planı: GÜNCEL stok (Trendyol'dan az önce okunmuş) ile hesaplanır, eski veriyle asla.
 * live: Map<barcode,{quantity}>
 */
function planClose(rule, live, blocked = null) {
  const send = [], saved = {}, skipped = [], missing = [];
  for (const it of rule.items) {
    if (blocked && blocked.has(String(it.barcode))) { skipped.push({ barcode: it.barcode, reason: 'Kara listede: dokunulmadı' }); continue; }
    const cur = live.get(it.barcode);
    if (!cur || !Number.isFinite(Number(cur.quantity))) { missing.push(it.barcode); continue; }
    const q = Number(cur.quantity);
    if (q <= 0) { skipped.push({ barcode: it.barcode, reason: 'Stok zaten 0' }); continue; }
    saved[it.barcode] = q;
    send.push({ barcode: it.barcode, quantity: 0 });
  }
  return { send, saved, skipped, missing };
}

/**
 * Yeniden açma planı: saklanan stoku geri yükler. Kapatıldıktan sonra stoğu elle değiştirilmiş (0 olmayan)
 * barkodlara dokunulmaz; üzerine yazılmaz.
 */
function planReopen(saved, live, blocked = null) {
  const send = [], skipped = [], missing = [];
  for (const [barcode, qty] of Object.entries(saved || {})) {
    if (blocked && blocked.has(String(barcode))) { skipped.push({ barcode, reason: 'Kara listede: dokunulmadı' }); continue; }
    const cur = live.get(barcode);
    if (!cur) { missing.push(barcode); continue; }
    if (Number(cur.quantity) !== 0) { skipped.push({ barcode, reason: `Stok bu arada değişmiş (${cur.quantity}); dokunulmadı` }); continue; }
    send.push({ barcode, quantity: Number(qty) });
  }
  return { send, skipped, missing };
}

/** Etkin kurallar arasında aynı barkod iki kuralda olamaz (biri kapatıp diğeri açarsa birbirini bozar). */
function findOverlaps(rule, others) {
  const mine = new Set(rule.items.map((i) => i.barcode));
  const out = [];
  for (const o of others || []) {
    if (o.id === rule.id || !['active', 'triggering', 'closed', 'reopening', 'uncertain'].includes(o.state)) continue;
    const common = o.items.filter((i) => mine.has(i.barcode)).map((i) => i.barcode);
    if (common.length) out.push({ ruleId: o.id, name: o.name, barcodes: common });
  }
  return out;
}

/** Toplu işlem sonucunu (batch) yorumlar. */
function batchOutcome(batch, sent) {
  const items = (batch && batch.items) || [];
  if (!items.length) return { done: false };
  const byBc = new Map(items.map((x) => [String((x.requestItem && x.requestItem.barcode) || x.barcode), x]));
  const ok = [], failed = [];
  for (const s of sent) {
    const r = byBc.get(s.barcode);
    if (!r) return { done: false };
    if (String(r.status).toUpperCase() === 'SUCCESS') ok.push(s.barcode);
    else failed.push({ barcode: s.barcode, reason: (r.failureReasons || []).join(', ') || r.status });
  }
  return { done: true, ok, failed };
}

/** Kartlarda gösterilecek özet. */
function progressOf(rule, sold) {
  const pct = rule.target > 0 ? Math.min(100, Math.round((sold / rule.target) * 100)) : 0;
  return { sold, target: rule.target, remaining: Math.max(0, rule.target - sold), pct, reached: sold >= rule.target };
}

module.exports = { LIMITS, STATES, NOT_SOLD, lineKey, normalizeRule, extractLines, totalSold, mergeLines, planClose, planReopen, findOverlaps, batchOutcome, progressOf };
