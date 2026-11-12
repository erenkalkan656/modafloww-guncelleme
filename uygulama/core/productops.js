'use strict';
const { uid, sha1, sleep, nowIso, round2 } = require('./util');
const { addAudit } = require('./audit');

/**
 * Ürün düzeyindeki işlemler: Ürünü kopyala, Varyant ekle, Arşivle / Arşivden çıkar, Ürün bilgisi güncelle.
 * Hepsi Trendyol V2 toplu (batch) servisleriyle yapılır ve sonucu batch kontrolüyle kalem bazında izlenir.
 *
 * Güvenlik:
 * - İstek gönderilmeden önce kayıt diske yazılır.
 * - Aynı içerik 15 dakika içinde ikinci kez gönderilemez (çift tıklama / tekrar koruması).
 * - Zaman aşımı veya sunucu hatasında istek OTOMATİK TEKRARLANMAZ; durum "belirsiz" olarak gösterilir.
 */
const DUP_WINDOW = 15 * 60 * 1000;
const BARCODE_RX = /^[A-Za-z0-9._-]{1,40}$/;

class OpError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

// ---------------------------------------------------------------- Yardımcılar
function mergeAttributes(contentAttrs, variantAttrs, override) {
  const map = new Map();
  for (const a of contentAttrs || []) if (a && a.attributeId != null) map.set(a.attributeId, a);
  for (const a of variantAttrs || []) if (a && a.attributeId != null) map.set(a.attributeId, a);
  if (override) map.set(override.attributeId, override);
  return [...map.values()].map((a) => (a.attributeValueId != null
    ? { attributeId: a.attributeId, attributeValueIds: [a.attributeValueId] }
    : { attributeId: a.attributeId, attributeValue: String(a.attributeValue == null ? '' : a.attributeValue) }))
    .filter((a) => a.attributeValueIds || a.attributeValue !== '');
}

function cleanBarcode(b) { return String(b == null ? '' : b).replace(/\s+/g, ''); }

function validateRows(rows, existingBarcodes) {
  const errors = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    const n = `Satır ${i + 1}`;
    const bc = cleanBarcode(r.barcode);
    if (!BARCODE_RX.test(bc)) errors.push(`${n}: barkod 1–40 karakter olmalı; yalnızca harf, rakam, nokta, tire ve alt çizgi kullanılabilir`);
    else if (seen.has(bc)) errors.push(`${n}: barkod bu formda iki kez yazılmış (${bc})`);
    else if (existingBarcodes.has(bc)) errors.push(`${n}: ${bc} barkodu mağazanızda zaten var`);
    seen.add(bc);
    if (!String(r.stockCode || '').trim()) errors.push(`${n}: stok kodu gerekli`);
    else if (String(r.stockCode).length > 100) errors.push(`${n}: stok kodu en fazla 100 karakter`);
    const q = Number(r.quantity);
    if (!Number.isInteger(q) || q < 0 || q > 20000) errors.push(`${n}: stok 0–20.000 arası tam sayı olmalı`);
    const sp = Number(r.salePrice), lp = Number(r.listPrice);
    if (!(sp > 0)) errors.push(`${n}: satış fiyatı sıfırdan büyük olmalı`);
    if (!(lp > 0)) errors.push(`${n}: liste fiyatı sıfırdan büyük olmalı`);
    if (sp > 0 && lp > 0 && lp < sp) errors.push(`${n}: liste fiyatı satış fiyatından düşük olamaz`);
  });
  return errors;
}

function baseItem({ content, variant, title, productMainId, desi, description }) {
  return {
    title: String(title).trim(),
    productMainId: String(productMainId).trim(),
    brandId: content.brandId,
    categoryId: content.categoryId,
    dimensionalWeight: Number(desi),
    description: description != null ? description : content.description,
    vatRate: variant.vatRate,
    images: (content.images || []).slice(0, 8).map((url) => ({ url })),
    ...(Number.isFinite(variant.deliveryDuration) ? { deliveryOption: { deliveryDuration: variant.deliveryDuration } } : {}),
  };
}

function validateCommon({ content, title, productMainId, desi, description, vatRate }) {
  const errors = [];
  if (!content) errors.push('Ürün içerik bilgisi bulunamadı. Önce ürünleri yeniden senkronize edin.');
  else {
    if (content.brandId == null) errors.push('Marka kimliği (brandId) bilinmiyor. Yeniden senkronize edin.');
    if (content.categoryId == null) errors.push('Kategori kimliği (categoryId) bilinmiyor. Yeniden senkronize edin.');
    if (!(content.images || []).length) errors.push('Kaynak üründe görsel yok; Trendyol en az bir görsel ister.');
  }
  const t = String(title || '').trim();
  if (!t) errors.push('Ürün adı gerekli');
  else if (t.length > 100) errors.push('Ürün adı en fazla 100 karakter olabilir');
  const pm = String(productMainId || '').trim();
  if (!pm) errors.push('Model kodu gerekli');
  else if (pm.length > 40) errors.push('Model kodu en fazla 40 karakter olabilir');
  if (!(Number(desi) > 0)) errors.push('Desi (dimensionalWeight) sıfırdan büyük olmalı');
  if (!String(description || '').trim()) errors.push('Açıklama boş olamaz');
  if (!Number.isInteger(Number(vatRate))) errors.push('KDV oranı bilinmiyor; yeniden senkronize edin');
  return errors;
}

