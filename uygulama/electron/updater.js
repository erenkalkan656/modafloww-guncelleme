'use strict';
// Uzaktan güncelleme (bilgisayar): herkese açık güncelleme deposundaki latest.json'a bakar; yeni sürüm varsa paketi indirir,
// SHA-256 özetini ve paket içindeki her dosyayı doğrular. Kurulum yalnızca kullanıcı onaylayınca yapılır; sonra uygulama
// yeniden başlar. API bilgileri ve mağaza verileri güncellemeye dahil değildir (onlar kullanıcı klasöründe durur).
const fs = require('fs');
const path = require('path');
const { unpackBundle, parseLatest, sha256 } = require('../core/update-bundle');

const DEFAULT_BASE = 'https://raw.githubusercontent.com/erenkalkan656/modafloww-guncelleme/pc/';

class Updater {
  constructor({ electron, appDir, base, emit, restart, isDev }) {
    this.electron = electron;
    this.appDir = appDir;
    this.base = String(base || DEFAULT_BASE).replace(/\/?$/, '/');
    this.emit = emit || (() => {});
    this.restart = restart || (() => {});
    this.isDev = !!isDev;
    this.state = { phase: 'idle', latest: null, error: null, checkedAt: 0, progress: null };
    this.ready = null;
  }

  /** Kurulu sürüm (build-info.json yoksa 0: güncelleme özelliği gelmeden önceki kurulum). */
  current() {
    try { const j = JSON.parse(fs.readFileSync(path.join(this.target() || this.appDir, 'build-info.json'), 'utf8')); return { build: Number(j.build) || 0, version: String(j.version || '') }; } catch (_) { return { build: 0, version: '' }; }
  }

  /** Güncelleme yalnızca kurulu kopyaya (…/resources/app) uygulanır; kaynak klasöründen çalışırken dosyaların üzerine yazılmaz. */
  target() {
    if (this.isDev && process.env.TSP_UPDATE_TARGET) return process.env.TSP_UPDATE_TARGET;
    const ok = /[\\/]resources[\\/]app$/i.test(this.appDir) && fs.existsSync(path.join(this.appDir, 'electron', 'main.js'));
    return ok ? this.appDir : null;
  }

  status() {
    const cur = this.current();
    const s = this.state;
    return { build: cur.build, version: cur.version || (cur.build ? '1.0.' + cur.build : ''), canInstall: !!this.target(), phase: s.phase, latest: s.latest, available: !!(s.latest && s.latest.build > cur.build), error: s.error, checkedAt: s.checkedAt, progress: s.progress };
  }
  set(patch) { Object.assign(this.state, patch); this.emit('update', this.status()); }

  async get(url, { binary = false, max = 0 } = {}) {
    const f = (this.electron && this.electron.net && this.electron.net.fetch) ? this.electron.net.fetch.bind(this.electron.net) : fetch;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), binary ? 180000 : 20000);
    try {
      const res = await f(url, { signal: ctl.signal, cache: 'no-store', redirect: 'follow' });
      if (!res.ok) throw new Error('Güncelleme sunucusu yanıt vermedi (' + res.status + ')');
      if (!binary) return await res.json();
      const buf = Buffer.from(await res.arrayBuffer());
      if (max && buf.length > max) throw new Error('İndirilen dosya beklenenden büyük.');
      return buf;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('Güncelleme sunucusuna ulaşılamadı (zaman aşımı).');
      throw e;
    } finally { clearTimeout(t); }
  }

  /** Yeni sürüm var mı? (Sık sormaz: zorlanmadıkça 3 saatte bir.) */
  async check({ force = false } = {}) {
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'installing') return this.status();
    if (!force && Date.now() - this.state.checkedAt < 3 * 3600000) return this.status();
    this.set({ phase: 'checking', error: null });
    try {
      const latest = parseLatest(await this.get(this.base + 'latest.json?t=' + Date.now()));
      if (!latest) throw new Error('Güncelleme bilgisi okunamadı.');
      this.set({ phase: this.ready && this.ready.build === latest.build ? 'ready' : 'idle', latest, checkedAt: Date.now() });
    } catch (e) {
      this.set({ phase: 'idle', error: e.message || String(e), checkedAt: Date.now() });
    }
    return this.status();
  }

  /** Paketi indirir ve doğrular (henüz hiçbir dosyaya dokunmaz). */
  async download() {
    const latest = this.state.latest;
    if (!latest || latest.build <= this.current().build) throw new Error('Kurulacak yeni sürüm yok.');
    if (!this.target()) throw new Error('Bu kopya kendini güncelleyemez (kurulu kopya değil).');
    if (this.ready && this.ready.build === latest.build) return this.status();
    this.set({ phase: 'downloading', error: null, progress: 0 });
    try {
      const buf = await this.get(this.base + latest.file, { binary: true, max: latest.size + 1024 });
      if (buf.length !== latest.size || sha256(buf) !== latest.sha256) throw new Error('İndirilen güncelleme doğrulanamadı (dosya özeti tutmuyor). Kurulmadı.');
      this.ready = unpackBundle(buf, { expectBuild: latest.build });
      this.set({ phase: 'ready', progress: 1 });
    } catch (e) {
      this.ready = null;
      this.set({ phase: 'idle', error: e.message || String(e), progress: null });
      throw e;
    }
    return this.status();
  }

  /** Doğrulanmış paketi kurar ve uygulamayı yeniden başlatır. Yalnızca kullanıcı onayıyla çağrılır. */
  async install() {
    if (!this.ready) await this.download();
    const dir = this.target();
    if (!dir) throw new Error('Bu kopya kendini güncelleyemez (kurulu kopya değil).');
    const { files, build } = this.ready;
    this.set({ phase: 'installing', error: null });
    const stage = path.join(dir, '.guncelleme');
    try {
      // 1) Hepsini önce hazırlık klasörüne yaz (disk dolu/izin yok gibi hatalar asıl dosyalara dokunmadan ortaya çıksın)
      fs.rmSync(stage, { recursive: true, force: true });
      for (const f of files) { const p = path.join(stage, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.data); }
      // 2) Asıl dosyaların üzerine kopyala; sürüm bilgisi EN SON yazılır (yarıda kalırsa güncelleme yeniden önerilir)
      const targets = [dir];
      const mirror = path.resolve(dir, '..', '..', '..', 'uygulama'); // kurulum klasöründeki kaynak kopya da güncel kalsın
      if (!process.env.TSP_UPDATE_TARGET && fs.existsSync(path.join(mirror, 'electron', 'main.js'))) targets.push(mirror);
      const ordered = [...files.filter((f) => f.path !== 'build-info.json'), files.find((f) => f.path === 'build-info.json')];
      for (const t of targets) {
        for (const f of ordered) { const p = path.join(t, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(path.join(stage, f.path), p); }
      }
      fs.rmSync(stage, { recursive: true, force: true });
    } catch (e) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) { /* yoksay */ }
      this.set({ phase: 'ready', error: 'Güncelleme kurulamadı: ' + (e.message || e) });
      throw new Error('Güncelleme kurulamadı: ' + (e.message || e));
    }
    this.ready = null;
    this.set({ phase: 'installed' });
    setTimeout(() => { try { this.restart(build); } catch (_) { /* yoksay */ } }, 600);
    return this.status();
  }
}

module.exports = { Updater, DEFAULT_BASE };
