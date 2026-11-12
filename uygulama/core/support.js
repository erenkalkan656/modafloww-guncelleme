'use strict';
const { addAudit } = require('./audit');
const nowIso = () => new Date().toISOString();
const DAY = 86400000;

/**
 * Müşteri soruları ve iadeler (Trendyol V2).
 * Kişisel veri en aza indirilir: müşteri adı yalnızca Trendyol "gösterilebilir" dediyse tutulur, adres tutulmaz.
 */
const Q_STATUS = { WAITING_FOR_ANSWER: 'Cevap bekliyor', ANSWERED: 'Cevaplandı', REPORTED: 'Bildirildi', REJECTED: 'Reddedildi', UNANSWERED: 'Cevapsız kapandı' };

function minimizeQuestion(q) {
  return {
    id: q.id, text: q.text || '', status: q.status, creationDate: q.creationDate || null, productName: q.productName || null,
    imageUrl: q.imageUrl || null, webUrl: q.webUrl || null, productMainId: q.productMainId || null,
    userName: q.showUserName && q.userName ? q.userName : null, public: !!q.public,
    answer: q.answer ? { text: q.answer.text, creationDate: q.answer.creationDate } : null,
    rejectedAnswer: q.rejectedAnswer ? { text: q.rejectedAnswer.text, reason: q.rejectedAnswer.reason || null } : null,
    answeredDateMessage: q.answeredDateMessage || null,
  };
}

async function syncQuestions(client, store, { days = 28 } = {}) {
  const end = Date.now();
  const start = end - Math.min(days, 56) * DAY;
  const map = new Map((store.get('questions', { items: [] }).items || []).map((q) => [String(q.id), q]));
  let fetched = 0;
  for (let s = start; s < end; s += 14 * DAY) {
    const e = Math.min(s + 14 * DAY - 1, end);
    for (let page = 0; page < 40; page++) {
      const res = await client.getQuestions({ startDate: s, endDate: e, page, size: 50, orderByField: 'CreatedDate', orderByDirection: 'DESC' });
      const content = (res && Array.isArray(res.content)) ? res.content : [];
      for (const q of content) { map.set(String(q.id), minimizeQuestion(q)); fetched++; }
      if (page + 1 >= (res && res.totalPages || 0) || !content.length) break;
    }
  }
  const items = [...map.values()].filter((q) => !q.creationDate || q.creationDate > end - 90 * DAY).sort((a, b) => (b.creationDate || 0) - (a.creationDate || 0));
  store.set('questions', { syncedAt: nowIso(), items });
  return { fetched, waiting: items.filter((q) => q.status === 'WAITING_FOR_ANSWER').length };
}

async function answerQuestion(client, store, { id, text }) {
  const data = store.get('questions', { items: [] });
  const q = (data.items || []).find((x) => String(x.id) === String(id));
  if (!q) throw new Error('Soru bulunamadı; soruları yenileyin.');
  if (q.status !== 'WAITING_FOR_ANSWER') throw new Error('Bu soru cevap beklemiyor (durum: ' + (Q_STATUS[q.status] || q.status) + ').');
  const t = String(text || '').trim();
  if (t.length < 10) throw new Error('Cevap en az 10 karakter olmalı.');
  if (t.length > 2000) throw new Error('Cevap en fazla 2000 karakter olabilir.');
  if (q.sending) throw new Error('Bu soruya cevap zaten gönderiliyor.');
  q.sending = true;
  store.set('questions', data, { immediate: true });
  try {
    const r = await client.answerQuestion(id, t);
    q.status = 'ANSWERED';
    q.answer = { text: t, creationDate: Date.now(), answerId: r && r.answerId };
    addAudit(store, { type: 'question', action: 'Soru cevaplandı', status: 'success', title: q.productName, message: t.slice(0, 200) });
    return q;
  } catch (e) {
    addAudit(store, { type: 'question', action: 'Soru cevaplama', status: e.uncertain ? 'uncertain' : 'failed', title: q.productName, message: e.message });
    throw e;
  } finally {
    delete q.sending;
    store.set('questions', data, { immediate: true });
  }
}

