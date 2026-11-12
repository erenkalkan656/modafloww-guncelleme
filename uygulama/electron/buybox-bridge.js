'use strict';
/**
 * Buybox Keşif eklentisi ile panel arasındaki yerel köprü.
 * - Yalnızca 127.0.0.1'e bağlanır (ağdan erişilemez).
 * - Her istek X-Modafloww-Token başlığında bağlantı kodunu taşımalıdır (sabit zamanlı karşılaştırma).
 * - Host başlığı 127.0.0.1/localhost değilse reddedilir (DNS rebinding'e karşı).
 * - Yalnızca iki uç: GET /v1/ping, POST /v1/import (JSON, en fazla 4 MB).
 */
const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 47823;
const MAX_BODY = 4 * 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

class BuyboxBridge {
  constructor({ getToken, onImport, port = DEFAULT_PORT, log = () => {} }) {
    this.getToken = getToken;
    this.onImport = onImport;
    this.port = port;
    this.log = log;
    this.server = null;
    this.state = { running: false, port, error: null, lastAt: null, lastFrom: null };
  }

  start() {
    if (this.server) return Promise.resolve(this.state);
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.on('error', (e) => {
        this.state = { ...this.state, running: false, error: e.code === 'EADDRINUSE' ? `Port ${this.port} başka bir programda kullanılıyor` : e.message };
        this.server = null;
        resolve(this.state);
      });
      srv.listen(this.port, '127.0.0.1', () => {
        srv.unref(); // uygulamayı tek başına açık tutmaz
        this.server = srv;
        this.state = { ...this.state, running: true, error: null, port: srv.address().port };
        resolve(this.state);
      });
    });
  }

  stop() {
    if (this.server) { this.server.close(); this.server = null; }
    this.state = { ...this.state, running: false };
  }

  send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(obj));
  }

  handle(req, res) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return this.send(res, 403, { error: 'Geçersiz adres' });
    const origin = String(req.headers.origin || '');
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && !/^moz-extension:\/\//.test(origin)) return this.send(res, 403, { error: 'Bu kaynaktan istek kabul edilmez' });
    if (!safeEqual(req.headers['x-modafloww-token'], this.getToken())) return this.send(res, 401, { error: 'Bağlantı kodu hatalı. Paneldeki Buybox Fırsatları > Eklenti bağlantısı bölümündeki kodu girin.' });
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/v1/ping') return this.send(res, 200, { ok: true, app: 'modafloww-panel' });
    if (req.method === 'POST' && url === '/v1/import') {
      if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) return this.send(res, 415, { error: 'JSON bekleniyor' });
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(c); });
      req.on('end', async () => {
        if (size > MAX_BODY) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return this.send(res, 400, { error: 'Geçersiz JSON' }); }
        try {
          const r = await this.onImport(body);
          this.state = { ...this.state, lastAt: Date.now() };
          this.send(res, 200, r);
        } catch (e) { this.send(res, 400, { error: e.message }); }
      });
      return;
    }
    this.send(res, 404, { error: 'Bilinmeyen uç' });
  }
}

const newToken = () => crypto.randomBytes(18).toString('base64url');

module.exports = { BuyboxBridge, DEFAULT_PORT, newToken };
