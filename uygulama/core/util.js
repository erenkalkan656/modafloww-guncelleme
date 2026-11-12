'use strict';
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uid(prefix = '') {
  return prefix + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

const { round2 } = require('./num');

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const SECRET_KEYS = /(api[-_]?key|api[-_]?secret|secret|password|parola|authorization|cookie|token)/i;

/**
 * Log ve geçmiş kayıtlarına yazılacak nesnelerden gizli alanları temizler.
 * Ayrıca metin içinde geçen Basic auth başlıklarını maskeler.
 */
function sanitize(value, depth = 0) {
  if (depth > 6) return '[...]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/Basic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic ***')
      .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer ***');
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '***' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { sleep, uid, sha1, round2, chunk, sanitize, nowIso };
