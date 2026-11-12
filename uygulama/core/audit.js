'use strict';
const { uid, sanitize, nowIso } = require('./util');

const MAX_ENTRIES = 50000;

/**
 * Denetim kaydı (işlem geçmişi).
 * type: price | stock | reward | sync | order | automation | system | security
 * Kayıtlara gizli anahtar, çerez, erişim belirteci veya müşteri adres bilgisi yazılmaz.
 */
function addAudit(store, entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  const prepared = list.map((e) => sanitize({
    id: uid('a'),
    at: e.at || nowIso(),
    type: e.type || 'system',
    action: e.action || '',
    initiator: e.initiator || 'user', // user | automation | system
    status: e.status || 'info', // success | failed | uncertain | info | warning
    barcode: e.barcode || null,
    title: e.title || null,
    size: e.size || null,
    oldValue: e.oldValue ?? null,
    newValue: e.newValue ?? null,
    jobId: e.jobId || null,
    batchRequestId: e.batchRequestId || null,
    message: e.message || null,
    retry: e.retry || 0,
  }));
  store.update('audit', [], (cur) => {
    const next = cur.concat(prepared);
    return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
  });
  return prepared;
}

function queryAudit(store, { type, status, q, from, to, limit = 500, offset = 0 } = {}) {
  let list = store.get('audit', []);
  const ql = q ? String(q).toLocaleLowerCase('tr-TR') : null;
  const res = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (type && type !== 'all' && e.type !== type) continue;
    if (status && status !== 'all' && e.status !== status) continue;
    if (from && e.at < from) continue;
    if (to && e.at > to) continue;
    if (ql) {
      const hay = [e.barcode, e.title, e.action, e.message, e.jobId].filter(Boolean).join(' ').toLocaleLowerCase('tr-TR');
      if (!hay.includes(ql)) continue;
    }
    res.push(e);
  }
  return { total: res.length, items: res.slice(offset, offset + limit) };
}

module.exports = { addAudit, queryAudit, MAX_ENTRIES };
