'use strict';
/**
 * TÜRKPATENT marka araştırma sayfasını görünür bir pencerede açıp markaları sırayla sorgular.
 * - Doğrulama (CAPTCHA) ya da erişim engeli görülürse durur ve pencereyi kullanıcıya bırakır; aşmaya çalışmaz.
 * - Her marka için sayfa baştan yüklenir (önceki sonuç karışmaz), sorgular arasında en az 6 sn beklenir.
 * - Sonuç tablosu sütun başlıklarına göre okunur (core/brand-check.js).
 */
const { classifyBrand, normBrand } = require('../core/brand-check');

const DEFAULT_URL = 'https://www.turkpatent.gov.tr/arastirma-yap?form=trademark';
const PARTITION = 'persist:turkpatent';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ_SCRIPT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40 && getComputedStyle(el).visibility !== 'hidden'; };
  const txt = document.body ? document.body.innerText : '';
  const challenge = [...document.querySelectorAll('iframe')].some((f) => /recaptcha\\/api2\\/(anchor|bframe)|hcaptcha|challenges\\.cloudflare|turnstile/.test(f.src || '') && vis(f));
  const blocked = challenge || /robot olmad|güvenlik doğrulama|doğrulama kodunu|access denied|erişim engellendi|too many requests/i.test(txt);
  const cells = (row, sel) => [...row.querySelectorAll(sel)].map((c) => (c.innerText || '').trim());
  const tables = [...document.querySelectorAll('table')].map((t) => {
    let headers = cells(t, 'thead th, thead td');
    let rows = [...t.querySelectorAll('tbody tr')].map((tr) => cells(tr, 'td, th'));
    if (!headers.length && rows.length) { headers = rows[0]; rows = rows.slice(1); }
    return { headers, rows };
  });
  const grids = [...document.querySelectorAll('[role=table],[role=grid]')].map((g) => ({
    headers: cells(g, '[role=columnheader]'),
    rows: [...g.querySelectorAll('[role=row]')].map((r) => cells(r, '[role=cell],[role=gridcell]')).filter((r) => r.length),
  }));
  const noResultText = /kay[ıi]t bulunamad|sonuç bulunamad|eşleşen kay[ıi]t yok|veri bulunamad|no records|no results/i.test(txt);
  // Formun şu anki durumu (TÜRKPATENT: MUI radyo değerleri isEqual / custom, sınıflar MUI çoklu seçim kutusunda "25,35")
  const radios = [...document.querySelectorAll('input[type=radio]')];
  const eqR = radios.find((r) => r.value === 'isEqual');
  const customR = radios.find((r) => r.value === 'custom');
  let form = null;
  if (eqR || customR) {
    let classes = [];
    if (customR && customR.checked) {
      const host = (customR.closest('[role=radiogroup]') || customR).parentElement;
      const nat = host && host.querySelector('input.MuiSelect-nativeInput');
      if (nat && nat.value) classes = nat.value.split(',').map((x) => x.trim()).filter(Boolean);
    }
    form = { equal: !!(eqR && eqR.checked), classes };
  }
  // Sayfalama: "Sayfa Başına Kayıt 20 1-20 of 31"
  const pg = document.querySelector('.MuiTablePagination-root, [class*=TablePagination]');
  const pm = pg ? (pg.innerText || '').replace(/\\s+/g, ' ').match(/(\\d+)\\s*[-–]\\s*(\\d+)\\s*(?:of|\\/|içinden|toplam)\\s*(\\d+)/i) : null;
  const pager = pm ? { from: +pm[1], to: +pm[2], total: +pm[3] } : null;
  return { tables: tables.concat(grids), noResultText, blocked, form, pager, url: location.href };
})()`;

const fillScript = (q, classes = []) => `(async (q, want) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
  const inputs = [...document.querySelectorAll('input[type=text], input[type=search], input:not([type])')].filter(vis);
  const label = (i) => [i.placeholder, i.name, i.id, i.getAttribute('aria-label'), i.labels && i.labels[0] && i.labels[0].innerText].join(' ').toLocaleLowerCase('tr-TR');
  const score = (i) => (/marka\\s*ad|markaad|trademark/.test(label(i)) ? 3 : /marka/.test(label(i)) && !/tip|bülten|bulten/.test(label(i)) ? 2 : 0);
  const inp = inputs.sort((a, b) => score(b) - score(a))[0];
  if (!inp || !score(inp)) return { ok: false, why: 'Sayfada "Marka adı" alanı bulunamadı' };
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  inp.focus(); set.call(inp, q);
  inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
  const radios = [...document.querySelectorAll('input[type=radio]')];
  const opts = [...document.querySelectorAll('label, mat-radio-button, [role=radio], .mat-radio-label, span')].filter(vis);
  const pick = (re) => { const el = opts.find((o) => re.test((o.innerText || '').trim()) && (o.innerText || '').trim().length < 30); if (el) { (el.querySelector('input') || el).click(); return true; } return false; };
  // Marka adı için "ile eşit" (ilk isEqual marka adına aittir; ikincisi başvuru sahibine)
  const eqR = radios.find((r) => r.value === 'isEqual');
  let equal;
  if (eqR) { if (!eqR.checked) eqR.click(); equal = eqR.checked; } else equal = pick(/^ile eşit$/i);
  // Nice sınıfları: "belirtilen sınıflar" → çoklu seçim kutusunda yalnızca istenenler (25, 35)
  let got = [];
  if (want.length) {
    const customR = radios.find((r) => r.value === 'custom');
    if (customR) {
      if (!customR.checked) { customR.click(); await sleep(150); }
      const host = (customR.closest('[role=radiogroup]') || customR).parentElement;
      const sel = host && host.querySelector('[aria-haspopup=listbox]');
      const nat = host && host.querySelector('input.MuiSelect-nativeInput');
      const cur = () => (nat && nat.value ? nat.value.split(',').map((x) => x.trim()).filter(Boolean) : []);
      const wantP = want.map((c) => String(c).padStart(2, '0'));
      const same = () => { const c = cur(); return c.length === wantP.length && wantP.every((x) => c.includes(x)); };
      if (sel && !same()) {
        for (let i = 0; i < 10 && sel.getAttribute('aria-disabled') === 'true'; i++) await sleep(100);
        sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, view: window }));
        const option = (v) => [...document.querySelectorAll('[role=listbox] [role=option]')].find((o) => o.getAttribute('data-value') === v);
        for (let i = 0; i < 30 && !document.querySelector('[role=listbox] [role=option]'); i++) await sleep(80);
        for (const v of [...new Set([...wantP, ...cur()])]) {
          const o = option(v); if (!o) continue;
          const on = o.getAttribute('aria-selected') === 'true' || /Mui-selected/.test(o.className);
          if (wantP.includes(v) !== on) { o.click(); await sleep(80); }
        }
        const bd = document.querySelector('.MuiPopover-root .MuiBackdrop-root, .MuiPopover-root > div[aria-hidden=true], .MuiMenu-root .MuiBackdrop-root');
        if (bd) bd.click(); else { const lb = document.querySelector('[role=listbox]'); if (lb) lb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
        for (let i = 0; i < 20 && document.querySelector('[role=listbox]'); i++) await sleep(60);
      }
      if (customR.checked) got = cur().map((c) => String(Number(c)));
    } else if (pick(/^belirtilen s[ıi]n[ıi]flar$/i)) {
      // Onay kutulu başka bir sayfa yapısı
      for (const c of want) {
        const box = [...document.querySelectorAll('label, mat-checkbox, [role=checkbox], li, span, div')].filter(vis).find((o) => ((t) => [c, '0' + c].some((x) => t === x || t.startsWith(x + ' ') || t.startsWith(x + '-') || t.startsWith(x + '.') || t.startsWith(x + ':')))((o.innerText || '').trim()) && (o.innerText || '').trim().length < 120 && !o.querySelector('label, mat-checkbox'));
        if (!box) continue;
        const cb = box.querySelector('input[type=checkbox]') || (box.closest('label, mat-checkbox') || box).querySelector('input[type=checkbox]');
        const hostEl = box.closest('label, mat-checkbox') || box;
        const on = cb ? cb.checked : (/checked/.test(hostEl.className) || hostEl.getAttribute('aria-checked') === 'true');
        if (!on) (cb || hostEl).click();
        if (cb ? cb.checked : true) got.push(String(Number(c)));
      }
    }
  }
  const btn = [...document.querySelectorAll('button, input[type=submit], a[role=button]')].filter(vis).find((b) => /^(sorgula|ara|araştır|search)$/i.test((b.innerText || b.value || '').trim()));
  const meta = { equal, classes: got };
  if (btn) { btn.click(); return { ok: true, ...meta }; }
  if (inp.form && inp.form.requestSubmit) { inp.form.requestSubmit(); return { ok: true, ...meta }; }
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  return { ok: true, enter: true, ...meta };
})(${JSON.stringify(q)}, ${JSON.stringify(classes)})`;

/**
 * Sonuçlar birden fazla sayfadaysa: "Sayfa Başına Kayıt" en büyük seçeneğe (50) alınır, gerekirse sonraki sayfalar okunur
 * (en fazla 6 sayfa). Sayfa boyutu sonraki aramalarda da korunur. Kullanıcının yapacağı gibi sayfadaki düğmeler kullanılır.
 */
const EXPAND_SCRIPT = `(async () => {
  const T = (e) => ((e && (e.innerText ?? e.textContent)) || '').replace(/\\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const table = () => [...document.querySelectorAll('table')].find((t) => [...t.querySelectorAll('thead th, thead td')].some((h) => /marka\\s*ad/i.test(T(h))));
  const pagerEl = () => document.querySelector('.MuiTablePagination-root, [class*=TablePagination]');
  const info = () => { const m = T(pagerEl()).match(/(\\d+)\\s*[-–]\\s*(\\d+)\\s*(?:of|\\/|içinden|toplam)\\s*(\\d+)/i); return m ? { from: +m[1], to: +m[2], total: +m[3] } : null; };
  const cells = (row) => [...row.querySelectorAll('td, th')].map((c) => (c.innerText || '').trim());
  const rowsOf = () => { const t = table(); return t ? [...t.querySelectorAll('tbody tr')].map(cells) : []; };
  const sig = () => T(pagerEl()) + '|' + (rowsOf()[0] || []).join('|');
  const blocked = () => /robot olmad|güvenlik doğrulama|doğrulama kodunu|access denied|erişim engellendi|too many requests/i.test(document.body ? document.body.innerText : '');
  const waitChange = async (before, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await sleep(150); if (blocked()) return false; if (sig() !== before) { await sleep(300); return true; } } return false; };
  const t = table();
  if (!t) return { ok: false, why: 'Sonuç tablosu yok' };
  const headers = [...t.querySelectorAll('thead th, thead td')].map((c) => (c.innerText || '').trim());
  let inf = info();
  if (!inf) return { ok: false, why: 'Sayfalama okunamadı' };
  const pg = pagerEl();
  const sel = pg && pg.querySelector('[aria-haspopup=listbox]');
  if (inf.total > inf.to && sel) {
    const before = sig();
    sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, view: window }));
    let opts = [];
    for (let i = 0; i < 30 && !opts.length; i++) { await sleep(80); opts = [...document.querySelectorAll('[role=listbox] [role=option]')]; }
    const best = opts.filter((o) => /^\\d+$/.test(o.getAttribute('data-value') || '')).sort((a, b) => Number(b.getAttribute('data-value')) - Number(a.getAttribute('data-value')))[0];
    const curSize = Number((pg.querySelector('input.MuiSelect-nativeInput') || {}).value || 0);
    if (best && Number(best.getAttribute('data-value')) > curSize) { best.click(); await waitChange(before); }
    else { const bd = document.querySelector('.MuiPopover-root .MuiBackdrop-root, .MuiPopover-root > div[aria-hidden=true]'); if (bd) bd.click(); }
    for (let i = 0; i < 20 && document.querySelector('[role=listbox]'); i++) await sleep(60);
    inf = info();
  }
  const all = rowsOf();
  for (let p = 0; p < 6 && inf && inf.to < inf.total && !blocked(); p++) {
    const next = [...pagerEl().querySelectorAll('button')].find((b) => /sonraki|next/i.test(b.getAttribute('aria-label') || b.title || T(b)));
    if (!next || next.disabled) break;
    const before = sig(); next.click();
    if (!(await waitChange(before))) break;
    inf = info(); all.push(...rowsOf());
  }
  return { ok: true, headers, rows: all, total: inf ? inf.total : null, blocked: blocked() };
})()`;

class BrandChecker {
  constructor({ electron, getUrl, onResult, onState, gapMs = 2500, devAllowLocal = false, classes = ['25', '35'], concurrency = 7 }) {
    this.classes = classes;
    this.concurrency = Math.max(1, Math.min(8, concurrency));
    this.electron = electron;
    this.getUrl = getUrl;
    this.onResult = onResult;
    this.onState = onState || (() => {});
    this.gapMs = gapMs;
    this.devAllowLocal = devAllowLocal;
    this.win = null;
    this.state = { running: false, total: 0, done: 0, current: null, error: null, stoppedReason: null };
    this.stopFlag = false;
  }

  url() {
    const u = this.getUrl() || DEFAULT_URL;
    try {
      const x = new URL(u);
      if (x.protocol === 'https:' && /(^|\.)turkpatent\.gov\.tr$/.test(x.hostname)) return u;
      if (this.devAllowLocal && x.protocol === 'http:' && x.hostname === '127.0.0.1') return u;
    } catch (_) { /* geçersiz */ }
    return DEFAULT_URL;
  }

  makeWindow(main) {
    const { BrowserWindow, shell } = this.electron;
    const win = new BrowserWindow({ show: false, width: 1180, height: 820, title: 'TÜRKPATENT marka sorgusu', autoHideMenuBar: true, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    if (main) win.on('closed', () => { this.win = null; if (this.state.running) this.stop('Pencere kapatıldı'); });
    this.hookNetwork(win.webContents.session);
    return win;
  }

  /** Ana pencere: kullanıcıya gösterilebilen, elle arama yapılan pencere (1. sorgu kanalı da budur). */
  window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = this.makeWindow(true);
    return this.win;
  }

  /** Oturumdaki arka plan isteklerini pencere bazında sayar (arama yanıtı gelince hemen okumak için). */
  hookNetwork(ses) {
    if (this.hooked === ses) return;
    this.hooked = ses;
    this.nets = this.nets || new Map();
    const filter = { urls: ['*://*/*'] };
    const net = (d) => (d.resourceType === 'xhr' || d.resourceType === 'fetch') && this.nets.get(d.webContentsId);
    ses.webRequest.onBeforeRequest(filter, (d, cb) => { const n = net(d); if (n) n.pending++; cb({}); });
    const end = (d) => { const n = net(d); if (n) { n.pending = Math.max(0, n.pending - 1); n.done++; } };
    ses.webRequest.onCompleted(filter, end);
    ses.webRequest.onErrorOccurred(filter, end);
  }
  netOf(win) {
    this.nets = this.nets || new Map();
    const id = win.webContents.id;
    if (!this.nets.has(id)) this.nets.set(id, { pending: 0, done: 0 });
    return this.nets.get(id);
  }

  setState(p) { this.state = { ...this.state, ...p }; this.onState(this.state); }
  stop(reason = 'Durduruldu') { this.stopFlag = true; this.setState({ stoppedReason: reason }); }
  publicState() { return { ...this.state, url: this.url(), concurrency: this.concurrency }; }

  async read(win = this.window()) {
    return win.webContents.executeJavaScript(READ_SCRIPT, true);
  }

  async ensurePage(w, force) {
    const net = this.netOf(w.win);
    const cur = w.win.webContents.getURL();
    // Sayfa her markada yeniden yüklenmez; 60 sorguda bir tazelenir
    if (force || !cur || !cur.startsWith(this.url().split('?')[0]) || w.searches >= 60) {
      await Promise.race([w.win.loadURL(this.url()), sleep(30000).then(() => { throw new Error('TÜRKPATENT sayfası 30 sn içinde açılmadı'); })]);
      w.searches = 0;
      for (let i = 0; i < 20 && net.pending; i++) await sleep(150);
      await sleep(300);
    }
    return net;
  }

  async searchOne(brand, w = { win: this.window(), searches: 0 }) {
    const net = await this.ensurePage(w, false);
    let page = await this.read(w.win);
    if (page.blocked) return { ...page, searched: false };
    const before = net.done;
    let f = await w.win.webContents.executeJavaScript(fillScript(brand, this.classes), true);
    w.searches++;
    if (!f.ok) {
      await this.ensurePage(w, true);
      f = await w.win.webContents.executeJavaScript(fillScript(brand, this.classes), true);
      if (!f.ok) return { tables: [], blocked: false, searched: false, why: f.why };
    }
    // Yanıtı bekle: en az bir istek tamamlanmalı ve ardından 0,5 sn boyunca yeni istek başlamamalı
    // (doğrulama/güvenlik istekleri arama isteğinden önce bitebilir; erken okunursa önceki aramanın sonucu görülür)
    const t0 = Date.now();
    let idleSince = 0, sawReq = false;
    while (Date.now() - t0 < 20000) {
      await sleep(100);
      if (net.done > before) sawReq = true;
      if (sawReq && !net.pending) { if (!idleSince) idleSince = Date.now(); if (Date.now() - idleSince >= 500) break; } else idleSince = 0;
      if (!sawReq && !net.pending && Date.now() - t0 > 5000) break;
    }
    const key = normBrand(brand);
    const nameCol = (t) => (t.headers || []).findIndex((h) => /marka\s*ad/i.test(h));
    const fresh = (pg) => {
      // "ile eşit" aramasında tablodaki adların hepsi aranan markayla aynı olmalı; değilse önceki aramanın tablosudur
      const t = (pg.tables || []).find((x) => x.rows && x.rows.length && nameCol(x) >= 0);
      if (!t) return !!pg.noResultText;
      const i = nameCol(t);
      return !(pg.form || f).equal || t.rows.some((r) => normBrand(r[i]) === key);
    };
    page = await this.read(w.win);
    if (page.blocked) return { ...page, searched: true };
    // Hiç istek görülmediyse sayfadaki tablo/mesaj önceki aramaya aittir: sonuç kullanılmaz
    if (!sawReq) return { ...page, tables: [], noResultText: false, searched: true, timeout: true, filter: page.form || f };
    for (let i = 0; !fresh(page); i++) {
      if (i >= 40) return { ...page, tables: [], noResultText: false, searched: true, timeout: true, stale: true, filter: page.form || f };
      await sleep(250);
      page = await this.read(w.win);
      if (page.blocked) return { ...page, searched: true };
    }
    // Sonuçlar birden fazla sayfadaysa hepsini oku
    const shown = (page.tables || []).reduce((n, t) => (nameCol(t) >= 0 ? n + (t.rows || []).length : n), 0);
    if (page.pager && page.pager.total > shown) {
      const more = await w.win.webContents.executeJavaScript(EXPAND_SCRIPT, true).catch(() => null);
      if (more && more.blocked) return { ...page, blocked: true, searched: true };
      if (more && more.ok && more.rows.length >= shown) {
        page = { ...page, tables: [{ headers: more.headers, rows: more.rows }], pager: { ...page.pager, total: more.total ?? page.pager.total } };
      }
    }
    return { ...page, searched: true, filter: page.form || { equal: f.equal, classes: f.classes } };
  }

  /**
   * Markaları sorgular. Aynı anda en fazla `concurrency` (varsayılan 7) gizli pencere çalışır.
   * Robot doğrulaması çıkarsa: tüm pencereler durur, doğrulama istenen pencere sana gösterilir.
   * Doğrulamayı SEN yaptıktan sonra (panel bunu kendisi fark eder) sorgu kaldığı yerden,
   * paralel pencere sayısı yarıya inerek devam eder. Doğrulama otomatik geçilmeye çalışılmaz.
   */
  async run(brands) {
    if (this.state.running) throw new Error('Marka sorgusu zaten sürüyor');
    const list = [...new Set(brands.filter(Boolean))].slice(0, 1000);
    if (!list.length) throw new Error('Sorgulanacak marka yok');
    this.stopFlag = false;
    let level = Math.max(1, Math.min(this.concurrency, list.length));
    this.setState({ running: true, total: list.length, done: 0, current: null, error: null, stoppedReason: null, waitingCaptcha: false, parallel: level, startedAt: Date.now() });
    const queue = [...list];
    const extra = [];
    const worker = async (w, i, round) => {
      await sleep(i * 350);
      let slow = 0;
      while (!this.stopFlag && !round.blocked && queue.length) {
        const brand = queue.shift();
        this.setState({ current: brand });
        let page;
        try { page = await this.searchOne(brand, w); } catch (e) { page = null; this.setState({ error: e.message }); }
        if (page && page.blocked) { queue.unshift(brand); if (!round.blocked) round.blocked = w; break; }
        const res = classifyBrand(brand, page, { classes: this.classes });
        if (page && page.filter) res.filter = { equal: !!page.filter.equal, classes: (page.filter.classes || []).map((c) => String(Number(c))) };
        if (page && page.why) res.reason = page.why;
        if (page && page.stale) res.reason = 'Sonuç tablosu bu markaya ait görünmüyor (önceki arama); yeniden sorgulanmalı';
        else if (page && page.timeout && res.status === 'unverified') res.reason = 'Sonuç 20 sn içinde gelmedi';
        this.onResult(brand, res);
        this.setState({ done: this.state.done + 1 });
        if (page && page.why) { this.stop(page.why + '. Pencerede aramayı kendiniz yapıp "Bu sayfadaki sonucu oku" diyebilirsiniz.'); break; }
        slow = !page || page.timeout ? slow + 1 : 0;
        await sleep(this.gapMs + Math.random() * 600 + (slow >= 2 ? 5000 : 0));
      }
    };
    (async () => {
      try {
        while (!this.stopFlag && queue.length) {
          const workers = [{ win: this.window(), searches: 0 }];
          while (workers.length < level) {
            if (!extra[workers.length - 1] || extra[workers.length - 1].isDestroyed()) extra[workers.length - 1] = this.makeWindow(false);
            workers.push({ win: extra[workers.length - 1], searches: 0 });
          }
          const round = { blocked: null };
          this.setState({ parallel: level });
          await Promise.all(workers.map((w, i) => worker(w, i, round)));
          if (!round.blocked || this.stopFlag) break;
          // Robot doğrulaması: kullanıcı çözene kadar bekle (en fazla 15 dk), sonra daha az paralelle devam et
          const bw = round.blocked.win;
          this.setState({ waitingCaptcha: true, stoppedReason: 'TÜRKPATENT robot doğrulaması istedi. Açılan pencerede doğrulamayı yapın; sorgu kendiliğinden devam edecek.' });
          if (!bw.isDestroyed()) { bw.show(); bw.focus(); }
          const t0 = Date.now();
          let solved = false;
          while (!this.stopFlag && Date.now() - t0 < 15 * 60000) {
            await sleep(2000);
            if (bw.isDestroyed()) break;
            const pg = await this.read(bw).catch(() => null);
            if (pg && !pg.blocked) { solved = true; break; }
          }
          if (!solved) { this.stop(this.stopFlag ? 'Durduruldu' : 'Doğrulama yapılmadı; sorgu durduruldu. Tekrar başlatabilirsiniz.'); break; }
          if (!bw.isDestroyed() && bw !== this.win) bw.hide();
          level = Math.max(1, Math.floor(level / 2));
          this.setState({ waitingCaptcha: false, stoppedReason: null, parallel: level });
        }
      } finally {
        for (const w of extra) if (w && !w.isDestroyed()) { this.nets && this.nets.delete(w.webContents.id); w.destroy(); }
        if (this.win && !this.win.isDestroyed() && this.win.isVisible() && !this.state.waitingCaptcha) this.win.hide();
        this.setState({ running: false, current: null, waitingCaptcha: false });
        // Bellekte tutma: sorgu bitince gizli TÜRKPATENT sayfası kapatılır (oturum çerezleri bölümde saklı kalır)
        if (this.win && !this.win.isDestroyed() && !this.win.isVisible()) { const w = this.win; this.win = null; this.nets && this.nets.delete(w.webContents.id); w.destroy(); }
      }
    })();
    return this.publicState();
  }

  /** Kullanıcının pencerede kendi yaptığı aramanın sonucunu okur. */
  async readCurrent(brand) {
    if (!this.win || this.win.isDestroyed()) throw new Error('TÜRKPATENT penceresi açık değil');
    const page = await this.read(this.win);
    const res = classifyBrand(brand, { ...page, searched: true }, { classes: this.classes });
    if (page.form) res.filter = { equal: !!page.form.equal, classes: (page.form.classes || []).map((c) => String(Number(c))) };
    this.onResult(brand, res);
    return res;
  }

  open() { const w = this.window(); if (!w.webContents.getURL()) w.loadURL(this.url()); w.show(); w.focus(); }
}

module.exports = { BrandChecker, DEFAULT_URL, READ_SCRIPT, EXPAND_SCRIPT, fillScript };
