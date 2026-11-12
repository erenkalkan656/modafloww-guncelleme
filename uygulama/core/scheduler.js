'use strict';
const { nowIso } = require('./util');
const { addAudit } = require('./audit');

/** Çalışma aralığı (ms). unit: 'sec' olan otomasyonlar saniye, diğerleri dakika cinsinden. */
function periodMs(def, st) {
  if (def && def.unit === 'sec') return (Number(st.intervalSec) || def.defaultIntervalSec || 60) * 1000;
  return (Number(st.intervalMin) || def.defaultIntervalMin || 1) * 60000;
}

/**
 * Otomasyon zamanlayıcısı.
 * - Her otomasyonun kendi kilidi vardır: aynı otomasyon aynı anda iki kez çalışamaz.
 * - Durdurulmuş (enabled=false) otomasyon için yeni çalışma başlatılmaz.
 * - Hata durumunda sınırlı yeniden deneme: art arda 3 hatadan sonra otomasyon otomatik duraklatılır.
 * - Uygulama kapalıyken çalışmaz; "tepside çalış" ayarı açıksa pencere kapatılsa da çalışmaya devam eder.
 */
class Scheduler {
  constructor({ store, definitions, emit = () => {}, tickMs = 15000, maxConsecutiveFailures = 3 }) {
    this.store = store;
    this.defs = new Map(definitions.map((d) => [d.id, d]));
    this.emit = emit;
    this.tickMs = tickMs;
    this.maxFail = maxConsecutiveFailures;
    this.running = new Map();
    this.timer = null;
    this.globalPaused = false;
    this.ensureState();
  }

  ensureState() {
    const state = this.store.get('automations', {});
    for (const d of this.defs.values()) {
      if (!state[d.id]) {
        state[d.id] = { enabled: !!d.defaultEnabled, intervalMin: d.defaultIntervalMin || null, ...(d.unit === 'sec' ? { intervalSec: d.defaultIntervalSec } : {}), lastRunAt: null, lastFinishedAt: null, lastStatus: null, lastMessage: null, lastError: null, nextRunAt: null, successCount: 0, failCount: 0, consecutiveFailures: 0, settings: d.defaultSettings || {} };
      } else {
        state[d.id].settings = { ...(d.defaultSettings || {}), ...(state[d.id].settings || {}) };
      }
      if (d.unit === 'sec' && !state[d.id].intervalSec) state[d.id].intervalSec = d.defaultIntervalSec;
      if (state[d.id].enabled && !state[d.id].nextRunAt) state[d.id].nextRunAt = new Date(Date.now() + (d.unit === 'sec' ? 10000 : 60000)).toISOString();
    }
    this.store.set('automations', state);
  }

  state() { return this.store.get('automations', {}); }

  list() {
    const s = this.state();
    return [...this.defs.values()].map((d) => ({
      id: d.id, name: d.name, description: d.description, minIntervalMin: d.minIntervalMin || 1, risk: d.risk || 'low',
      unit: d.unit === 'sec' ? 'sec' : 'min', minIntervalSec: d.minIntervalSec || null,
      ...s[d.id], running: this.running.has(d.id), globalPaused: this.globalPaused,
    }));
  }

  patch(id, fn) {
    const all = this.state();
    if (!all[id]) throw new Error('Otomasyon bulunamadı: ' + id);
    all[id] = { ...all[id], ...fn(all[id]) };
    this.store.set('automations', all);
    this.emit('automation', this.list().find((a) => a.id === id));
    return all[id];
  }