// ---------------------------------------------------------------- Planlayıcılar (saf)
/**
 * Ürünü kopyala: kaynak ürünün tüm nitelik/görsel/kategori/marka bilgileriyle YENİ bir ürün oluşturur.
 * form = { title, productMainId, desi, description?, rows: [{ sourceBarcode, barcode, stockCode, quantity, salePrice, listPrice }] }
 */
function planCopy({ catalog, contentId, form }) {
  const content = catalog.contents && catalog.contents[contentId];
  const sources = new Map(catalog.variants.filter((v) => v.contentId === contentId).map((v) => [v.barcode, v]));
  const rows = (form.rows || []).filter((r) => r && r.include !== false);
  const existing = new Set(catalog.variants.map((v) => v.barcode));
  const ref = rows.length ? sources.get(rows[0].sourceBarcode) : null;
  const errors = [
    ...validateCommon({ content, title: form.title, productMainId: form.productMainId, desi: form.desi, description: form.description != null ? form.description : content && content.description, vatRate: ref && ref.vatRate }),
    ...(!rows.length ? ['En az bir varyant seçin'] : []),
    ...validateRows(rows, existing),
  ];
  if (content && String(form.productMainId || '').trim() === content.productMainId) errors.push('Kopya için YENİ bir model kodu girin (aynı model kodu yeni ürün oluşturmaz, mevcut ürüne varyant ekler).');
  const usedModel = catalog.variants.some((v) => v.productMainId === String(form.productMainId || '').trim() && v.contentId !== contentId);
  if (usedModel) errors.push('Bu model kodu mağazanızda başka bir ürüne ait.');
  if (errors.length) return { ok: false, errors, items: [] };
  const items = rows.map((r) => {
    const src = sources.get(r.sourceBarcode);
    if (!src) throw new OpError('Kaynak varyant bulunamadı: ' + r.sourceBarcode);
    return {
      ...baseItem({ content, variant: src, title: form.title, productMainId: form.productMainId, desi: form.desi, description: form.description }),
      barcode: cleanBarcode(r.barcode),
      stockCode: String(r.stockCode).trim(),
      quantity: Number(r.quantity),
      salePrice: round2(Number(r.salePrice)),
      listPrice: round2(Number(r.listPrice)),
      attributes: mergeAttributes(content.attributes, src.variantAttributes),
    };
  });
  return { ok: true, errors: [], items };
}

/**
 * Varyant ekle: aynı model koduna (productMainId) yeni beden/varyant değeriyle yeni barkod ekler.
 * form = { referenceBarcode, attributeId, desi, rows: [{ attributeValueId, attributeValue, barcode, stockCode, quantity, salePrice, listPrice }] }
 */
function planAddVariants({ catalog, contentId, form }) {
  const content = catalog.contents && catalog.contents[contentId];
  const ref = catalog.variants.find((v) => v.barcode === form.referenceBarcode && v.contentId === contentId);
  const rows = (form.rows || []).filter((r) => r && r.include !== false);
  const existing = new Set(catalog.variants.map((v) => v.barcode));
  const errors = [
    ...(!ref ? ['Örnek alınacak varyant bulunamadı'] : []),
    ...validateCommon({ content, title: content && content.title, productMainId: content && content.productMainId, desi: form.desi, description: content && content.description, vatRate: ref && ref.vatRate }),
    ...(form.attributeId == null ? ['Varyant niteliği (ör. Beden) seçilmedi'] : []),
    ...(!rows.length ? ['En az bir yeni varyant değeri seçin'] : []),
    ...validateRows(rows, existing),
  ];
  const present = new Set(catalog.variants.filter((v) => v.contentId === contentId).flatMap((v) => (v.variantAttributes || []).filter((a) => a.attributeId === form.attributeId).map((a) => String(a.attributeValueId))));
  rows.forEach((r, i) => {
    if (r.attributeValueId == null && !String(r.attributeValue || '').trim()) errors.push(`Satır ${i + 1}: varyant değeri seçilmedi`);
    if (r.attributeValueId != null && present.has(String(r.attributeValueId))) errors.push(`Satır ${i + 1}: "${r.attributeValue}" bu üründe zaten var`);
  });
  const vals = rows.map((r) => String(r.attributeValueId != null ? r.attributeValueId : r.attributeValue));
  if (new Set(vals).size !== vals.length) errors.push('Aynı varyant değeri iki kez seçilmiş');
  if (errors.length) return { ok: false, errors, items: [] };
  const items = rows.map((r) => ({
    ...baseItem({ content, variant: ref, title: content.title, productMainId: content.productMainId, desi: form.desi }),
    barcode: cleanBarcode(r.barcode),
    stockCode: String(r.stockCode).trim(),
    quantity: Number(r.quantity),
    salePrice: round2(Number(r.salePrice)),
    listPrice: round2(Number(r.listPrice)),
    attributes: mergeAttributes(content.attributes, ref.variantAttributes, r.attributeValueId != null
      ? { attributeId: form.attributeId, attributeValueId: r.attributeValueId }
      : { attributeId: form.attributeId, attributeValueId: null, attributeValue: r.attributeValue }),
  }));
  return { ok: true, errors: [], items };
}