const CLAIM_STATUS = { Created: 'Oluşturuldu', WaitingInAction: 'Aksiyon bekliyor', Accepted: 'Onaylandı', Cancelled: 'İptal', Rejected: 'Reddedildi', Unresolved: 'Çözümsüz', InAnalysis: 'İnceleniyor', WaitingFraudCheck: 'Kontrol bekliyor' };

function minimizeClaim(c) {
  return {
    id: c.id, claimId: c.claimId || c.id, orderNumber: c.orderNumber, orderDate: c.orderDate || null, claimDate: c.claimDate || null,
    customerName: [c.customerFirstName, c.customerLastName ? String(c.customerLastName).charAt(0) + '.' : null].filter(Boolean).join(' ') || null,
    cargoProviderName: c.cargoProviderName || null, cargoTrackingNumber: c.cargoTrackingNumber != null ? String(c.cargoTrackingNumber) : null, cargoTrackingLink: c.cargoTrackingLink || null,
    lastModifiedDate: c.lastModifiedDate || null,
    items: (c.items || []).flatMap((it) => (it.claimItems || [it]).map((ci) => ({
      barcode: it.orderLine && it.orderLine.barcode, productName: it.orderLine && it.orderLine.productName, size: it.orderLine && it.orderLine.productSize,
      color: it.orderLine && it.orderLine.productColor, price: it.orderLine && it.orderLine.price,
      reason: (ci.customerClaimItemReason && ci.customerClaimItemReason.name) || (ci.trendyolClaimItemReason && ci.trendyolClaimItemReason.name) || null,
      status: ci.claimItemStatus && ci.claimItemStatus.name, customerNote: ci.customerNote || null, autoAccepted: !!ci.autoAccepted,
    }))),
  };
}

/**
 * İade taleplerini son `days` gün için çeker (30 günlük pencerelerle, yeniden eskiye) ve önceki kayıtlarla birleştirir.
 * Trendyol bu aralığı talebin son güncellenme tarihine göre uygular. Eski bir pencere okunamaz veya boş dönerse o noktada durulur; okunan kısım korunur. Kayıtlar 400 gün saklanır.
 */
async function syncClaims(client, store, { days = 90, now = Date.now() } = {}) {
  const map = new Map();
  let reached = now;
  for (let e = now; e > now - days * DAY; e -= 30 * DAY) {
    const s = Math.max(e - 30 * DAY + 1, now - days * DAY);
    let got = 0;
    try {
      for (let page = 0; page < 50; page++) {
        const res = await client.getClaims({ startDate: s, endDate: e, page, size: 50 });
        const content = (res && Array.isArray(res.content)) ? res.content : [];
        for (const c of content) map.set(String(c.id), minimizeClaim(c));
        got += content.length;
        if (page + 1 >= (res && res.totalPages || 0) || !content.length) break;
      }
      // Boş dönen eski pencere "kayıt yok" mu "erişim yok" mu ayırt edilemez → kapsama sayılmaz, daha eskiye gidilmez
      if (e !== now && !got) break;
      reached = s;
    } catch (err) {
      if (e === now) throw err; // en yeni pencere bile okunamadıysa hata
      break;
    }
  }
  const prev = store.get('claims', { items: [] }) || { items: [] };
  const merged = new Map((prev.items || []).map((c) => [String(c.id), c]));
  for (const [k, v] of map) merged.set(k, v);
  const keep = now - 400 * DAY;
  const items = [...merged.values()].filter((c) => !c.claimDate || c.claimDate >= keep).sort((a, b) => (b.claimDate || 0) - (a.claimDate || 0));
  // Önceki kapsam yalnızca arada boşluk yoksa (önceki senkron bu çekimin başladığı yerden yeniyse) devralınır
  const prevAt = prev.syncedAt ? Date.parse(prev.syncedAt) : 0;
  const coveredFrom = Math.max(keep, prev.coveredFrom && prevAt >= reached ? Math.min(reached, prev.coveredFrom) : reached);
  store.set('claims', { syncedAt: nowIso(), coveredFrom, items });
  return { count: map.size, total: items.length, waiting: items.filter((c) => c.items.some((i) => i.status === 'WaitingInAction')).length };
}

module.exports = { syncQuestions, answerQuestion, syncClaims, minimizeQuestion, minimizeClaim, Q_STATUS, CLAIM_STATUS };
