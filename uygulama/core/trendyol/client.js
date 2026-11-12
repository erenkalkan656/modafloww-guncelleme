'use strict';
const { sleep, sanitize } = require('../util');

/**
 * Trendyol Satıcı Entegrasyon API istemcisi (V2 uç noktaları).
 * Kaynak: https://developers.trendyol.com (Ekim 2026 itibarıyla geçerli dokümantasyon)
 * - Kimlik doğrulama: HTTP Basic (API Key : API Secret)
 * - User-Agent zorunlu: "{SatıcıId} - SelfIntegration" (yoksa 403)
 * - Aynı uç noktaya 10 saniyede en fazla 50 istek (51. istek 429)
 * - V1 ürün/sipariş servisleri 15 Ekim 2026'da kapatıldı; burada yalnızca V2 kullanılır.
 */
const BASE_URLS = {
  prod: 'https://apigw.trendyol.com',
  stage: 'https://stageapigw.trendyol.com',
};

class TrendyolError extends Error {
  /**
   * kind: auth | forbidden | rate_limit | bad_request | not_found | server | network | timeout | invalid_response | config
   * uncertain: true ise isteğin karşı tarafta işlenip işlenmediği BİLİNMİYOR demektir (otomatik tekrar gönderilmez).
   */
  constructor(kind, message, { status = null, details = null, uncertain = false } = {}) {
    super(message);
    this.name = 'TrendyolError';
    this.kind = kind;
    this.status = status;
    this.details = details;
    this.uncertain = uncertain;
  }
  toJSON() {
    return { kind: this.kind, message: this.message, status: this.status, uncertain: this.uncertain, details: sanitize(this.details) };
  }
}

/** Kayan pencereli hız sınırlayıcı: 10 sn içinde en fazla `max10s`, 60 sn içinde en fazla `maxMin` istek. */
class RateLimiter {
  constructor({ max10s = 40, maxMin = 600 } = {}) {
    this.max10s = max10s;
    this.maxMin = maxMin;
    this.stamps = [];
    this.queue = Promise.resolve();
  }
  acquire() {
    const run = async () => {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter((t) => now - t < 60000);
        const last10 = this.stamps.filter((t) => now - t < 10000);
        if (last10.length < this.max10s && this.stamps.length < this.maxMin) {
          this.stamps.push(now);
          return;
        }
        const waitFor = last10.length >= this.max10s ? 10000 - (now - last10[0]) : 60000 - (now - this.stamps[0]);
        await sleep(Math.max(50, waitFor + 20));
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}

// Dokümandaki limitlerin altında, güvenli payla tutulan grup limitleri
const GROUP_LIMITS = {
  productRead: { max10s: 40, maxMin: 800 },
  inventoryWrite: { max10s: 40, maxMin: 300 },
  orderRead: { max10s: 10, maxMin: 25 },
  orderWrite: { max10s: 10, maxMin: 120 },
  sellerRead: { max10s: 1, maxMin: 1 },
  buybox: { max10s: 20, maxMin: 150 },
  productWrite: { max10s: 10, maxMin: 120 },
  categoryRead: { max10s: 10, maxMin: 40 },
  finance: { max10s: 40, maxMin: 1500 },
};

const NETWORK_SAFE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

class TrendyolClient {
  constructor({ sellerId, apiKey, apiSecret, env = 'prod', baseUrl, fetchImpl, timeoutMs = 30000, retryDelays } = {}) {
    if (!sellerId || !apiKey || !apiSecret) {
      throw new TrendyolError('config', 'Trendyol API bilgileri eksik. Ayarlar sayfasından Satıcı ID, API Key ve API Secret girin.');
    }
    if (!/^\d+$/.test(String(sellerId).trim())) throw new TrendyolError('config', 'Satıcı ID yalnızca rakamlardan oluşmalı.');
    this.sellerId = String(sellerId).trim();
    this.env = env;
    this.baseUrl = (baseUrl || BASE_URLS[env] || BASE_URLS.prod).replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.retryDelays = retryDelays || [2000, 5000, 12000];
    this.auth = 'Basic ' + Buffer.from(`${String(apiKey).trim()}:${String(apiSecret).trim()}`).toString('base64');
    this.limiters = {};
    this.stats = { requests: 0, errors: 0, last: null };
  }

  limiter(group) {
    if (!this.limiters[group]) this.limiters[group] = new RateLimiter(GROUP_LIMITS[group] || GROUP_LIMITS.productRead);
    return this.limiters[group];
  }

  headers(extra) {
    return {
      Authorization: this.auth,
      'User-Agent': `${this.sellerId} - SelfIntegration`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(extra || {}),
    };
  }

  buildUrl(path, query) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
    }
    return url.toString();
  }