function planArchive({ catalog, barcodes, archived }) {
  const map = new Map(catalog.variants.map((v) => [v.barcode, v]));
  const errors = [];
  const items = [];
  for (const b of [...new Set(barcodes || [])]) {
    const v = map.get(b);
    if (!v) { errors.push(`${b} katalogda yok`); continue; }
    if (v.conflict) { errors.push(`${b} barkod çakışmalı`); continue; }
    if (!!v.archived === !!archived) continue; // zaten istenen durumda
    items.push({ barcode: b, archived: !!archived });
  }
  if (!items.length && !errors.length) errors.push(archived ? 'Seçilen varyantların hepsi zaten arşivde.' : 'Seçilen varyantların hiçbiri arşivde değil.');
  return { ok: !errors.length, errors, items };
}

function planContentUpdate({ catalog, contentId, title, description }) {
  const content = catalog.contents && catalog.contents[contentId];
  const errors = [];
  if (!content) errors.push('Ürün içerik bilgisi yok. Yeniden senkronize edin.');
  const item = { contentId: Number(contentId) };
  const t = title != null ? String(title).trim() : null;
  if (t != null && content && t !== content.title) {
    if (!t) errors.push('Ürün adı boş olamaz');
    else if (t.length > 100) errors.push('Ürün adı en fazla 100 karakter');
    item.title = t;
  }
  if (description != null && content && description !== content.description) {
    if (!String(description).trim()) errors.push('Açıklama boş olamaz');
    else if (String(description).length > 30000) errors.push('Açıklama en fazla 30.000 karakter');
    item.description = description;
  }
  if (!errors.length && item.title == null && item.description == null) errors.push('Değişiklik yok.');
  return { ok: !errors.length, errors, items: errors.length ? [] : [item] };
}

// ---------------------------------------------------------------- İzleyici
function findBarcode(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  if (typeof obj.barcode === 'string' || typeof obj.barcode === 'number') return String(obj.barcode);
  for (const v of Object.values(obj)) {
    const r = findBarcode(v, depth + 1);
    if (r) return r;
  }
  return null;
}

const KIND = {
  copy: { label: 'Ürün kopyalama', call: (c, items) => c.createProducts(items), key: (i) => i.barcode },
  addVariant: { label: 'Varyant ekleme', call: (c, items) => c.createProducts(items), key: (i) => i.barcode },
  archive: { label: 'Arşivleme', call: (c, items) => c.setArchiveState(items), key: (i) => i.barcode },
  content: { label: 'Ürün bilgisi güncelleme', call: (c, items) => c.updateContentBulk(items), key: (i) => 'content:' + i.contentId },
};

class ProductOps {
  constructor({ store, getClient, emit = () => {}, pollIntervalMs = 3000, pollTimeoutMs = 120000 }) {
    this.store = store;
    this.getClient = getClient;
    this.emit = emit;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.running = new Set();
  }
  list() { return this.store.get('productOps', []); }
  get(id) { return this.list().find((o) => o.id === id) || null; }
  save(op) {
    const c = { total: op.items.length, success: 0, failed: 0, submitted: 0, uncertain: 0 };
    for (const it of op.items) c[it.status] = (c[it.status] || 0) + 1;
    op.counts = c;
    op.status = c.uncertain ? 'needs_verification' : c.submitted ? 'submitted' : c.success && !c.failed ? 'completed' : c.success ? 'partial' : c.failed ? 'failed' : op.status;
    op.updatedAt = nowIso();
    const list = this.list();
    const i = list.findIndex((o) => o.id === op.id);
    if (i === -1) list.push(op); else list[i] = op;
    this.store.set('productOps', list.length > 200 ? list.slice(-200) : list, { immediate: true });
    this.emit('product-op', op);
    return op;
  }

