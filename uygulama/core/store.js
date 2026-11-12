'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Basit, bağımlılıksız JSON veri deposu.
 * - Her koleksiyon ayrı bir dosyadır (ör. catalog.json, jobs.json).
 * - Yazma işlemleri atomiktir: önce .tmp dosyasına yazılır, sonra yeniden adlandırılır.
 *   Böylece uygulama yazma sırasında kapanırsa eski dosya bozulmaz.
 * - Kritik kayıtlar (toplu işlemler) saveNow ile anında diske yazılır.
 */
class JsonStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
    this.timers = new Map();
    this.revs = new Map();
  }

  /** Koleksiyonun sürüm sayacı: her set/update'te artar. Hesap önbellekleri "veri değişti mi?" sorusunu bununla yanıtlar. */
  rev(name) { return this.revs.get(name) || 0; }

  file(name) {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('Geçersiz koleksiyon adı: ' + name);
    return path.join(this.dir, name + '.json');
  }

  get(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let value = fallback;
    const f = this.file(name);
    try {
      if (fs.existsSync(f)) value = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      // Bozuk dosyayı yedekleyip varsayılanla devam et, veriyi sessizce silme.
      try { fs.copyFileSync(f, f + '.bozuk-' + Date.now()); } catch (_) { /* yoksay */ }
      value = fallback;
    }
    if (value === undefined) value = fallback;
    this.cache.set(name, value);
    return value;
  }

  set(name, value, { immediate = false } = {}) {
    this.cache.set(name, value);
    this.revs.set(name, (this.revs.get(name) || 0) + 1);
    if (immediate) return this.saveNow(name);
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(() => this.saveNow(name), 300));
  }

  update(name, fallback, fn, opts) {
    const cur = this.get(name, fallback);
    const next = fn(cur);
    this.set(name, next === undefined ? cur : next, opts);
    return this.get(name);
  }

  saveNow(name) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    const f = this.file(name);
    const tmp = f + '.tmp';
    const data = JSON.stringify(this.cache.get(name));
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, f);
  }

  flushAll() {
    for (const name of [...this.timers.keys()]) this.saveNow(name);
  }
}

module.exports = { JsonStore };
