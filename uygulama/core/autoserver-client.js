'use strict';
// Ortak otomasyon sunucusu istemcisi — bilgisayar (Electron ana süreç) ve telefon (Capacitor) aynı dosyayı kullanır.
// Cihaz anahtarı (token) yalnızca cihazın şifreli deposunda tutulur; buraya parametre olarak gelir.

const DEFAULT_SERVER = 'https://modafloww-sunucu.modafloww.workers.dev';

class ServerError extends Error {
  /** kind: offline | auth | forbidden | conflict | bad_request | not_found | server | no_credentials */
  constructor(kind, message, { status = null, data = null } = {}) { super(message); this.kind = kind; this.status = status; this.data = data; }
}

function kindOf(status, data) {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return data && data.code === 'no_credentials' ? 'no_credentials' : 'conflict';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
}

class AutoServerClient {
  constructor({ baseUrl = DEFAULT_SERVER, token = null, fetchImpl, timeoutMs = 45000 } = {}) {
    const u = String(baseUrl || DEFAULT_SERVER).trim().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u)) throw new ServerError('bad_request', 'Sunucu adresi https:// ile başlamalı');
    this.baseUrl = u;
    this.token = token;
    this.fetch = fetchImpl || ((a, b) => globalThis.fetch(a, b));
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    let res;
    let timer;
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (ctrl) timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      res = await this.fetch(this.baseUrl + path, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      throw new ServerError('offline', 'Sunucuya ulaşılamadı. İnternet bağlantısını kontrol edin; bu sırada hiçbir ürün değiştirilmez.');
    } finally { if (timer) clearTimeout(timer); }
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (res.ok) return data;
    throw new ServerError(kindOf(res.status, data), (data && data.error) || `Sunucu hatası (${res.status})`, { status: res.status, data });
  }

  health() { return this.request('GET', '/api/health'); }
  pair({ setupCode, pairCode, name, platform }) { return this.request('POST', '/api/pair', { setupCode, pairCode, name, platform }); }
  createPairCode() { return this.request('POST', '/api/pair-codes'); }
  devices() { return this.request('GET', '/api/devices'); }
  revokeDevice(id) { return this.request('DELETE', '/api/devices/' + encodeURIComponent(id)); }
  credentials() { return this.request('GET', '/api/credentials'); }
  putCredentials(c) { return this.request('PUT', '/api/credentials', c); }
  status() { return this.request('GET', '/api/status'); }
  runNow() { return this.request('POST', '/api/run'); }
  rules() { return this.request('GET', '/api/rules'); }
  rule(id) { return this.request('GET', '/api/rules/' + encodeURIComponent(id)); }
  createRule(rule) { return this.request('POST', '/api/rules', { rule }); }
  updateRule(id, version, rule) { return this.request('PUT', '/api/rules/' + encodeURIComponent(id), { version, rule }); }
  deleteRule(id, version) { return this.request('DELETE', `/api/rules/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`); }
  simulate(id, version) { return this.request('POST', `/api/rules/${encodeURIComponent(id)}/simulate`, { version }); }
  activate(id, version, simId) { return this.request('POST', `/api/rules/${encodeURIComponent(id)}/activate`, { version, simId, confirm: true }); }
  pause(id, version) { return this.request('POST', `/api/rules/${encodeURIComponent(id)}/pause`, { version }); }
  reopenPreview(id) { return this.request('GET', `/api/rules/${encodeURIComponent(id)}/reopen`); }
  reopen(id, version) { return this.request('POST', `/api/rules/${encodeURIComponent(id)}/reopen`, { version, confirm: true }); }
  verify(id, version) { return this.request('POST', `/api/rules/${encodeURIComponent(id)}/verify`, { version }); }
  reset(id, version) { return this.request('POST', `/api/rules/${encodeURIComponent(id)}/reset`, { version }); }
  history({ ruleId, limit = 100, before } = {}) {
    const q = new URLSearchParams();
    if (ruleId) q.set('ruleId', ruleId);
    if (limit) q.set('limit', String(limit));
    if (before) q.set('before', String(before));
    return this.request('GET', '/api/history?' + q.toString());
  }
  palettes() { return this.request('GET', '/api/prefs/palettes'); }
  savePalettes(items) { return this.request('PUT', '/api/prefs/palettes', { items }); }
  financePanel() { return this.request('GET', '/api/finance-panel'); }
  qnaConfig() { return this.request('GET', '/api/qna/config'); }
  saveQnaConfig(config, expectVersion) { return this.request('PUT', '/api/qna/config', { config, expectVersion }); }
  qnaSimulate(config) { return this.request('POST', '/api/qna/simulate', { config: config || null }); }
  qnaLog(limit = 100) { return this.request('GET', '/api/qna/log?limit=' + limit); }
  qnaStatus() { return this.request('GET', '/api/qna/status'); }
  qnaReportQueue() { return this.request('GET', '/api/qna/report-queue'); }
  qnaReportResult(id, ok, message) { return this.request('POST', '/api/qna/report-result', { id, ok, message }); }
  putFinancePanel(data) { return this.request('PUT', '/api/finance-panel', data); }
  blacklist() { return this.request('GET', '/api/blacklist'); }
  putBlacklist(barcodes) { return this.request('PUT', '/api/blacklist', { barcodes }); }
}

/** Arayüzde gösterilecek kısa açıklama */
const HISTORY_KINDS = { rule: 'Kural', simulate: 'Simülasyon', activate: 'Etkinleştirme', pause: 'Durdurma', trigger: 'Hedefe ulaşıldı', close: 'Kapatma', reopen: 'Yeniden açma', verify: 'Doğrulama', cycle: 'Sunucu', device: 'Cihaz', credentials: 'Trendyol bilgisi', qna: 'Soru otomasyonu' };
const HISTORY_STATUS = { success: 'Başarılı', failed: 'Başarısız', partial: 'Kısmen', pending: 'Bekliyor', uncertain: 'Belirsiz', info: 'Bilgi' };

module.exports = { AutoServerClient, ServerError, DEFAULT_SERVER, HISTORY_KINDS, HISTORY_STATUS };
