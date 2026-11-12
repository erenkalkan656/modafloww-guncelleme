'use strict';
const { uid, sha1, chunk, sleep, nowIso, round2 } = require('./util');
const { addAudit } = require('./audit');
const { fetchCurrentByBarcodes, patchCatalog } = require('./catalog');

/**
 * Toplu fiyat/stok işlemleri.
 *
 * Güvenlik ilkeleri:
 * 1. İş, gönderimden ÖNCE diske yazılır (uygulama kapanırsa durum kaybolmaz).
 * 2. Her kalemin durumu ayrı izlenir: pending → sending → submitted → success/failed
 *    Ağ/sunucu belirsizliğinde kalem "uncertain" olur ve OTOMATİK TEKRAR GÖNDERİLMEZ.
 * 3. Aynı barkod aynı anda iki aktif işte bulunamaz (kilit).
 * 4. Aynı içerik 15 dakika içinde ikinci kez gönderilemez (Trendyol kuralı + çift tıklama koruması).
 * 5. Yalnızca "draft" durumundaki iş çalıştırılabilir; çalıştırma anında durum eşzamanlı olarak değişir.
 * 6. Başarı, Trendyol toplu işlem sonucu (items[].status = SUCCESS) ile belirlenir; ardından güncel
 *    değer tekrar okunarak doğrulanır.
 */
const BATCH_LIMIT = 1000;
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const ACTIVE_ITEM = new Set(['pending', 'sending', 'submitted', 'uncertain']);

class JobError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const ACTION = { price: 'Fiyat güncelleme', stock: 'Stok güncelleme', both: 'Fiyat ve stok güncelleme' };
function itemPayload(type, item) {
  if (type === 'price') return { barcode: item.barcode, salePrice: item.new.salePrice, listPrice: item.new.listPrice };
  if (type === 'both') return { barcode: item.barcode, quantity: item.new.quantity, salePrice: item.new.salePrice, listPrice: item.new.listPrice };
  return { barcode: item.barcode, quantity: item.new.quantity };
}

function valuesEqual(type, cur, target) {
  if (!cur) return false;
  const price = round2(cur.salePrice) === round2(target.salePrice) && round2(cur.listPrice) === round2(target.listPrice);
  const qty = Number(cur.quantity) === Number(target.quantity);
  return type === 'price' ? price : type === 'both' ? price && qty : qty;
}

function deriveStatus(job) {
  const c = countItems(job);
  if (job.status === 'draft' || job.status === 'cancelled') return job.status;
  if (c.sending) return 'running';
  if (c.uncertain) return 'needs_verification';
  if (c.submitted) return 'submitted';
  if (c.pending) return c.success || c.failed ? 'partial' : 'pending';
  if (c.success && !c.failed) return 'completed';
  if (c.success && c.failed) return 'partial';
  return 'failed';
}

function countItems(job) {
  const c = { total: job.items.length, pending: 0, sending: 0, submitted: 0, success: 0, failed: 0, uncertain: 0, verified: 0 };
  for (const it of job.items) {
    c[it.status] = (c[it.status] || 0) + 1;
    if (it.verified) c.verified++;
  }
  return c;
}

function fmtValue(type, v) {
  if (!v) return null;
  return type === 'price' ? { salePrice: v.salePrice, listPrice: v.listPrice } : type === 'both' ? { salePrice: v.salePrice, listPrice: v.listPrice, quantity: v.quantity } : { quantity: v.quantity };
}

class JobManager {
  constructor({ store, getClient, emit = () => {}, pollIntervalMs = 3000, pollTimeoutMs = 180000, verifyDelayMs = 2000, blocked = () => new Set() }) {
    /** Kara listedeki barkodlar (Set döndüren fonksiyon): bunlar hiçbir işte Trendyol'a gönderilmez. */
    this.blocked = blocked;
    this.store = store;
    this.getClient = getClient;
    this.emit = emit;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.verifyDelayMs = verifyDelayMs;
    this.running = new Set();
  }

  jobs() { return this.store.get('jobs', []); }
  get(id) { return this.jobs().find((j) => j.id === id) || null; }