  /** İşlemi gönderir ve sonucunu (en fazla pollTimeoutMs) izler. */
  async run({ kind, items, title, meta = {}, initiator = 'user' }) {
    const def = KIND[kind];
    if (!def) throw new OpError('Geçersiz işlem türü');
    if (!items || !items.length) throw new OpError('Gönderilecek kalem yok');
    const client = this.getClient();
    if (!client) throw new OpError('Trendyol API bilgileri girilmemiş');
    const fingerprint = sha1(kind + '|' + JSON.stringify(items));
    const now = Date.now();
    const dup = this.list().find((o) => o.fingerprint === fingerprint && o.status !== 'failed' && now - Date.parse(o.createdAt) < DUP_WINDOW);
    if (dup) throw new OpError(`Aynı işlem 15 dakika içinde zaten gönderildi (${dup.id}). Tekrar gönderilmedi.`);
    if (this.running.has(fingerprint)) throw new OpError('Bu işlem şu anda gönderiliyor.');
    this.running.add(fingerprint);
    const op = {
      id: uid('urun-'), kind, label: def.label, title: title || def.label, meta, initiator, env: client.env, fingerprint,
      createdAt: nowIso(), status: 'sending', batchRequestId: null,
      items: items.map((i) => ({ key: def.key(i), status: 'submitted', failureReasons: [], request: i })),
    };
    op.items.forEach((i) => { i.status = 'sending'; });
    this.save(op);
    try {
      let res;
      try {
        res = await def.call(client, items);
      } catch (e) {
        const st = e.uncertain ? 'uncertain' : 'failed';
        op.items.forEach((i) => { i.status = st; i.failureReasons = [e.message]; });
        op.error = e.message;
        this.save(op);
        addAudit(this.store, op.items.map((i) => ({ type: 'product', action: def.label, initiator, status: st, barcode: i.key.startsWith('content:') ? null : i.key, title: title || null, message: e.message })));
        return op;
      }
      op.batchRequestId = res.batchRequestId;
      op.items.forEach((i) => { i.status = 'submitted'; });
      this.save(op);
      return await this.poll(op.id, this.pollTimeoutMs);
    } finally {
      this.running.delete(fingerprint);
    }
  }

  async poll(id, timeoutMs = 0) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const op = this.get(id);
      if (!op || !op.batchRequestId || !op.items.some((i) => i.status === 'submitted')) return op;
      const client = this.getClient();
      if (!client) return op;
      try {
        const res = await client.getBatchRequestResult(op.batchRequestId);
        const list = (res && Array.isArray(res.items)) ? res.items : [];
        const byKey = new Map();
        for (const ri of list) {
          const k = op.kind === 'content' ? 'content:' + ((ri.requestItem && (ri.requestItem.contentId ?? (ri.requestItem.content && ri.requestItem.content.contentId))) ?? op.items[0].request.contentId) : findBarcode(ri.requestItem);
          if (k) byKey.set(String(k), ri);
        }
        const finished = [];
        for (const it of op.items.filter((i) => i.status === 'submitted')) {
          const ri = byKey.get(it.key) || (op.items.length === 1 && list.length === 1 ? list[0] : null);
          if (!ri || !ri.status || ri.status === 'IN_PROGRESS') continue;
          it.status = ri.status === 'SUCCESS' ? 'success' : 'failed';
          it.failureReasons = Array.isArray(ri.failureReasons) ? ri.failureReasons.map(String) : [];
          if (it.status === 'failed' && !it.failureReasons.length) it.failureReasons = ['Trendyol işlemi reddetti (neden belirtilmedi)'];
          finished.push(it);
        }
        op.batchStatus = res && res.status;
        this.save(op);
        if (finished.length) {
          addAudit(this.store, finished.map((i) => ({ type: 'product', action: op.label, initiator: op.initiator, status: i.status === 'success' ? 'success' : 'failed', barcode: i.key.startsWith('content:') ? null : i.key, title: op.title, message: i.failureReasons[0] || (op.kind === 'copy' || op.kind === 'addVariant' ? 'Trendyol kabul etti; ürün onay sürecine girdi' : 'Başarılı'), batchRequestId: op.batchRequestId })));
        }
      } catch (e) {
        op.lastError = e.message;
        this.save(op);
      }
      const cur = this.get(id);
      if (!cur.items.some((i) => i.status === 'submitted')) return cur;
      if (Date.now() >= deadline) return cur;
      await sleep(this.pollIntervalMs);
    }
  }

  async pollAllPending() {
    const ids = this.list().filter((o) => o.items.some((i) => i.status === 'submitted') && Date.now() - Date.parse(o.createdAt) < 6 * 3600 * 1000).map((o) => o.id);
    for (const id of ids) await this.poll(id, 0);
    return ids.length;
  }
}

module.exports = { ProductOps, OpError, planCopy, planAddVariants, planArchive, planContentUpdate, mergeAttributes, BARCODE_RX };
