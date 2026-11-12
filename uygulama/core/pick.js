'use strict';
/**
 * "İşleme Al" (Trendyol'da paket durumu → Picking). Etiketi yazıcıya gönderilen siparişler için kullanılır.
 * Kurallar:
 *  - Yalnızca yeni paketler (Created / ReadyToShip); işleme alınmış, kargoda, iptal paketlere dokunulmaz.
 *  - Siparişin birden çok yeni paketi varsa (bölünmüş) hangisinin basıldığı bilinemez: dokunulmaz.
 *  - Paketin TÜM satırları adetleriyle gönderilir (lineId + quantity); satır bilgisi eksikse gönderilmez.
 *  - İstekler sırayla gider; biri başarısız olsa da diğerleri denenir, sonuç tek tek döner.
 */
const { NEW_STATUSES, STATUS_LABELS } = require('./orders');

/** Bir siparişin işleme alınacak paketi ve istek gövdesi; uygun değilse { error }. */
function pickingRequest(items, orderNumber) {
  const no = String(orderNumber);
  const recs = (items || []).filter((o) => o && String(o.orderNumber) === no);
  if (!recs.length) return { error: 'Sipariş uygulamada bulunamadı' };
  const open = recs.filter((o) => NEW_STATUSES.has(o.status));
  if (!open.length) {
    const st = recs[0].status;
    return { skip: true, error: st === 'Picking' ? 'Zaten işleme alınmış' : `Paket "${STATUS_LABELS[st] || st}" durumunda` };
  }
  if (open.length > 1) return { error: 'Sipariş birden çok pakete bölünmüş; panelden işleme alın' };
  const o = open[0];
  if (!o.shipmentPackageId) return { error: 'Paket numarası yok' };
  const lines = (o.lines || []).map((l) => ({ lineId: l.lineId == null ? null : Number(l.lineId), quantity: Number(l.quantity) }));
  if (!lines.length || lines.some((l) => !Number.isFinite(l.lineId) || !(l.quantity > 0))) return { error: 'Satır bilgisi eksik; siparişleri yenileyip tekrar deneyin' };
  return { packageId: String(o.shipmentPackageId), body: { lines, params: {}, status: 'Picking' } };
}

/**
 * @returns {Promise<{orderNumber, ok, skipped?, packageId?, message}[]>}
 */
async function pickPackages({ client, items, orderNumbers }) {
  const out = [];
  for (const no of [...new Set((orderNumbers || []).map(String))]) {
    const r = pickingRequest(items, no);
    if (r.error) { out.push({ orderNumber: no, ok: false, skipped: !!r.skip, message: r.error }); continue; }
    try {
      await client.updatePackageStatus(r.packageId, r.body);
      out.push({ orderNumber: no, ok: true, packageId: r.packageId, message: 'İşleme alındı' });
    } catch (e) {
      out.push({ orderNumber: no, ok: false, packageId: r.packageId, message: e && e.message ? String(e.message).slice(0, 200) : 'İşleme alınamadı', uncertain: !!(e && e.uncertain) });
    }
  }
  return out;
}

/** Başarıyla işleme alınan paketleri yerel kayıtta Picking yapar (bir sonraki eşitlemede Trendyol'dan doğrulanır). */
function markPicked(items, results, now = Date.now()) {
  const done = new Set((results || []).filter((r) => r.ok && r.packageId).map((r) => String(r.packageId)));
  if (!done.size) return { items, changed: 0 };
  let changed = 0;
  const next = (items || []).map((o) => {
    if (!o || !done.has(String(o.shipmentPackageId)) || !NEW_STATUSES.has(o.status)) return o;
    changed++;
    return { ...o, status: 'Picking', lastModifiedDate: now, history: [...(o.history || []), { date: now, status: 'Picking' }] };
  });
  return { items: next, changed };
}

module.exports = { pickingRequest, pickPackages, markPicked };