  configure(id, { enabled, intervalMin, intervalSec, settings }) {
    const def = this.defs.get(id);
    if (!def) throw new Error('Otomasyon bulunamadı');
    return this.patch(id, (cur) => {
      const next = {};
      if (intervalSec != null && def.unit === 'sec') {
        const n = Math.round(Number(intervalSec));
        const min = def.minIntervalSec || 10;
        if (!Number.isFinite(n) || n < min || n > 3600) throw new Error(`Çalışma sıklığı ${min}–3600 saniye arasında olmalı`);
        next.intervalSec = n;
        next.nextRunAt = new Date(Date.now() + n * 1000).toISOString();
      }
      if (intervalMin != null && def.unit !== 'sec') {
        const n = Math.round(Number(intervalMin));
        if (!Number.isFinite(n) || n < (def.minIntervalMin || 1) || n > 1440) throw new Error(`Çalışma sıklığı ${def.minIntervalMin || 1}–1440 dakika arasında olmalı`);
        next.intervalMin = n;
        next.nextRunAt = new Date(Date.now() + n * 60000).toISOString();
      }
      if (settings) next.settings = { ...cur.settings, ...settings };
      if (enabled != null) {
        next.enabled = !!enabled;
        if (enabled) { next.consecutiveFailures = 0; next.nextRunAt = new Date(Date.now() + 5000).toISOString(); }
        else next.nextRunAt = null;
      }
      return next;
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  setGlobalPause(p) { this.globalPaused = !!p; this.emit('automation-global', { paused: this.globalPaused }); }

  async tick() {
    if (this.globalPaused) return;
    const now = Date.now();
    const s = this.state();
    for (const d of this.defs.values()) {
      const st = s[d.id];
      if (!st || !st.enabled || this.running.has(d.id)) continue;
      if (st.nextRunAt && Date.parse(st.nextRunAt) > now) continue;
      this.run(d.id, 'schedule').catch(() => {});
    }
  }

  /** Bir otomasyonu çalıştırır. Kilit sayesinde eşzamanlı ikinci çalışma reddedilir. */
  async run(id, trigger = 'manual') {
    const def = this.defs.get(id);
    if (!def) throw new Error('Otomasyon bulunamadı');
    if (this.running.has(id)) return { skipped: true, message: 'Zaten çalışıyor' };
    const st = this.state()[id];
    if (trigger === 'schedule' && (!st.enabled || this.globalPaused)) return { skipped: true, message: 'Duraklatılmış' };
    const p = (async () => {
      this.patch(id, () => ({ lastRunAt: nowIso(), lastTrigger: trigger }));
      try {
        const result = await def.run({ settings: this.state()[id].settings, trigger, isEnabled: () => this.state()[id].enabled || trigger === 'manual' });
        const msg = (result && result.message) || 'Tamamlandı';
        const status = (result && result.status) || 'success';
        this.patch(id, (cur) => ({
          lastFinishedAt: nowIso(), lastStatus: status, lastMessage: msg, lastError: status === 'success' ? null : cur.lastError,
          successCount: cur.successCount + 1, consecutiveFailures: 0,
          nextRunAt: cur.enabled ? new Date(Date.now() + periodMs(def, cur)).toISOString() : null,
          ...(result && result.pause ? { enabled: false, nextRunAt: null } : {}),
        }));
        if (result && result.pause) {
          addAudit(this.store, { type: 'automation', action: def.name, initiator: 'automation', status: 'warning', message: 'Otomasyon güvenlik nedeniyle duraklatıldı: ' + msg });
        }
        return { ok: true, status, message: msg };
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        let paused = false;
        this.patch(id, (cur) => {
          const cf = cur.consecutiveFailures + 1;
          // Yalnızca okuma yapan senkronizasyonlar (neverPause) duraklatılmaz; bekleme süresiyle tekrar dener
          paused = !def.neverPause && cf >= this.maxFail;
          // Hata sonrası bekleme: 2^n dakika (en fazla aralık kadar)
          const backoff = def.unit === 'sec' ? Math.min(Math.max(periodMs(def, cur), Math.pow(2, cf) * 30000), 10 * 60000) : Math.min(cur.intervalMin, Math.pow(2, cf)) * 60000;
          return {
            lastFinishedAt: nowIso(), lastStatus: 'failed', lastError: message, lastMessage: message,
            failCount: cur.failCount + 1, consecutiveFailures: cf,
            enabled: paused ? false : cur.enabled,
            nextRunAt: paused || !cur.enabled ? null : new Date(Date.now() + backoff).toISOString(),
          };
        });
        addAudit(this.store, { type: 'automation', action: def.name, initiator: 'automation', status: 'failed', message: message + (paused ? ' — art arda hatalar nedeniyle otomasyon duraklatıldı' : '') });
        return { ok: false, status: 'failed', message, paused };
      } finally {
        this.running.delete(id);
        this.emit('automation', this.list().find((a) => a.id === id));
      }
    })();
    this.running.set(id, p);
    this.emit('automation', this.list().find((a) => a.id === id));
    return p;
  }
}

module.exports = { Scheduler, periodMs };