  async rawRequest(method, path, { query, body, group, headers } = {}) {
    await this.limiter(group).acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const url = this.buildUrl(path, query);
    this.stats.requests++;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: this.headers(headers),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      this.stats.errors++;
      const code = (e && (e.code || (e.cause && e.cause.code))) || '';
      if (e && e.name === 'AbortError') {
        throw new TrendyolError('timeout', 'Trendyol isteği zaman aşımına uğradı.', { uncertain: method !== 'GET' });
      }
      const neverSent = NETWORK_SAFE_CODES.has(code);
      throw new TrendyolError('network', `Ağ bağlantısı kurulamadı (${code || e.message}).`, { uncertain: method !== 'GET' && !neverSent });
    }
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = null; }
    }
    this.stats.last = { at: new Date().toISOString(), status: res.status, path };
    if (res.ok) {
      if (text && data === null) {
        throw new TrendyolError('invalid_response', 'Trendyol geçersiz (JSON olmayan) bir yanıt döndürdü.', { status: res.status, details: text.slice(0, 300), uncertain: method !== 'GET' });
      }
      return data;
    }
    this.stats.errors++;
    const msg = extractMessage(data) || text.slice(0, 200);
    const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    switch (res.status) {
      case 401:
        throw new TrendyolError('auth', 'Kimlik doğrulama başarısız: API Key / API Secret hatalı veya Satıcı ID uyuşmuyor.', { status: 401, details: msg });
      case 403:
        throw new TrendyolError('forbidden', 'Erişim reddedildi (403). Hesabın bu servise yetkisi olmayabilir veya IP/User-Agent reddedildi.', { status: 403, details: msg });
      case 404:
        throw new TrendyolError('not_found', 'Kaynak bulunamadı (404).', { status: 404, details: msg });
      case 429: {
        const err = new TrendyolError('rate_limit', 'Trendyol istek sınırına ulaşıldı (429). Bir süre sonra otomatik tekrar denenir.', { status: 429, details: msg });
        err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10000;
        throw err;
      }
      default:
        if (res.status >= 500) {
          throw new TrendyolError('server', `Trendyol sunucu hatası (${res.status}).`, { status: res.status, details: msg, uncertain: method !== 'GET' });
        }
        throw new TrendyolError('bad_request', `Trendyol isteği reddetti (${res.status}): ${msg || 'ayrıntı yok'}`, { status: res.status, details: data || text.slice(0, 500) });
    }
  }

  /**
   * GET istekleri: ağ, zaman aşımı, 429 ve 5xx hatalarında sınırlı sayıda yeniden dener.
   * Yazma istekleri: yalnızca isteğin İŞLENMEDİĞİ kesin olan durumlarda (429, bağlantı kurulamadı) yeniden dener.
   * Belirsiz sonuçlarda (zaman aşımı, 5xx) ASLA otomatik tekrar göndermez; hata uncertain=true ile döner.
   */
  async request(method, path, opts = {}) {
    let attempt = 0;
    for (;;) {
      try {
        return await this.rawRequest(method, path, opts);
      } catch (e) {
        if (!(e instanceof TrendyolError)) throw e;
        const canRetry = attempt < this.retryDelays.length && (
          e.kind === 'rate_limit' ||
          ((method === 'GET' || opts.readOnly) && ['network', 'timeout', 'server', 'invalid_response'].includes(e.kind)) ||
          (method !== 'GET' && e.kind === 'network' && !e.uncertain)
        );
        if (!canRetry) throw e;
        const delay = e.kind === 'rate_limit' ? Math.max(e.retryAfterMs || 0, this.retryDelays[attempt]) : this.retryDelays[attempt];
        attempt++;
        if (opts.onRetry) opts.onRetry({ attempt, delay, error: e.toJSON() });
        await sleep(delay);
      }
    }
  }

  // ---------- Ürün (V2) ----------
  getApprovedProducts(params = {}) {
    return this.request('GET', `/integration/product/sellers/${this.sellerId}/products/approved`, { query: params, group: 'productRead' });
  }
  getApprovedInventoryAndPrice(params = {}) {
    return this.request('GET', `/integration/product/sellers/${this.sellerId}/products/approved/inventory-and-price`, { query: params, group: 'productRead' });
  }
  getUnapprovedProducts(params = {}) {
    return this.request('GET', `/integration/product/sellers/${this.sellerId}/products/unapproved`, { query: params, group: 'productRead' });
  }

  // ---------- Stok & Fiyat ----------
  /** items: [{barcode, salePrice?, listPrice?, quantity?}] — en fazla 1000 kalem. batchRequestId döner. */
  async updatePriceAndInventory(items) {
    if (!Array.isArray(items) || items.length === 0) throw new TrendyolError('bad_request', 'Gönderilecek kalem yok.');
    if (items.length > 1000) throw new TrendyolError('bad_request', 'Tek istekte en fazla 1000 kalem gönderilebilir.');
    const data = await this.request('POST', `/integration/inventory/sellers/${this.sellerId}/products/price-and-inventory`, { body: { items }, group: 'inventoryWrite' });
    if (!data || !data.batchRequestId) {
      throw new TrendyolError('invalid_response', 'Trendyol batchRequestId döndürmedi; işlemin durumu belirsiz.', { details: data, uncertain: true });
    }
    return data;
  }
  getBatchRequestResult(batchRequestId) {
    return this.request('GET', `/integration/product/sellers/${this.sellerId}/products/batch-requests/${encodeURIComponent(batchRequestId)}`, { group: 'productRead' });
  }

  // ---------- Ürün oluşturma / güncelleme / arşiv (V2) ----------
  /** Yeni ürün/varyant oluşturur (V2). En fazla 1000 kalem. batchRequestId döner. Sonuç onay sürecine düşer. */
  async createProducts(items) {
    if (!Array.isArray(items) || !items.length || items.length > 1000) throw new TrendyolError('bad_request', 'Ürün oluşturma 1–1000 kalem içermeli.');
    const data = await this.request('POST', `/integration/product/sellers/${this.sellerId}/v2/products`, { body: { items }, group: 'productWrite' });
    if (!data || !data.batchRequestId) throw new TrendyolError('invalid_response', 'Trendyol batchRequestId döndürmedi; işlemin durumu belirsiz.', { details: data, uncertain: true });
    return data;
  }
  /** Arşivleme / arşivden çıkarma: items [{barcode, archived}] */
  async setArchiveState(items) {
    if (!Array.isArray(items) || !items.length || items.length > 1000) throw new TrendyolError('bad_request', 'Arşiv işlemi 1–1000 kalem içermeli.');
    const data = await this.request('PUT', `/integration/product/sellers/${this.sellerId}/products/archive-state`, { body: { items }, group: 'productWrite' });
    if (!data || !data.batchRequestId) throw new TrendyolError('invalid_response', 'Trendyol batchRequestId döndürmedi; işlemin durumu belirsiz.', { details: data, uncertain: true });
    return data;
  }
  /** Onaylı ürün içerik güncellemesi (başlık, açıklama, görseller). Kısmi güncelleme desteklenir. */
  async updateContentBulk(items) {
    if (!Array.isArray(items) || !items.length || items.length > 1000) throw new TrendyolError('bad_request', 'İçerik güncelleme 1–1000 kalem içermeli.');
    const data = await this.request('POST', `/integration/product/sellers/${this.sellerId}/products/content-bulk-update`, { body: { items }, group: 'productWrite' });
    if (!data || !data.batchRequestId) throw new TrendyolError('invalid_response', 'Trendyol batchRequestId döndürmedi; işlemin durumu belirsiz.', { details: data, uncertain: true });
    return data;
  }
  /** Trendyol kategori ağacı (salt okunur). */
  getProductCategories() {
    return this.request('GET', '/integration/product/product-categories', { group: 'categoryRead', readOnly: true });
  }
  getCategoryAttributes(categoryId) {
    return this.request('GET', `/integration/product/categories/${encodeURIComponent(categoryId)}/attributes`, { group: 'categoryRead' });
  }
  getCategoryAttributeValues(categoryId, attributeId, params = {}) {
    return this.request('GET', `/integration/product/categories/${encodeURIComponent(categoryId)}/attributes/${encodeURIComponent(attributeId)}/values`, { query: { page: 0, size: 1000, ...params }, group: 'categoryRead' });
  }

  /** Buybox bilgisi (salt okunur): en fazla 10 barkod/istek. */
  async getBuyboxInformation(barcodes) {
    if (!Array.isArray(barcodes) || !barcodes.length || barcodes.length > 10) throw new TrendyolError('bad_request', 'Buybox sorgusu 1–10 barkod içermeli.');
    return this.request('POST', `/integration/product/sellers/${this.sellerId}/products/buybox-information`, { body: { barcodes: barcodes.map(String) }, group: 'buybox', readOnly: true });
  }

  // ---------- Sipariş (V2) ----------
  getOrders(params = {}) {
    return this.request('GET', `/integration/order/sellers/${this.sellerId}/v2/orders`, { query: { supplierId: this.sellerId, ...params }, group: 'orderRead' });
  }

  /**
   * "İşleme Al": paket durumunu Picking yapar (resmi uç nokta, dokümana göre yalnızca Picking ve Invoiced gönderilebilir).
   * Bu istemci yalnızca Picking gönderir. body: { lines: [{ lineId, quantity }], params: {}, status: 'Picking' }
   */
  async updatePackageStatus(packageId, body) {
    if (!/^\d+$/.test(String(packageId || ''))) throw new TrendyolError('bad_request', 'Geçersiz paket numarası.');
    if (!body || body.status !== 'Picking' || !Array.isArray(body.lines) || !body.lines.length) throw new TrendyolError('bad_request', 'Yalnızca "İşleme Al" (Picking) gönderilebilir.');
    return this.request('PUT', `/integration/order/sellers/${this.sellerId}/shipment-packages/${packageId}`, { body: { lines: body.lines, params: {}, status: 'Picking' }, group: 'orderWrite' });
  }

  // ---------- Müşteri soruları ----------
  getQuestions(params = {}) {
    return this.request('GET', `/integration/qna/sellers/${this.sellerId}/questions/filter`, { query: { supplierId: this.sellerId, ...params }, group: 'productRead' });
  }
  /** Soruya cevap: yalnızca WAITING_FOR_ANSWER durumundaki sorular; metin 10–2000 karakter. */
  async answerQuestion(id, text) {
    const t = String(text || '').trim();
    if (t.length < 10 || t.length > 2000) throw new TrendyolError('bad_request', 'Cevap 10–2000 karakter olmalı.');
    return this.request('POST', `/integration/qna/sellers/${this.sellerId}/questions/${encodeURIComponent(id)}/answers`, { body: { text: t }, group: 'productWrite' });
  }

  // ---------- İadeler ----------
  getClaims(params = {}) {
    return this.request('GET', `/integration/order/sellers/${this.sellerId}/claims`, { query: params, group: 'productRead' });
  }

  // ---------- Cari hesap ekstresi (yalnızca okuma) ----------
  // startDate/endDate milisaniye, aralık en fazla 15 gün; transactionType tek değer; size 500 veya 1000.
  async getFinance(kind, params = {}) {
    if (kind !== 'settlements' && kind !== 'otherfinancials') throw new TrendyolError('bad_request', 'Geçersiz cari hesap servisi');
    if (params.endDate - params.startDate > 15 * 86400000) throw new TrendyolError('bad_request', 'Cari hesap sorgusu en fazla 15 gün olabilir.');
    const path = `/integration/finance/che/sellers/${this.sellerId}/${kind}`;
    const opts = { query: { size: 1000, page: 0, ...params }, group: 'finance', headers: this.storeFrontCode ? { storeFrontCode: this.storeFrontCode } : undefined };
    try {
      return await this.request('GET', path, opts);
    } catch (e) {
      // Bazı hesaplarda storeFrontCode başlığı zorunlu: bir kez TR ile dene ve hatırla
      if (!this.storeFrontCode && e instanceof TrendyolError && e.kind === 'bad_request' && /store\s*front/i.test(e.message + JSON.stringify(e.details || ''))) {
        this.storeFrontCode = 'TR';
        return this.request('GET', path, { ...opts, headers: { storeFrontCode: 'TR' } });
      }
      throw e;
    }
  }

  // ---------- Satıcı ----------
  getAddresses() {
    return this.request('GET', `/integration/sellers/${this.sellerId}/addresses`, { group: 'sellerRead' });
  }

  /** Bağlantı testi: tek kayıtlık onaylı ürün sorgusu (salt okunur). */
  async testConnection() {
    const res = await this.getApprovedProducts({ page: 0, size: 1 });
    return { ok: true, totalProducts: res && Number.isFinite(res.totalElements) ? res.totalElements : null };
  }
}

function extractMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data.errors) && data.errors.length) return data.errors.map((e) => e.message || e.key || JSON.stringify(e)).join('; ');
  return data.message || data.error || data.exception || '';
}

module.exports = { TrendyolClient, TrendyolError, RateLimiter, BASE_URLS };