  save(job, immediate = true) {
    job.status = deriveStatus(job);
    job.counts = countItems(job);
    job.updatedAt = nowIso();
    const list = this.jobs();
    const i = list.findIndex((j) => j.id === job.id);
    if (i === -1) list.push(job); else list[i] = job;
    // Eski işleri sınırla (son 300 iş)
    const trimmed = list.length > 300 ? list.slice(list.length - 300) : list;
    this.store.set('jobs', trimmed, { immediate });
    this.emit('job', summary(job));
    return job;
  }

  lockedBarcodes(exceptJobId) {
    const locked = new Map();
    for (const j of this.jobs()) {
      if (j.id === exceptJobId || j.status === 'draft' || j.status === 'cancelled') continue;
      for (const it of j.items) if (ACTIVE_ITEM.has(it.status)) locked.set(it.barcode, j.id);
    }
    return locked;
  }

  /**
   * Önizleme planından taslak iş oluşturur. Yalnızca status==='ok' satırlar alınır.
   * plan.rows: buildPricePlan/buildStockPlan çıktısı
   */
  createFromPlan({ type, plan, description, initiator = 'user', meta = {} }) {
    if (!ACTION[type]) throw new JobError('invalid', 'Geçersiz iş türü');
    const bl = this.blocked();
    const okRows = (plan.rows || []).filter((r) => r.status === 'ok');
    const rows = okRows.filter((r) => !bl.has(String(r.barcode)));
    if (!rows.length) throw new JobError('empty', okRows.length ? 'Seçilen ürünlerin hepsi kara listede; hiçbir değişiklik gönderilmez.' : 'Gönderilecek değişiklik yok.');
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.barcode)) throw new JobError('duplicate_barcode', `Barkod iki kez seçilmiş: ${r.barcode}`);
      seen.add(r.barcode);
    }
    const catalog = this.store.get('catalog', { variants: [] });
    const known = new Map(catalog.variants.map((v) => [v.barcode, v]));
    const items = rows.map((r) => {
      const v = known.get(r.barcode);
      if (!v) throw new JobError('unknown_barcode', `Barkod katalogda bulunamadı: ${r.barcode}. Önce senkronize edin.`);
      if (v.conflict) throw new JobError('conflict', `Barkod çakışmalı: ${r.barcode}`);
      const base = { barcode: r.barcode, title: r.title || v.title, size: v.size, status: 'pending', batchRequestId: null, failureReasons: [], verified: null, rule: r.ruleLabel || null };
      if (type === 'price' || type === 'both') {
        if (!(r.newSale > 0) || !(r.newList >= r.newSale)) throw new JobError('invalid_price', `Geçersiz fiyat: ${r.barcode}`);
        if (type === 'price') return { ...base, old: { salePrice: v.salePrice, listPrice: v.listPrice }, new: { salePrice: round2(r.newSale), listPrice: round2(r.newList) } };
        if (!Number.isInteger(r.newQty) || r.newQty < 0 || r.newQty > 20000) throw new JobError('invalid_stock', `Geçersiz stok: ${r.barcode}`);
        return { ...base, old: { salePrice: v.salePrice, listPrice: v.listPrice, quantity: v.quantity }, new: { salePrice: round2(r.newSale), listPrice: round2(r.newList), quantity: r.newQty } };
      }
      if (!Number.isInteger(r.newQty) || r.newQty < 0 || r.newQty > 20000) throw new JobError('invalid_stock', `Geçersiz stok: ${r.barcode}`);
      return { ...base, old: { quantity: v.quantity }, new: { quantity: r.newQty } };
    });
    const fingerprint = sha1(type + '|' + items.map((i) => i.barcode + ':' + JSON.stringify(i.new)).sort().join('|'));
    const client = this.getClient();
    const job = {
      id: uid(type === 'price' ? 'fiyat-' : type === 'both' ? 'fiyatstok-' : 'stok-'),
      type,
      description: description || '',
      initiator,
      meta,
      env: client ? client.env : null,
      createdAt: nowIso(),
      status: 'draft',
      fingerprint,
      items,
      batches: [],
      log: [],
    };
    return this.save(job);
  }

  cancelDraft(id) {
    const job = this.get(id);
    if (!job) throw new JobError('not_found', 'İş bulunamadı');
    if (job.status !== 'draft') throw new JobError('state', 'Yalnızca gönderilmemiş taslak iptal edilebilir.');
    job.status = 'cancelled';
    job.items.forEach((i) => { i.status = 'failed'; i.failureReasons = ['Kullanıcı iptal etti (gönderilmedi)']; });
    job.status = 'cancelled';
    const list = this.jobs().map((j) => (j.id === id ? { ...job, counts: countItems(job), updatedAt: nowIso() } : j));
    this.store.set('jobs', list, { immediate: true });
    this.emit('job', summary(job));
    return job;
  }

  /** Taslağı Trendyol'a gönderir. Aynı iş ikinci kez çalıştırılamaz. */
  async execute(id) {
    const job = this.get(id);
    if (!job) throw new JobError('not_found', 'İş bulunamadı');
    if (job.status !== 'draft' && job.status !== 'pending' && job.status !== 'partial') {
      throw new JobError('state', 'Bu iş zaten gönderildi veya gönderiliyor. Aynı işlem tekrar gönderilemez.');
    }
    if (this.running.has(id)) throw new JobError('state', 'Bu iş şu anda çalışıyor.');
    const client = this.getClient();
    if (!client) throw new JobError('config', 'Trendyol API bilgileri yapılandırılmamış.');
    if (job.env && client.env !== job.env) throw new JobError('env', 'İş farklı bir ortam (canlı/test) için hazırlanmış. Yeniden önizleme yapın.');

    // 15 dakika kuralı ve kilitler
    if (job.status === 'draft') {
      const now = Date.now();
      const dup = this.jobs().find((j) => j.id !== id && j.fingerprint === job.fingerprint && j.status !== 'draft' && j.status !== 'cancelled' && j.status !== 'failed' && now - Date.parse(j.createdAt) < DUPLICATE_WINDOW_MS);
      if (dup) throw new JobError('duplicate', `Aynı değişiklikler 15 dakika içinde zaten gönderildi (iş: ${dup.id}). Trendyol aynı isteği 15 dakika içinde kabul etmez.`);
    }
    const locked = this.lockedBarcodes(id);
    const conflicts = job.items.filter((i) => i.status === 'pending' && locked.has(i.barcode));
    if (conflicts.length) {
      throw new JobError('locked', `${conflicts.length} varyant başka bir aktif işte bekliyor (ör. ${conflicts[0].barcode}). O iş bitmeden aynı varyant tekrar gönderilemez.`, { barcodes: conflicts.map((c) => c.barcode) });
    }

    this.running.add(id);
    job.startedAt = job.startedAt || nowIso();
    job.status = 'running';
    this.save(job);
    try {
      // Son güvenlik: gönderim anında kara listedeki barkodlar çıkarılır (iş, ürün kara listeye alınmadan önce hazırlanmış olabilir)
      const bl = this.blocked();
      const blockedNow = job.items.filter((i) => i.status === 'pending' && bl.has(String(i.barcode)));
      for (const i of blockedNow) { i.status = 'failed'; i.failureReasons = ['Kara listede: gönderilmedi']; }
      if (blockedNow.length) this.save(job);
      const pending = job.items.filter((i) => i.status === 'pending');
      for (const group of chunk(pending, BATCH_LIMIT)) {
        group.forEach((i) => { i.status = 'sending'; });
        this.save(job); // gönderimden önce diske yaz
        try {
          const res = await client.updatePriceAndInventory(group.map((i) => itemPayload(job.type, i)));
          const batch = { batchRequestId: res.batchRequestId, barcodes: group.map((i) => i.barcode), sentAt: nowIso(), resolved: false };
          job.batches.push(batch);
          group.forEach((i) => { i.status = 'submitted'; i.batchRequestId = res.batchRequestId; });
          job.log.push({ at: nowIso(), msg: `${group.length} kalem gönderildi (batch ${res.batchRequestId})` });
          this.save(job);
        } catch (e) {
          const uncertain = !!e.uncertain;
          group.forEach((i) => {
            i.status = uncertain ? 'uncertain' : 'failed';
            i.failureReasons = [e.message || String(e)];
          });
          job.log.push({ at: nowIso(), msg: (uncertain ? 'BELİRSİZ: ' : 'HATA: ') + (e.message || e) });
          this.save(job);
          addAudit(this.store, group.map((i) => ({
            type: job.type, action: ACTION[job.type], initiator: job.initiator,
            status: uncertain ? 'uncertain' : 'failed', barcode: i.barcode, title: i.title, size: i.size,
            oldValue: fmtValue(job.type, i.old), newValue: fmtValue(job.type, i.new), jobId: job.id, message: i.failureReasons[0],
          })));
          // Belirsizlikte veya kimlik hatasında kalan grupları göndermeyi durdur
          if (uncertain || ['auth', 'forbidden', 'config', 'network', 'timeout'].includes(e.kind)) break;
        }
      }
      await this.pollJob(job.id, { timeoutMs: this.pollTimeoutMs });
    } finally {
      this.running.delete(id);
    }
    return summary(this.get(id));
  }

  /** Bir işin gönderilmiş batch'lerinin sonucunu kontrol eder. */
  async pollJob(id, { timeoutMs = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = this.get(id);
      if (!job) return null;
      const open = job.batches.filter((b) => !b.resolved);
      if (!open.length) break;
      const client = this.getClient();
      if (!client) break;
      for (const b of open) {
        let res;
        try {
          res = await client.getBatchRequestResult(b.batchRequestId);
        } catch (e) {
          b.lastError = e.message;
          // 4 saatten eski ve hâlâ okunamayan batch: durum belirsiz -> doğrulama gerekir
          if (Date.now() - Date.parse(b.sentAt) > 4 * 3600 * 1000) {
            b.resolved = true;
            job.items.filter((i) => i.batchRequestId === b.batchRequestId && i.status === 'submitted').forEach((i) => {
              i.status = 'uncertain';
              i.failureReasons = ['Toplu işlem sonucu okunamadı; güncel değerle doğrulama gerekli'];
            });
          }
          continue;
        }
        const resultItems = (res && Array.isArray(res.items)) ? res.items : [];
        const byBarcode = new Map();
        for (const ri of resultItems) {
          const bc = ri && ri.requestItem && ri.requestItem.barcode;
          if (bc) byBarcode.set(String(bc), ri);
        }
        const finished = [];
        for (const it of job.items.filter((i) => i.batchRequestId === b.batchRequestId && i.status === 'submitted')) {
          const ri = byBarcode.get(it.barcode);
          if (!ri || !ri.status || ri.status === 'IN_PROGRESS') continue;
          if (ri.status === 'SUCCESS') {
            it.status = 'success';
            it.failureReasons = [];
          } else {
            it.status = 'failed';
            it.failureReasons = Array.isArray(ri.failureReasons) && ri.failureReasons.length ? ri.failureReasons.map(String) : ['Trendyol işlemi reddetti (neden belirtilmedi)'];
          }
          it.resolvedAt = nowIso();
          finished.push(it);
        }
        if (!job.items.some((i) => i.batchRequestId === b.batchRequestId && i.status === 'submitted')) b.resolved = true;
        if (finished.length) {
          addAudit(this.store, finished.map((i) => ({
            type: job.type, action: ACTION[job.type], initiator: job.initiator,
            status: i.status === 'success' ? 'success' : 'failed', barcode: i.barcode, title: i.title, size: i.size,
            oldValue: fmtValue(job.type, i.old), newValue: fmtValue(job.type, i.new), jobId: job.id, batchRequestId: b.batchRequestId,
            message: i.failureReasons[0] || null,
          })));
        }
      }
      this.save(job);
      if (!job.batches.some((b) => !b.resolved)) {
        await this.postVerify(job.id);
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(this.pollIntervalMs);
    }
    return summary(this.get(id));
  }

  /** Başarılı kalemlerin Trendyol'daki güncel değerini okuyup doğrular ve yerel kataloğu günceller. */
  // Trendyol değişikliği birkaç dakika geç yansıtabilir: yansımayanlar artan aralıklarla tekrar okunur
  async postVerify(id, { once = false } = {}) {
    if (!once && this.verifyDelayMs) await sleep(this.verifyDelayMs);
    const left = await this.verifyOnce(id);
    if (once || !left) return;
    // Sonraki denemeler arka planda (işin bitişini bekletmez)
    (async () => {
      for (const d of this.recheckDelays || [15000, 45000, 120000, 300000]) {
        await sleep(d);
        try { if (!(await this.verifyOnce(id))) return; } catch (_) { /* sonraki denemede */ }
      }
    })();
  }

  /** @returns {number} hâlâ yansımamış kalem sayısı */
  async verifyOnce(id) {
    const job = this.get(id);
    const client = this.getClient();
    if (!job || !client) return 0;
    const targets = job.items.filter((i) => i.status === 'success' && i.verified !== true);
    if (!targets.length) return 0;
    let current;
    try {
      current = await fetchCurrentByBarcodes(client, targets.map((i) => i.barcode));
    } catch (e) {
      job.log.push({ at: nowIso(), msg: 'Doğrulama okuması başarısız: ' + e.message });
      this.save(job);
      return targets.length;
    }
    const patches = [];
    for (const it of targets) {
      const cur = current.get(it.barcode);
      it.verified = valuesEqual(job.type, cur, it.new);
      it.currentValue = cur ? fmtValue(job.type, cur) : null;
      if (cur) patches.push([it.barcode, fmtValue(job.type, cur)]);
    }
    patchCatalog(this.store, patches);
    job.verifiedAt = nowIso();
    this.save(job);
    return targets.filter((i) => i.verified !== true).length;
  }

  /**
   * Belirsiz (uncertain) kalemleri Trendyol'daki güncel değerlerle karşılaştırarak çözer:
   * - güncel = yeni  -> success (uygulanmış)
   * - güncel = eski  -> pending (uygulanmamış; güvenle tekrar gönderilebilir)
   * - diğer          -> failed (beklenmeyen değer, elle kontrol)
   */
  async verifyUncertain(id) {
    const job = this.get(id);
    if (!job) throw new JobError('not_found', 'İş bulunamadı');
    const client = this.getClient();
    if (!client) throw new JobError('config', 'API yapılandırılmamış');
    const targets = job.items.filter((i) => i.status === 'uncertain');
    if (!targets.length) return summary(job);
    const current = await fetchCurrentByBarcodes(client, targets.map((i) => i.barcode));
    const audits = [];
    for (const it of targets) {
      const cur = current.get(it.barcode);
      if (cur && valuesEqual(job.type, cur, it.new)) {
        it.status = 'success'; it.verified = true; it.failureReasons = [];
      } else if (cur && valuesEqual(job.type, cur, it.old)) {
        it.status = 'pending'; it.failureReasons = ['Doğrulandı: değişiklik uygulanmamış, tekrar gönderilebilir']; it.batchRequestId = null;
      } else {
        it.status = 'failed';
        it.failureReasons = [cur ? 'Güncel değer ne eski ne yeni değerle eşleşiyor; elle kontrol edin' : 'Barkod Trendyol\'da bulunamadı'];
      }
      it.currentValue = cur ? fmtValue(job.type, cur) : null;
      audits.push({ type: job.type, action: 'Belirsiz işlem doğrulama', initiator: 'user', status: it.status === 'success' ? 'success' : it.status === 'pending' ? 'info' : 'failed', barcode: it.barcode, title: it.title, oldValue: fmtValue(job.type, it.old), newValue: fmtValue(job.type, it.new), jobId: job.id, message: it.failureReasons[0] || 'Uygulandığı doğrulandı' });
    }
    addAudit(this.store, audits);
    this.save(job);
    return summary(job);
  }

  /** Başarısız kalemlerden yeni bir taslak iş oluşturur (önizleme/onay yine gerekir). */
  createRetryJob(id) {
    const job = this.get(id);
    if (!job) throw new JobError('not_found', 'İş bulunamadı');
    const rows = job.items.filter((i) => i.status === 'failed' || i.status === 'pending').map((i) => ({ barcode: i.barcode, title: i.title, status: 'ok', newSale: i.new.salePrice, newList: i.new.listPrice, newQty: i.new.quantity, ruleLabel: (i.rule || '') + ' (tekrar)' }));
    if (!rows.length) throw new JobError('empty', 'Tekrar denenecek kalem yok.');
    if (job.status === 'partial' || job.status === 'failed') {
      // Kaynak işteki pending kalemleri kapat ki kilit oluşturmasın
      job.items.filter((i) => i.status === 'pending').forEach((i) => { i.status = 'failed'; i.failureReasons = ['Yeni tekrar işine aktarıldı']; });
      this.save(job);
    }
    return this.createFromPlan({ type: job.type, plan: { rows }, description: `Tekrar: ${job.description || job.id}`, meta: { retryOf: job.id } });
  }

  /**
   * Geri alma: başarılı kalemler için ESKİ değerleri yeni bir taslak iş olarak hazırlar.
   * Trendyol'da gerçek bir "geri al" servisi yoktur; eski değer yeniden gönderilir.
   */
  createRevertJob(id, barcodes = null) {
    const job = this.get(id);
    if (!job) throw new JobError('not_found', 'İş bulunamadı');
    let ok = job.items.filter((i) => i.status === 'success');
    if (!ok.length) throw new JobError('empty', 'Geri alınacak başarılı kalem yok.');
    // Seçmeli geri alma: yalnızca seçilen barkodlar (hepsi bu işte başarılı olmalı)
    if (Array.isArray(barcodes)) {
      const want = new Set(barcodes.map(String));
      const bad = [...want].filter((b) => !ok.some((i) => i.barcode === b));
      if (bad.length) throw new JobError('invalid', `Seçilen barkod bu işte başarılı bir kalem değil: ${bad[0]}`);
      ok = ok.filter((i) => want.has(i.barcode));
      if (!ok.length) throw new JobError('empty', 'Geri alınacak kalem seçilmedi.');
    }
    const rows = ok.map((i) => ({ barcode: i.barcode, title: i.title, status: 'ok', newSale: i.old.salePrice, newList: i.old.salePrice != null ? Math.max(i.old.listPrice || i.old.salePrice, i.old.salePrice) : undefined, newQty: i.old.quantity, ruleLabel: 'Eski değere dönüş' }));
    return this.createFromPlan({ type: job.type, plan: { rows }, description: `Geri alma: ${job.description || job.id}`, meta: { revertOf: job.id } });
  }

  /** Uygulama açılışında: "sending" durumunda kalmış kalemler belirsizdir (uygulama gönderim sırasında kapanmış). */
  recoverOnStartup() {
    let changed = 0;
    for (const job of this.jobs()) {
      let touched = false;
      for (const it of job.items) {
        if (it.status === 'sending') {
          it.status = 'uncertain';
          it.failureReasons = ['Uygulama gönderim sırasında kapandı; sonuç doğrulanmalı'];
          touched = true;
        }
      }
      if (job.status === 'running' || touched) { this.save(job); changed++; }
    }
    return changed;
  }

  /** Otomasyon: gönderilmiş ama sonucu henüz okunmamış batch'leri kontrol eder. */
  async pollAllPending() {
    const ids = this.jobs().filter((j) => j.batches && j.batches.some((b) => !b.resolved) && !this.running.has(j.id)).map((j) => j.id);
    const out = [];
    for (const id of ids) out.push(await this.pollJob(id, { timeoutMs: 0 }));
    return { checked: ids.length, jobs: out };
  }

  list({ limit = 100 } = {}) {
    return this.jobs().slice(-limit).reverse().map(summary);
  }
}

function summary(job) {
  if (!job) return null;
  const { items, ...rest } = job;
  return { ...rest, counts: countItems(job) };
}

module.exports = { JobManager, JobError, deriveStatus, countItems, BATCH_LIMIT, DUPLICATE_WINDOW_MS };
