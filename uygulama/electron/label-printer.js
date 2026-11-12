'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep } = require('../core/util');
const { verifyLabel, assignParts, idsOf } = require('../core/label-verify');

/**
 * Kargo etiketini satıcı paneline gitmeden yazdırır.
 *
 * Nasıl çalışır (Trendyol panel kodu Ekim 2026'da incelendi):
 *  - Panelde "Kargo Etiketini A4 / Sticker Yazdır" düğmesi etiketi tarayıcıda çizer (react-to-print),
 *    gizli bir <iframe id="printWindow"> içine kopyalar ve iframe.print() çağırır. Aynı anda paket
 *    Trendyol'da "etiket yazdırıldı" olarak işaretlenir (prints/paper veya prints/sticker). Sipariş durumu değişmez.
 *  - Bu modül aynı işlemi kullanıcının giriş yaptığı panel oturumunda GÖRÜNMEZ bir pencerede yapar:
 *    yazdırma çağrısını yakalar, hazırlanan etiket sayfasını alır ve doğrudan yazıcıya (veya PDF'e) gönderir.
 *  - Giriş/CAPTCHA/2FA atlatılmaz; giriş yoksa hata verir. Panel ek bir seçim isterse (A4 seçenekleri,
 *    desi/koli uyarısı, birden çok paket) hiçbir şey seçilmez; panel görünür açılır ve satıcı kendisi tamamlar.
 */

const PANEL_ORIGIN = 'https://partner.trendyol.com';

function orderUrl(base, orderNumber) {
  return `${base}/orders/shipment-packages/all?orderNumber=%22${orderNumber}%22&page=0`;
}

/** Sayfaya kurulan yazdırma kancası: iframe.print() / window.print() çağrılarını yazıcı yerine bize bildirir. */
const HOOK_SCRIPT = `(() => {
  if (window.__tspHook) return 'ok';
  window.__tspHook = true;
  window.__tspPrinted = null;
  window.__tspTopPrint = false;
  const patch = (f) => {
    try {
      const w = f.contentWindow;
      if (!w || w.__tspPatched) return;
      w.print = function () { window.__tspPrinted = f; };
      w.__tspPatched = true;
    } catch (_) { /* farklı kaynaklı iframe: dokunma */ }
  };
  const hook = (f) => { patch(f); f.addEventListener('load', () => patch(f), true); };
  window.print = function () { window.__tspTopPrint = true; };
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.tagName === 'IFRAME') hook(n);
      else if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(hook);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => document.querySelectorAll('iframe').forEach(patch), 4);
  return 'ok';
})()`;

function findScript(kind, orderNumber) {
  const suffix = kind === 'a4' ? '-add-on-print-a4-button' : '-add-on-print-sticker-button';
  return `(() => {
    if (/\\/(login|giris|auth)/i.test(location.pathname) || document.querySelector('input[type="password"]')) return { state: 'login' };
    const text = document.body ? document.body.innerText : '';
    const btns = [...document.querySelectorAll('button[data-testid^="shipment-packages-"][data-testid$="${suffix}"]')].filter((b) => b.offsetParent !== null);
    if (!text.includes(${JSON.stringify(orderNumber)})) {
      if (/(sonuç|kayıt|sipariş|paket)[^.\\n]{0,20}bulunamadı/i.test(text)) return { state: 'empty' };
      return { state: 'wait' };
    }
    if (btns.length === 1) return { state: btns[0].disabled ? 'disabled' : 'ready' };
    if (btns.length > 1) return { state: 'multi', count: btns.length };
    return { state: 'nobutton' };
  })()`;
}

function clickScript(kind) {
  const suffix = kind === 'a4' ? '-add-on-print-a4-button' : '-add-on-print-sticker-button';
  return `(() => {
    const b = [...document.querySelectorAll('button[data-testid^="shipment-packages-"][data-testid$="${suffix}"]')].filter((x) => x.offsetParent !== null);
    if (b.length !== 1) return false;
    b[0].click();
    return true;
  })()`;
}

const RESULT_SCRIPT = `(() => {
  if (window.__tspPrinted) return { state: 'printed' };
  if (window.__tspTopPrint) return { state: 'top' };
  if (document.querySelector('[data-testid^="a4-print-option"]')) return { state: 'options' };
  return { state: 'wait' };
})()`;

/** Yakalanan etiket iframe'inin içeriğini tek başına açılabilir bir HTML belgesine çevirir. */
const EXTRACT_SCRIPT = `(() => {
  const f = window.__tspPrinted;
  const d = f && f.contentDocument;
  if (!d || !d.documentElement) return null;
  // Tuvaller (barkod vb.) HTML'e çevrilince boş kalır: resme dönüştür
  d.querySelectorAll('canvas').forEach((c) => {
    try {
      const img = d.createElement('img');
      img.src = c.toDataURL('image/png');
      img.className = c.className;
      img.setAttribute('style', c.getAttribute('style') || '');
      if (!img.style.width) img.style.width = (c.style.width || c.width + 'px');
      if (!img.style.height) img.style.height = (c.style.height || c.height + 'px');
      c.replaceWith(img);
    } catch (_) { /* yoksay */ }
  });
  // CSSOM ile eklenen stiller metinde görünmez: kurallardan yeniden yaz
  d.querySelectorAll('style').forEach((s) => {
    try {
      if (!s.textContent.trim() && s.sheet && s.sheet.cssRules.length) s.textContent = [...s.sheet.cssRules].map((r) => r.cssText).join('\\n');
    } catch (_) { /* yoksay */ }
  });
  d.querySelectorAll('script').forEach((s) => s.remove());
  if (!d.querySelector('base')) { const b = d.createElement('base'); b.href = location.origin + '/'; d.head.prepend(b); }
  return '<!DOCTYPE html>' + d.documentElement.outerHTML;
})()`;

// ---------- Toplu yazdırma (panelde: kutuları seç → Toplu İşlemler → Sticker/A4 Kargo Etiketi Yazdır) ----------
// Gerçek panel sayfası buradan görülemediği için yazıya dayalı ve adım adım doğrulanır; bir adım tutmazsa
// hiçbir şey tıklanmadan tek tek yönteme dönülür.
const BULK_TABS = ['created', 'processing'];
/**
 * Tanı: panel sayfasının İSKELETİ (düğmeler, onay kutuları, test kimlikleri, sayfalama çevresi). Toplu yol ya da sayfa boyutu
 * gerçek panelde bulunamadığında bir kez kaydedilir; panel görünümü değiştiyse neyin değiştiğini görmek içindir.
 * Müşteri adı, adres, sipariş numarası gibi içerik ALINMAZ: yalnızca kısa düğme yazıları (rakamlar gizlenir) ve sınıf/kimlik adları.
 */
const PANEL_DIAG_SCRIPT = `(() => {
  const clean = (t) => String(t || '').replace(/\\s+/g, ' ').trim().replace(/\\d{4,}/g, '#').slice(0, 40);
  const cls = (e) => String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || '').slice(0, 90);
  const tid = (e) => String(e.getAttribute('data-testid') || '').replace(/\\d{3,}/g, '#');
  const vis = (e) => e.offsetParent !== null || e.getClientRects().length > 0;
  const testids = {};
  for (const e of document.querySelectorAll('[data-testid]')) { const k = tid(e); if (Object.keys(testids).length < 300 || testids[k]) testids[k] = (testids[k] || 0) + 1; }
  const ctl = [];
  for (const e of document.querySelectorAll('button,[role=button],input[type=checkbox],select,[role=combobox],[role=listbox],[role=menu],[role=menuitem],[role=tab],[role=option]')) {
    if (ctl.length >= 260) break;
    const row = { tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', type: e.getAttribute('type') || '', testid: tid(e), cls: cls(e), text: e.tagName === 'INPUT' ? '' : clean(e.textContent), aria: clean(e.getAttribute('aria-label')), vis: vis(e), dis: !!e.disabled };
    const key = row.tag + '|' + row.testid + '|' + row.cls + '|' + row.text;
    const same = ctl.find((x) => x.key === key);
    if (same) same.n++; else ctl.push({ ...row, key, n: 1 });
  }
  const near = [];
  for (const e of document.querySelectorAll('body *')) {
    if (near.length >= 90) break;
    if (e.children.length > 3) continue;
    const t = (e.textContent || '').trim();
    if (t.length < 60 && /Sayfada|Toplu|Seçili|Etiket|Barkod|Yazdır|Sayfa\\b/i.test(t)) near.push({ tag: e.tagName.toLowerCase(), cls: cls(e), testid: tid(e), text: clean(t), parent: e.parentElement ? e.parentElement.tagName.toLowerCase() + '.' + cls(e.parentElement).slice(0, 60) : '' });
  }
  return { path: location.pathname + location.search.replace(/\\d{5,}/g, '#'), rows: (document.body.innerText.match(/#\\s*\\d{8,}/g) || []).length, testids, ctl: ctl.map(({ key, ...x }) => x), near };
})()`;
function bulkUrl(base, tab) { return `${base}/orders/shipment-packages/${tab}?page=0`; }
const BULK_LIST_SCRIPT = `(() => {
  if (/\\/(login|giris|auth)/i.test(location.pathname) || document.querySelector('input[type="password"]')) return { state: 'login' };
  const btn = [...document.querySelectorAll('button')].find((b) => /Toplu\\s*İşlemler/i.test(b.textContent || '') && b.offsetParent !== null);
  const text = document.body ? document.body.innerText : '';
  const rows = (text.match(/#\\d{8,}/g) || []).length;
  if (!btn) return { state: rows ? 'nobulk' : 'wait' };
  if (!rows) return { state: /(sonuç|kayıt|sipariş|paket)[^.\\n]{0,20}bulunamadı/i.test(text) ? 'empty' : 'wait' };
  const size = (text.match(/Her\\s*Sayfada\\s*(\\d+)\\s*Ürün/i) || [])[1];
  return { state: 'ready', rows, size: size ? Number(size) : null };
})()`;
/** "Her Sayfada" seçimini 100'e çeker: önce açılır menüyü açar, sonra "100 Ürün" seçeneğine basar. */
function pageSizeScript(step) {
  return `(() => {
    const vis = (e) => e && e.offsetParent !== null;
    const sel = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => /^\\s*100\\s*Ürün/i.test(o.textContent)));
    if (sel) {
      const o = [...sel.options].find((o) => /^\\s*100\\s*Ürün/i.test(o.textContent));
      if (sel.value === o.value) return 'same';
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(sel, o.value);
      sel.dispatchEvent(new Event('change', { bubbles: true })); return 'set';
    }
    const leaf = (re) => [...document.querySelectorAll('body *')].filter((e) => vis(e) && e.children.length === 0 && re.test((e.textContent || '').trim()));
    if (${step === 'open'}) {
      const cur = leaf(/^(10|20|50|100)\\s*Ürün$/i)[0];
      if (!cur) return 'none';
      if (/^100/.test(cur.textContent.trim())) return 'same';
      (cur.closest('button,[role="button"],[role="combobox"],div') || cur).click(); return 'opened';
    }
    const opts = leaf(/^100\\s*Ürün$/i);
    const opt = opts[opts.length - 1];
    if (!opt) return 'none';
    (opt.closest('li,[role="option"],button') || opt).click(); return 'set';
  })()`;
}
/** Hedef siparişlerin satırlarındaki kutuları işaretler. Sayfa sırasıyla işaretlenenleri döndürür. */
function bulkSelectScript(nos) {
  return `(() => {
    const want = new Set(${JSON.stringify(nos)});
    const out = [];
    const all = [...document.querySelectorAll('body *')].filter((e) => e.children.length <= 2 && /^#?\\s*\\d{8,}$/.test((e.textContent || '').trim()));
    // Panelde sipariş numarası "#11799730181" biçiminde: "#"li olanlar varsa yalnızca onlar (paket/teslimat no karışmasın)
    const hashed = all.filter((e) => (e.textContent || '').trim().startsWith('#'));
    const cand = hashed.length ? hashed : all;
    const seen = new Set();
    const count = {};
    for (const e of cand) { const n = (e.textContent || '').replace(/\\D/g, ''); count[n] = (count[n] || 0) + 1; }
    for (const e of cand) {
      const no = (e.textContent || '').replace(/\\D/g, '');
      if (!want.has(no) || seen.has(no) || count[no] > 1) continue; // bölünmüş paket: tek tek yöntemde sorulur
      let row = e.parentElement, cb = null;
      for (let i = 0; i < 14 && row; i++, row = row.parentElement) {
        const boxes = row.querySelectorAll('input[type="checkbox"]');
        const nums = new Set(((row.innerText || '').match(/#\\s*\\d{8,}/g) || []).map((x) => x.replace(/\\D/g, '')));
        if (nums.size > 1) break;                         // başka siparişe taştı
        if (boxes.length === 1) { cb = boxes[0]; break; }
        if (boxes.length > 1) break;
      }
      if (!cb || cb.disabled) continue;
      seen.add(no);
      if (!cb.checked) { const l = cb.closest('label'); (l && !l.contains(e) ? l : cb).click(); }
      out.push({ no, top: e.getBoundingClientRect().top + window.scrollY });
    }
    out.sort((a, b) => a.top - b.top);
    return out.map((x) => x.no);
  })()`;
}
/** İşaretli kutuların hangi siparişlere ait olduğunu okur: satır kutuları → sipariş no; satıra ait olmayan işaretli kutu sayısı. */
const BULK_CHECKED_SCRIPT = `(() => {
  const rowNos = []; let other = 0;
  for (const c of document.querySelectorAll('input[type="checkbox"]')) {
    if (!c.checked) continue;
    let r = c.parentElement, no = null;
    for (let i = 0; i < 14 && r; i++, r = r.parentElement) {
      const n = new Set(((r.innerText || '').match(/#\\s*\\d{8,}/g) || []).map((x) => x.replace(/\\D/g, '')));
      if (n.size === 1) { no = [...n][0]; break; }
      if (n.size > 1) break;
    }
    if (no) rowNos.push(no); else other++;
  }
  return { rowNos, other };
})()`;
const BULK_OPEN_MENU = `(() => { const b = [...document.querySelectorAll('button')].find((b) => /Toplu\\s*İşlemler/i.test(b.textContent || '') && b.offsetParent !== null); if (!b || b.disabled) return false; b.click(); return true; })()`;
function bulkMenuScript(kind) {
  const re = kind === 'a4' ? '^A4\\s*Kargo\\s*Etiketi\\s*Yazdır$' : '^Sticker\\s*Kargo\\s*Etiketi\\s*Yazdır$';
  return `(() => {
    const re = new RegExp(${JSON.stringify(re)}, 'i');
    const el = [...document.querySelectorAll('body *')].filter((e) => e.offsetParent !== null && re.test((e.textContent || '').trim())).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (!el) return false;
    (el.closest('li,button,a,[role="menuitem"]') || el).click();
    return true;
  })()`;
}
/**
 * Yakalanan toplu etiket belgesini etiketlere böler: seçilen siparişlerin kimliklerinden (sipariş no / kargo no)
 * birini içeren kardeş öğeler etiket sayılır. Her parça, üst sarmalayıcılarının (sınıf/stil) kopyasıyla ayrı belge olur.
 * Eşleştirme burada YAPILMAZ (assignParts ile Node tarafında doğrulanır). Bölünemezse null.
 */
function bulkSplitScript(ids) {
  return `(() => {
    const f = window.__tspPrinted; const d = f && f.contentDocument;
    if (!d || !d.body) return null;
    const ids = new Set(${JSON.stringify(ids)});
    const txt = (el) => el.innerText || el.textContent || '';
    const has = (el) => (txt(el).match(/\\d{6,}/g) || []).some((x) => ids.has(x));
    const kids = (x) => [...x.children].filter((k) => !/^(STYLE|SCRIPT|LINK|META|TITLE)$/.test(k.tagName));
    let el = d.body;
    for (let i = 0; i < 14; i++) { const k = kids(el).filter(has); if (k.length === 1) el = k[0]; else break; }
    const parts = kids(el).filter(has);
    if (parts.length < 2) return null;
    const head = d.head ? d.head.outerHTML : '<head></head>';
    const bodyOpen = d.body.cloneNode(false).outerHTML.replace(/<\\/body>\\s*$/i, '');
    return parts.map((k) => {
      let html = k.outerHTML;
      for (let a = k.parentElement; a && a !== d.body; a = a.parentElement) { const c = a.cloneNode(false); c.innerHTML = html; html = c.outerHTML; }
      return { text: txt(k), html: '<!DOCTYPE html><html>' + head + bodyOpen + html + '</body></html>' };
    });
  })()`;
}

// ---------- Trendyol'da etiketi basılmış mı? (salt okuma; hiçbir düğmeye basılmaz) ----------
// Trendyol, etiketi basılan paketin "Kargo Etiketini Sticker/A4 Yazdır" düğmesini griye çevirir (basılmamış: turuncu).
function listAllUrl(base, page = 0) { return `${base}/orders/shipment-packages/all?page=${Number(page) || 0}`; }
const PANEL_LIST_READY = `(() => {
  if (/\\/(login|giris|auth)/i.test(location.pathname) || document.querySelector('input[type="password"]')) return { state: 'login' };
  const text = document.body ? document.body.innerText : '';
  const rows = (text.match(/#\\s*\\d{8,}/g) || []).length;
  const btns = document.querySelectorAll('button[data-testid^="shipment-packages-"][data-testid*="-add-on-print-"]').length;
  const size = (text.match(/Her\\s*Sayfada\\s*(\\d+)\\s*Ürün/i) || [])[1];
  if (rows && btns) return { state: 'ready', rows, btns, size: size ? Number(size) : null };
  if (/(sonuç|kayıt|sipariş|paket)[^.\\n]{0,20}bulunamadı/i.test(text)) return { state: 'empty' };
  return { state: rows ? 'nobtn' : 'wait', rows };
})()`;
const PANEL_PRINTED_SCRIPT = `(() => {
  const sat = (c) => { const m = String(c || '').match(/[\\d.]+/g); if (!m || m.length < 3) return null; const [r, g, b] = m.slice(0, 3).map(Number); if (m.length > 3 && Number(m[3]) === 0) return null; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
  const look = (b) => {
    if (!b) return null;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return 'disabled';
    const cs = getComputedStyle(b);
    const s = [sat(cs.color), sat(cs.borderTopColor), sat(cs.backgroundColor)].filter((x) => x != null);
    return s.some((x) => x > 0.35) ? 'color' : 'grey';
  };
  const out = {};
  for (const b of document.querySelectorAll('button[data-testid^="shipment-packages-"][data-testid$="-add-on-print-sticker-button"]')) {
    let r = b.parentElement, no = null;
    for (let i = 0; i < 16 && r; i++, r = r.parentElement) {
      const n = new Set(((r.innerText || '').match(/#\\s*\\d{8,}/g) || []).map((x) => x.replace(/\\D/g, '')));
      if (n.size === 1) { no = [...n][0]; break; }
      if (n.size > 1) break;
    }
    if (!no) continue;
    const a4 = r.querySelector('button[data-testid^="shipment-packages-"][data-testid$="-add-on-print-a4-button"]');
    const e = out[no] || (out[no] = { sticker: [], a4: [] });
    e.sticker.push(look(b)); e.a4.push(look(a4));
  }
  return out;
})()`;

/** Etiket iframe'inin görünen metni (doğrulama için). */
const TEXT_SCRIPT = `(() => { const f = window.__tspPrinted; const d = f && f.contentDocument; if (!d || !d.body) return ''; return d.body.innerText || d.body.textContent || ''; })()`;

class LabelPrinter {
  /**
   * @param {object} o
   * @param {object} o.electron  Electron modülü
   * @param {string} o.partition Panel oturumunun kalıcı bölümü
   * @param {string} [o.panelBase] Yalnızca geliştirici testi için yerel sahte panel adresi
   */
  constructor({ electron, partition, panelBase }) {
    this.electron = electron;
    this.partition = partition;
    this.panelBase = panelBase || PANEL_ORIGIN;
    this.busy = null;
  }

  async listPrinters() {
    const { BrowserWindow } = this.electron;
    const host = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    let win = host;
    let temp = null;
    if (!win) { temp = new BrowserWindow({ show: false }); win = temp; }
    try {
      const list = await win.webContents.getPrintersAsync();
      return list.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: !!(p.isDefault || (p.options && String(p.options['printer-is-default'] || p.options.isDefault || '') === 'true')),
      }));
    } finally {
      if (temp && !temp.isDestroyed()) temp.destroy();
    }
  }

  /**
   * @param {object} a
   * @param {string} a.orderNumber
   * @param {'a4'|'sticker'} a.kind
   * @param {'print'|'pdf'} a.output
   * @param {string} [a.printer]  Boşsa Windows yazdırma penceresi açılır
   * @returns {Promise<{status:'printed'|'pdf'|'fallback'|'cancelled', message:string, file?:string, reason?:string}>}
   */
  async print({ orderNumber, kind, output = 'print', printer = '', sticker = null, expect = null }) {
    const no = String(orderNumber || '');
    if (!/^\d{5,20}$/.test(no)) throw new Error('Geçersiz sipariş numarası');
    if (kind !== 'a4' && kind !== 'sticker') throw new Error('Geçersiz etiket türü');
    if (this.busy) throw new Error('Başka bir etiket hazırlanıyor, birkaç saniye sonra tekrar deneyin.');
    if (output === 'print' && printer) {
      // Yazıcı yoksa panelde hiçbir işlem yapmadan dur (aksi halde paket "yazdırıldı" işaretlenir ama kâğıt çıkmaz)
      const list = await this.listPrinters().catch(() => null);
      if (list && !list.some((p) => p.name === printer)) throw new Error(`Seçili yazıcı bulunamadı: "${printer}". Ayarlar › Kargo etiketi bölümünden yazıcıyı yeniden seçin.`);
    }
    this.busy = no;
    try {
      const html = await this.captureLabel(no, kind);
      if (html.fallback) return html;
      if (expect) {
        // Etiket bu siparişe mi ait? (etiketteki sipariş no / kargo no)
        const v = verifyLabel({ text: html.text, orderNumber: no, ids: expect.ids, others: expect.others });
        if (!v.ok) { const e = new Error(`Etiket doğrulanamadı: ${v.message}. Güvenlik için yazdırılmadı; panelden kontrol edin.`); e.code = 'VERIFY'; throw e; }
      }
      return await this.output(html.html, { no, kind, output, printer, sticker });
    } finally {
      this.busy = null;
    }
  }

  /**
   * Toplu sticker: etiketleri sırayla panelden alır (her biri Trendyol'da "etiket yazdırıldı" olarak işaretlenir),
   * her biri için önizleme görseli üretir. Yazdırma ayrı adımdır (printBatch) ve tek iş olarak gider.
   */
  async prepareBatch({ orderNumbers, kind = 'sticker', sticker = null, onProgress = () => {}, expect = null, others = [] }) {
    if (this.busy) throw new Error('Başka bir etiket hazırlanıyor, birkaç saniye sonra tekrar deneyin.');
    const all = [...new Set((orderNumbers || []).map(String))].filter((n) => /^\d{5,20}$/.test(n)).slice(0, 300);
    if (!all.length) throw new Error('Sipariş seçilmedi');
    // Bölünmüş paketler (aynı siparişin birden çok açık paketi) toplu yazdırılmaz: etiket hangi pakete ait ayırt edilemez
    const splitNos = new Set(all.filter((n) => expect && expect[n] && expect[n].split));
    const list = all.filter((n) => !splitNos.has(n));
    const idsByNo = {};
    for (const n of all) idsByNo[n] = (expect && expect[n] && expect[n].ids) || [];
    // Başka siparişlerin kimlikleri: listedekiler + bilinen tüm siparişler
    const otherIds = new Set(others || []);
    for (const n of all) for (const id of idsOf(n, idsByNo[n])) otherIds.add(id);
    const othersFor = (no) => { const own = new Set(idsOf(no, idsByNo[no])); return [...otherIds].filter((x) => !own.has(x)); };
    this.busy = 'toplu';
    this.batch = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), at: Date.now(), kind, items: new Map() };
    const batchId = this.batch.id;
    if (!list.length) {
      this.busy = null;
      return all.map((no) => ({ orderNumber: no, ok: false, batch: batchId, message: 'Sipariş birden çok pakete bölünmüş; etiketi panelden ilgili paketi seçerek yazdırın.' }));
    }
    const st = kind === 'a4' ? null : normalizeSticker(sticker);
    const results = new Array(list.length);
    const previews = [];
    let done = 0, stop = false, bulkNote = '';
    const T0 = Date.now();
    const timing = {};
    const wins = [];
    const addReady = (i, no, html, via, by) => {
      this.batch.items.set(no, html);
      results[i] = { orderNumber: no, ok: true, preview: null, via, verified: by, batch: batchId };
      // Önizleme görseli yakalamayla paralel çizilir
      previews.push(this.previewImage(html, st).then((p) => { results[i].preview = p; }).catch(() => {}));
    };
    // 1) Panelin kendi toplu yazdırması (tek işlem). 2) Kalanlar tek tek.
    // Tek etiket: liste önceden yüklendiyse oradan (sipariş sayfasını açmaktan hızlı); yoksa doğrudan sipariş sayfasından
    if ((list.length >= 2 || this.warmUsable()) && process.env.TSP_NO_BULK !== '1' && !(this.bulkOffUntil && Date.now() < this.bulkOffUntil)) {
      const tb = Date.now();
      try {
        const { got, note } = await this.captureBulk(list, kind, onProgress, { idsByNo, others: [...otherIds], timing, onlyWarm: list.length === 1 });
        bulkNote = note;
        list.forEach((no, i) => { if (got.has(no)) { const g = got.get(no); addReady(i, no, g.html, 'toplu', g.by); done++; } });
      } catch (e) {
        if (e.code === 'LOGIN') {
          this.busy = null;
          return all.map((no) => (splitNos.has(no)
            ? { orderNumber: no, ok: false, batch: batchId, split: true, message: 'Sipariş birden çok pakete bölünmüş; etiketi panelden ilgili paketi seçerek yazdırın.' }
            : { orderNumber: no, ok: false, batch: batchId, message: e.message, login: true }));
        }
        bulkNote = e.message;
      }
      timing.bulkMs = Date.now() - tb;
      onProgress({ done, total: list.length, current: null });
    }
    const queue = list.map((_, i) => i).filter((i) => !results[i]);
    const POOL = Math.min(4, queue.length);
    const ts = Date.now();
    const worker = async (w) => {
      while (!stop && queue.length) {
        const i = queue.shift();
        const no = list[i];
        onProgress({ done, total: list.length, current: no });
        try {
          const h = await this.captureLabel(no, kind, w);
          if (h.fallback) results[i] = { orderNumber: no, ok: false, message: h.message };
          else {
            // Etiket bu siparişe mi ait? Değilse kullanılmaz (karışma olmasın)
            const v = verifyLabel({ text: h.text, orderNumber: no, ids: idsByNo[no], others: othersFor(no) });
            if (v.ok) { addReady(i, no, h.html, 'tek', v.by); results[i].mark = h.mark; }
            else results[i] = { orderNumber: no, ok: false, verifyFailed: true, message: `Etiket doğrulanamadı: ${v.message}. Güvenlik için önizlemeye alınmadı.` };
          }
        } catch (e) {
          results[i] = { orderNumber: no, ok: false, message: e.message };
          if (e.code === 'LOGIN') { results[i].login = true; stop = true; }
        }
        done++;
        onProgress({ done, total: list.length, current: null });
      }
    };
    try {
      for (let k = 0; k < POOL; k++) wins.push(this.makeCaptureWindow());
      await Promise.all(wins.map((w, k) => sleep(k * 200).then(() => worker(w))));
      if (queue.length || wins.length) timing.singleMs = Date.now() - ts;
      const tp = Date.now();
      await Promise.all(previews);
      timing.previewWaitMs = Date.now() - tp;
      timing.totalMs = Date.now() - T0;
      timing.bulk = results.filter((r) => r && r.ok && r.via === 'toplu').length;
      timing.single = results.filter((r) => r && r.ok && r.via === 'tek').length;
      timing.markOk = results.filter((r) => r && r.ok && r.mark === 'ok').length;
      timing.markBad = results.filter((r) => r && r.ok && r.via === 'tek' && r.mark !== 'ok').map((r) => `${r.orderNumber}:${r.mark}`);
      const got = Array.from(results, (r, i) => ({ batch: batchId, ...(r || { orderNumber: list[i], ok: false, message: 'Giriş yapılmadığı için hazırlanmadı', login: true }) }));
      // Sonuçlar istenen sırada; bölünmüş paketler kendi yerinde "hazırlanmadı" olarak
      const byNo = new Map(got.map((r) => [r.orderNumber, r]));
      const out = all.map((no) => byNo.get(no) || { orderNumber: no, ok: false, batch: batchId, split: true, message: 'Sipariş birden çok pakete bölünmüş; etiketi panelden ilgili paketi seçerek yazdırın.' });
      if (bulkNote && out[0]) out[0].bulkNote = bulkNote;
      if (out[0]) out[0].timing = timing;
      onProgress({ done: list.length, total: list.length, current: null });
      return out;
    } finally {
      for (const w of wins) if (!w.isDestroyed()) { this.labelWins && this.labelWins.delete(w.webContents.id); w.destroy(); }
      this.closePreviewPool();
      this.busy = null;
    }
  }

  /**
   * Toplu yol: panelin kendi "Toplu İşlemler → Sticker Kargo Etiketi Yazdır" işlemini gizli pencerede yapar.
   * Sipariş listesi sayfa başına 100 gösterir; ilk sayfada bulunamayanlar ve herhangi bir adım tutmazsa
   * kalanlar tek tek yöntemle alınır. Döner: { got: Map(no → html), note }
   */
  async captureBulk(list, kind, onProgress, { idsByNo = {}, others = [], timing = {}, onlyWarm = false } = {}) {
    const got = new Map();
    let note = '';
    const t00 = Date.now(); const dbg = process.env.TSP_LABEL_DEBUG ? (...a) => fs.appendFileSync(process.env.TSP_LABEL_DEBUG, (Date.now() - t00) + 'ms ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n') : () => {};
    const first = this.bulkTab && BULK_TABS.includes(this.bulkTab) ? this.bulkTab : BULK_TABS[0];
    const tabs = [first, ...BULK_TABS.filter((t) => t !== first)];
    // Önceden yüklenmiş liste (pencere açılınca arka planda hazırlanır): varsa sayfa yüklemesi beklenmez
    let warm = this.takeWarm(first);
    let win = null;
    const run = (s) => win.webContents.executeJavaScript(s, true);
    const isLogin = () => /\/auth\/login|\/login(\?|$)/.test(win.webContents.getURL() || '');
    const drop = (w) => { if (w && !w.isDestroyed()) { this.labelWins && this.labelWins.delete(w.webContents.id); w.destroy(); } };
    let used = false;
    try {
      for (const tab of tabs) {
        const left = list.filter((n) => !got.has(n));
        if (!left.length) break;
        onProgress({ done: got.size, total: list.length, current: null, phase: 'toplu' });
        const tl = Date.now();
        let st = null;
        if (warm && tab === first) {
          // Tek etikette en çok 6 sn beklenir (yetişmezse sipariş sayfasından alınır; liste arkada yüklenmeye devam eder)
          const r = await Promise.race([warm.ready, sleep(onlyWarm ? 6000 : 30000).then(() => null)]);
          if (r && ['ready', 'empty', 'nobulk', 'login'].includes(r.state)) {
            win = warm.win;
            timing.warm = warm.readyAt && warm.readyAt <= tl ? 'hazırdı' : 'yükleniyordu';
            st = r;
            if (r.state === 'ready') {
              // Aranan siparişlerin hepsi listede yoksa ve liste 20 sn'den eskiyse (sonradan gelmiş olabilir) bir kez tazelenir
              const missing = await run(`(() => { const t = new Set((document.body.innerText.match(/#\\s*\\d{8,}/g) || []).map((x) => x.replace(/\\D/g, ''))); return ${JSON.stringify(left)}.filter((n) => !t.has(n)).length; })()`).catch(() => left.length);
              if (missing && !onlyWarm && Date.now() - warm.readyAt > 20000) { st = null; timing.warm += ', tazelendi'; }
            }
          } else {
            timing.warm = r ? 'kullanılamadı' : 'yetişmedi';
            if (!r) this.putBackWarm(warm); else drop(warm.win);
          }
          warm = null;
        }
        if (!st) {
          if (onlyWarm) break; // tek etiket: hazır liste yoksa doğrudan sipariş sayfasından
          if (!win) win = this.makeCaptureWindow();
          st = await this.openList(win, tab, { want: left });
        }
        timing.listMs = (timing.listMs || 0) + (Date.now() - tl);
        dbg('list', tab, st);
        if (st.state === 'login' || isLogin()) throw loginError();
        if (st.state !== 'ready') {
          if (st.state === 'empty') continue;
          if (st.state === 'failed') { note = st.note || 'Panel listesi açılamadı'; continue; }
          try { const d = await run(PANEL_DIAG_SCRIPT); if (d && this.onDiag) this.onDiag('bulk-' + tab, d); } catch (_) { /* tanı alınamazsa yoksay */ }
          note = 'Panelde toplu işlem düğmesi bulunamadı';
          this.bulkOffUntil = Date.now() + 10 * 60000; // 10 dk boyunca toplu yolu denemeden tek tek al (her seferinde beklemesin)
          break; // öbür sekmede de olmaz: beklemeden tek teke geç
        }
        await run(HOOK_SCRIPT).catch(() => {});
        const picked = await run(bulkSelectScript(left)).catch(() => []);
        dbg('picked', picked);
        if (!picked.length) { if (onlyWarm) break; continue; }
        used = true;
        await sleep(150);
        const chk = await run(BULK_CHECKED_SCRIPT).catch(() => null);
        // Güvenlik: işaretli satırlar TAM OLARAK seçilen siparişler değilse (fazla/eksik/başka kutu) hiçbir şey yazdırma
        const same = chk && chk.other === 0 && chk.rowNos.length === picked.length && [...chk.rowNos].sort().join() === [...picked].sort().join();
        dbg('checked', chk);
        if (!same) { note = 'Satır seçimi doğrulanamadı'; continue; }
        // Yazdırma kancası bu sayfada kurulu değilse menüye basma (gizli pencerede gerçek yazdırma penceresi açılırdı)
        if ((await run(HOOK_SCRIPT).catch(() => null)) !== 'ok' || !(await run('window.__tspHook === true').catch(() => false))) { note = 'Yazdırma kancası kurulamadı'; continue; }
        if (!(await run(BULK_OPEN_MENU).catch(() => false))) { note = 'Toplu İşlemler menüsü açılamadı'; continue; }
        let clicked = false;
        for (let i = 0; i < 20 && !clicked; i++) { await sleep(120); clicked = await run(bulkMenuScript(kind)).catch(() => false); }
        if (!clicked) { note = 'Menüde etiket yazdırma seçeneği bulunamadı'; continue; }
        onProgress({ done: got.size, total: list.length, current: `${picked.length} etiket`, phase: 'toplu' });
        const tg = Date.now();
        let res = { state: 'wait' };
        for (let i = 0; i < 500; i++) { // toplu etiket hazırlanması uzun sürebilir (en çok ~60 sn)
          await sleep(120);
          res = await run(RESULT_SCRIPT).catch(() => ({ state: 'wait' }));
          if (res.state !== 'wait') break;
        }
        timing.panelMs = (timing.panelMs || 0) + (Date.now() - tg);
        dbg('res', res);
        if (res.state !== 'printed') { note = 'Panel toplu etiketi hazırlamadı'; continue; }
        await sleep(120);
        const whole = await run(EXTRACT_SCRIPT);
        if (!whole || whole.length < 200) { note = 'Toplu etiket okunamadı'; continue; }
        dbg('whole', whole && whole.length);
        const ids = [...new Set(picked.flatMap((n) => idsOf(n, idsByNo[n])))];
        // Belgede seçilmeyen bir siparişin numarası varsa (Trendyol fazladan etiket verdiyse) toplu belge hiç kullanılmaz
        const wholeText = await run(TEXT_SCRIPT).catch(() => '');
        const idSet = new Set(ids);
        const stray = [...new Set(String(wholeText).match(/\d{6,}/g) || [])].filter((x) => !idSet.has(x) && others.includes(x));
        if (stray.length) { note = `Toplu belgede seçilmeyen sipariş numarası vardı (${stray[0]}); toplu belge siparişlerle birebir eşleşmedi, bu etiketler tek tek alındı`; dbg('stray', stray); continue; }
        let parts = await run(bulkSplitScript(ids)).catch(() => null);
        // Tek etiket seçildiyse belgenin tamamı o etikettir (yine numarasıyla doğrulanır)
        if (!parts && picked.length === 1) parts = [{ text: String(wholeText || ''), html: whole }];
        // Etiketler siparişlere YALNIZCA metinlerindeki numaralarla bağlanır; sıraya göre tahmin yapılmaz.
        // Eşleşme kanıtlanamazsa bu siparişler tek tek (her biri kendi sayfasından) alınır.
        const a = parts ? assignParts(parts, picked, idsByNo, others) : { ok: false, message: 'Toplu belge etiketlere ayrılamadı' };
        dbg('assign', a.ok ? 'ok' : a.message);
        if (a.ok) {
          a.map.forEach((no, i) => {
            const v = verifyLabel({ text: parts[i].text, orderNumber: no, ids: idsByNo[no], others: others.filter((x) => !idsOf(no, idsByNo[no]).includes(x)) });
            if (v.ok) got.set(no, { html: parts[i].html, by: v.by });
          });
          if (a.map.length) this.bulkTab = tab; // siparişlerin bulunduğu sekme: sonraki seferde önce o yüklenir
        } else {
          note = `Toplu belge siparişlerle birebir eşleşmedi (${a.message}); bu etiketler tek tek alındı`;
        }
        win.webContents.executeJavaScript('window.__tspPrinted = null', true).catch(() => {});
      }
      return { got, note };
    } finally {
      // Toplu sticker penceresi hâlâ açıksa liste sonraki parti için arka planda yeniden yüklenir
      // (seçimler ve yazdırma durumu sıfırlanır); kapalıysa gizli pencere bellekten atılır
      const keep = this.warmWanted && !(this.bulkOffUntil && Date.now() < this.bulkOffUntil);
      if (warm) { if (keep) this.putBackWarm(warm); else drop(warm.win); if (win === warm.win) win = null; } // hiç kullanılmadı
      if (win && !win.isDestroyed()) { if (keep) this.reloadWarm(win); else drop(win); }
    }
  }

  /**
   * Panelin paket listesini açar, toplu işlem düğmesini ve satırları bekler, "Her Sayfada 100 Ürün" seçer.
   * Hiçbir şeye basılmaz (yalnızca görünüm). Döner: { state: 'ready'|'empty'|'nobulk'|'wait'|'login'|'failed', rows, size }
   * want: aranan siparişler; hepsi zaten görünüyorsa sayfa boyutu değiştirilmez.
   */
  async openList(win, tab, { want = null } = {}) {
    const run = (s) => win.webContents.executeJavaScript(s, true);
    const isLogin = () => /\/auth\/login|\/login(\?|$)/.test(win.webContents.getURL() || '');
    try {
      await Promise.race([win.loadURL(bulkUrl(this.panelBase, tab)), sleep(45000).then(() => { throw new Error('zaman aşımı'); })]);
    } catch (e) {
      await sleep(300);
      if (isLogin() || /auth\/login/.test(String(e.message))) return { state: 'login' };
      if (!/ERR_ABORTED/.test(String(e.message))) return { state: 'failed', note: 'Panel listesi açılamadı' };
    }
    if (isLogin()) return { state: 'login' };
    await run(HOOK_SCRIPT).catch(() => {});
    let st = { state: 'wait' };
    for (let i = 0; i < 100; i++) { // en çok ~12 sn
      await sleep(120);
      await run(HOOK_SCRIPT).catch(() => {});
      st = await run(BULK_LIST_SCRIPT).catch(() => ({ state: 'wait' }));
      if (st.state === 'login' || isLogin()) return { state: 'login' };
      if (st.state === 'ready' || st.state === 'empty') break;
      if ((st.state === 'nobulk' || st.state === 'wait') && i >= 50) break; // ~6 sn: liste/toplu düğme yok
    }
    if (st.state !== 'ready') return st;
    const allVisible = want ? await run(`(() => { const t = new Set((document.body.innerText.match(/#\\s*\\d{8,}/g) || []).map((x) => x.replace(/\\D/g, ''))); return ${JSON.stringify(want)}.every((n) => t.has(n)); })()`).catch(() => false) : false;
    if (st.size !== 100 && !allVisible) {
      const a = await run(pageSizeScript('open')).catch(() => 'none');
      if (a === 'opened') { await sleep(120); await run(pageSizeScript('pick')).catch(() => {}); }
      if (a === 'opened' || a === 'set') {
        // Liste 100'e geçip satır sayısı iki ölçümde aynı kalana kadar bekle
        let last = -1;
        for (let i = 0; i < 90; i++) {
          await sleep(120); await run(HOOK_SCRIPT).catch(() => {});
          st = await run(BULK_LIST_SCRIPT).catch(() => ({ state: 'wait' }));
          if (st.state === 'ready' && st.size === 100 && st.rows === last) break;
          last = st.state === 'ready' && st.size === 100 ? st.rows : -1;
        }
      }
    }
    await run(HOOK_SCRIPT).catch(() => {});
    return st;
  }

  // ---------- Önceden yükleme: toplu sticker penceresi açıkken panel listesi arka planda hazır bekler ----------
  // Yalnızca liste açılır ve "Her Sayfada 100 Ürün" seçilir; hiçbir pakete/düğmeye basılmaz.
  // Pencere kapanınca (releaseWarm) ya da 5 dk kullanılmazsa bellekten atılır.
  warmBulk() {
    if (process.env.TSP_NO_BULK === '1' || (this.bulkOffUntil && Date.now() < this.bulkOffUntil)) return Promise.resolve({ state: 'off' });
    this.warmWanted = Date.now();
    this.armWarmTimer();
    const w = this.warm;
    if (w && !w.win.isDestroyed() && (w.state === 'loading' || (w.state === 'ready' && Date.now() - w.readyAt < 4 * 60000))) return w.ready;
    return this.reloadWarm(w && !w.win.isDestroyed() ? w.win : null);
  }
  reloadWarm(win = null) {
    const tab = this.bulkTab && BULK_TABS.includes(this.bulkTab) ? this.bulkTab : BULK_TABS[0];
    const old = this.warm;
    if (old && old.win !== win && !old.win.isDestroyed()) { this.labelWins && this.labelWins.delete(old.win.webContents.id); old.win.destroy(); }
    const w = win && !win.isDestroyed() ? win : this.makeCaptureWindow();
    const slot = { win: w, tab, state: 'loading', at: Date.now(), readyAt: 0 };
    slot.ready = this.openList(w, tab).then((st) => { slot.state = st.state === 'ready' ? 'ready' : 'failed'; slot.readyAt = Date.now(); return st; }, (e) => { slot.state = 'failed'; return { state: 'failed', note: e.message }; });
    this.warm = slot;
    this.armWarmTimer();
    return slot.ready;
  }
  /** Önceden yüklenmiş liste bu sekme için kullanılabilir mi? (yükleniyorsa da verilir; kullanan bekler) */
  takeWarm(tab) {
    const s = this.warm;
    if (!s || s.win.isDestroyed() || s.tab !== tab) return null;
    if (s.state === 'failed' || (s.state === 'ready' && Date.now() - s.readyAt > 4 * 60000)) return null;
    this.warm = null;
    return s;
  }
  putBackWarm(s) { if (!this.warm && s && !s.win.isDestroyed()) this.warm = s; else if (s && s.win && !s.win.isDestroyed() && this.warm !== s) { this.labelWins && this.labelWins.delete(s.win.webContents.id); s.win.destroy(); } }
  warmUsable() { const s = this.warm; return !!(s && !s.win.isDestroyed() && (s.state === 'loading' || (s.state === 'ready' && Date.now() - s.readyAt < 4 * 60000))); }
  armWarmTimer() { clearTimeout(this.warmTimer); this.warmTimer = setTimeout(() => this.releaseWarm(), 5 * 60000); if (this.warmTimer.unref) this.warmTimer.unref(); }
  releaseWarm() {
    this.warmWanted = 0;
    clearTimeout(this.warmTimer);
    const s = this.warm; this.warm = null;
    if (s && s.win && !s.win.isDestroyed()) { this.labelWins && this.labelWins.delete(s.win.webContents.id); s.win.destroy(); }
  }

  /** Etiketi yazdırma ayarlarıyla (kağıt, ölçek, kenar boşlukları) küçük bir görsel olarak çizer. */
  async previewImage(html, st) {
    const { BrowserWindow } = this.electron;
    const pxPerMm = 96 / 25.4;
    const W = st ? Math.round((st.landscape ? st.h : st.w) * pxPerMm) : 794;
    const H = st ? Math.round((st.landscape ? st.w : st.h) * pxPerMm) : 1123;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-onizleme-'));
    const file = path.join(tmp, 'e.html');
    const zoom = st ? st.scale / 100 : 1;
    const pad = st ? `${st.mt}mm ${st.mr}mm ${st.mb}mm ${st.ml}mm` : '0';
    fs.writeFileSync(file, utf8Html(html).replace(/<\/head>/i, `<style>html{background:#fff;padding:${pad}!important;margin:0!important;box-sizing:border-box;width:${W}px;height:${H}px;overflow:hidden}body{margin:0!important;zoom:${zoom}}</style></head>`), 'utf8');
    // Çizim pencereleri yeniden kullanılır (en çok 4 tane aynı anda): her etiket için pencere açıp kapatmaktan çok daha hızlı
    const pool = this.pvPool || (this.pvPool = { idle: [], count: 0, waiters: [] });
    const take = () => {
      const i = pool.idle.findIndex((w) => !w.isDestroyed() && w.__wh === `${W}x${H}`);
      if (i >= 0) return Promise.resolve(pool.idle.splice(i, 1)[0]);
      if (pool.count < 4) {
        pool.count++;
        const w = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'tsp-etiket-cizim', backgroundThrottling: false } });
        w.webContents.on('will-navigate', (e) => e.preventDefault());
        w.__wh = `${W}x${H}`;
        // Önizleme baskı kurallarıyla (@media print) çizilir; Trendyol etiketinin yalnızca yazdırırken geçerli stilleri var
        try { w.webContents.debugger.attach('1.3'); w.__dbg = true; } catch (_) { w.__dbg = false; }
        w.on('closed', () => { pool.count--; });
        return Promise.resolve(w);
      }
      return new Promise((r) => pool.waiters.push(r)).then(take);
    };
    const give = (w) => { if (!w.isDestroyed()) pool.idle.push(w); const n = pool.waiters.shift(); if (n) n(); };
    const win = await take();
    try {
      await win.loadFile(file);
      if (win.__dbg) await Promise.race([win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' }).catch(() => {}), sleep(1500)]);
      await sleep(90); // görseller yüklendi (javascript kapalı, load olayı resimleri bekler); bir kare çizilsin
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
      return img.resize({ width: Math.min(W, 360), quality: 'good' }).toDataURL();
    } finally {
      give(win);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* yoksay */ }
    }
  }

  /** Hazırlanan etiketlerin önizlemesini yeni sticker ayarlarıyla yeniden çizer (panelden tekrar alınmaz). */
  async repreview({ sticker }) {
    if (!this.batch || Date.now() - this.batch.at > 60 * 60000) throw new Error('Önce önizlemeyi hazırlayın (hazırlanan etiketlerin süresi doldu).');
    const st = this.batch.kind === 'a4' ? null : normalizeSticker(sticker);
    const out = {};
    try {
      await Promise.all([...this.batch.items].filter(([, h]) => h).map(([no, h]) => this.previewImage(h, st).then((p) => { out[no] = p; }).catch(() => {})));
    } finally { this.closePreviewPool(); }
    return out;
  }

  /**
   * Trendyol panelindeki sipariş listesini gizli pencerede açıp her paketin etiketinin basılıp basılmadığını OKUR.
   * Hiçbir düğmeye basılmaz (yalnızca "Her Sayfada 100 Ürün" görünümü seçilir). İlk 100 sipariş okunur.
   * Döner: { at, rows: { siparişNo: { sticker: bool|null, a4: bool|null, raw } }, read, note }
   */
  async readPanelPrinted({ want = [], parallel = 1 } = {}) {
    if (this.busy) return { busy: true, rows: {}, note: 'Etiket hazırlanırken okunmadı' };
    const win = this.makeCaptureWindow();
    const run = (s) => win.webContents.executeJavaScript(s, true);
    const isLogin = () => /\/auth\/login|\/login(\?|$)/.test(win.webContents.getURL() || '');
    try {
      try {
        await Promise.race([win.loadURL(listAllUrl(this.panelBase)), sleep(45000).then(() => { throw new Error('zaman aşımı'); })]);
      } catch (e) {
        await sleep(300);
        if (isLogin() || /auth\/login/.test(String(e.message))) return { login: true, rows: {}, note: 'Satıcı paneli oturumu kapalı' };
        if (!/ERR_ABORTED/.test(String(e.message))) return { rows: {}, note: 'Panel listesi açılamadı' };
      }
      if (isLogin()) return { login: true, rows: {}, note: 'Satıcı paneli oturumu kapalı' };
      await run(HOOK_SCRIPT).catch(() => {}); // güvenlik: yanlışlıkla yazdırma penceresi açılmasın
      let st = { state: 'wait' };
      for (let i = 0; i < 60; i++) {
        await sleep(i === 0 ? 300 : 200);
        st = await run(PANEL_LIST_READY).catch(() => ({ state: 'wait' }));
        if (st.state === 'login' || isLogin()) return { login: true, rows: {}, note: 'Satıcı paneli oturumu kapalı' };
        if (st.state === 'ready' || st.state === 'empty') break;
      }
      if (st.state !== 'ready') return { rows: {}, note: st.state === 'empty' ? 'Panelde sipariş yok' : 'Panel listesi okunamadı' };
      if (st.size && st.size !== 100) {
        const a = await run(pageSizeScript('open')).catch(() => 'none');
        if (a === 'opened') { await sleep(150); await run(pageSizeScript('pick')).catch(() => {}); }
        if (a === 'opened' || a === 'set') {
          let last = -1;
          for (let i = 0; i < 70; i++) {
            await sleep(150);
            st = await run(PANEL_LIST_READY).catch(() => ({ state: 'wait' }));
            if (st.state === 'ready' && st.size === 100 && st.rows === last) break;
            last = st.state === 'ready' && st.size === 100 ? st.rows : -1;
          }
        }
      }
      if (!(st.size === 100) && this.onDiag && !this.diagAllDone) { this.diagAllDone = true; try { const d = await run(PANEL_DIAG_SCRIPT); if (d) this.onDiag('all', d); } catch (_) { /* yoksay */ } }
      const raw = await run(PANEL_PRINTED_SCRIPT).catch(() => ({}));
      // Sayfa başına 100'e geçilemediyse (panel görünümü değişmiş olabilir) sonraki sayfalar adresle açılıp okunur:
      // aranan (açık) siparişlerin hepsi görülünce, yeni sipariş gelmeyince ya da 8 sayfada durur. Yine yalnızca okuma.
      let pages = 1;
      const need = new Set((want || []).map(String));
      const missing = () => [...need].some((n) => !raw[n]);
      const perPage = Math.max(1, Object.keys(raw || {}).length);
      // Bir sayfayı verilen pencerede açıp okur; okunamazsa null
      const readPage = async (w, pg) => {
        const runW = (x) => w.webContents.executeJavaScript(x, true);
        const loginW = () => /\/auth\/login|\/login(\?|$)/.test(w.webContents.getURL() || '');
        try { await Promise.race([w.loadURL(listAllUrl(this.panelBase, pg)), sleep(30000).then(() => { throw new Error('zaman aşımı'); })]); } catch (e) { if (loginW() || !/ERR_ABORTED/.test(String(e.message))) return null; }
        if (loginW()) return null;
        await runW(HOOK_SCRIPT).catch(() => {});
        let s2 = { state: 'wait' };
        for (let i = 0; i < 60; i++) {
          await sleep(i === 0 ? 200 : 120);
          s2 = await runW(PANEL_LIST_READY).catch(() => ({ state: 'wait' }));
          if (s2.state === 'ready' || s2.state === 'empty' || s2.state === 'login') break;
        }
        if (s2.state !== 'ready') return null;
        return runW(PANEL_PRINTED_SCRIPT).catch(() => null);
      };
      const merge = (more) => { let fresh = 0; for (const [no, e] of Object.entries(more || {})) if (!raw[no]) { raw[no] = e; fresh++; } return fresh; };
      if (!(st.size === 100) && need.size && missing()) {
        // Gereken sayfalar okunur, eksik kalırsa sırayla devam edilir; toplam en çok 8 sayfa
        // Her gizli panel penceresi yüzlerce MB bellek tutar: arka plan okumasında tek pencere (sayfalar sırayla),
        // yalnızca kullanıcı beklerken (sticker penceresi) en çok 2 pencere aynı anda
        const guess = Math.min(Math.max(1, Math.min(2, Number(parallel) || 1)), Math.max(1, Math.ceil(need.size / perPage)));
        const extra = [];
        try {
          for (let k = 1; k < guess; k++) extra.push(this.makeCaptureWindow());
          const got = await Promise.all([readPage(win, 1), ...extra.map((w, k) => sleep((k + 1) * 150).then(() => readPage(w, k + 2)))]);
          let stopAt = false;
          got.forEach((g) => { if (!g || !merge(g)) stopAt = true; else pages++; });
          for (let pg = guess + 1; pg < 8 && !stopAt && missing(); pg++) {
            const g = await readPage(win, pg);
            if (!g || !merge(g)) break; // boş ya da aynı sayfa: bitti
            pages++;
          }
        } finally {
          for (const w of extra) if (!w.isDestroyed()) { this.labelWins && this.labelWins.delete(w.webContents.id); w.destroy(); }
        }
      }
      const printed = (arr) => { const v = (arr || []).filter(Boolean); return !v.length ? null : v.every((x) => x !== 'color'); };
      const rows = {};
      for (const [no, e] of Object.entries(raw || {})) rows[no] = { sticker: printed(e.sticker), a4: printed(e.a4), raw: e };
      // Güvenlik: listedeki bütün düğmeler griyse (renk okunamıyor olabilir) "basılmış" sayılmaz — yanlış uyarı, basılmamış siparişi listeden çıkarttırabilir
      const vals = Object.values(rows);
      if (vals.length >= 5 && vals.every((r) => r.sticker !== false && r.a4 !== false)) return { at: Date.now(), rows: {}, read: vals.length, note: 'Basılma durumu güvenilir okunamadı (bütün düğmeler gri görünüyor)' };
      return { at: Date.now(), rows, read: vals.length, pages, note: '' };
    } finally {
      if (!win.isDestroyed()) { this.labelWins && this.labelWins.delete(win.webContents.id); win.destroy(); }
    }
  }

  /** Süren yazdırmayı bırakır (Windows yazdırma penceresi kaybolduysa). */
  cancelPrint() {
    const f = this.cancelPrintFn;
    this.cancelPrintFn = null;
    if (f) f();
    return !!f;
  }

  /** Boşta kalan önizleme pencerelerini kapatır. */
  closePreviewPool() {
    const pool = this.pvPool;
    if (!pool) return;
    for (const w of pool.idle.splice(0)) if (!w.isDestroyed()) w.destroy();
  }


  /**
   * Hazırlanan etiketleri tek belge hâlinde, her etiket ayrı sayfada ve verilen sırayla tek seferde yazdırır.
   * Etiketlerin hepsi aynı Trendyol şablonundan geldiği için ilk etiketin stilleri hepsine uygulanır.
   */
  async printBatch({ orderNumbers, output = 'print', printer = '', sticker = null, batch = null }) {
    if (!this.batch || Date.now() - this.batch.at > 60 * 60000) throw new Error('Önce önizlemeyi hazırlayın (hazırlanan etiketlerin süresi doldu).');
    // Ekrandaki önizleme ile bellekteki etiketler aynı hazırlıktan mı? Değilse yazdırma (eski ekrandan basılmasın)
    if (batch && batch !== this.batch.id) throw new Error('Önizleme güncel değil: etiketler yeniden hazırlanmış. "Seçime dön" deyip önizlemeyi tekrar hazırlayın.');
    const asked = [...new Set((orderNumbers || []).map(String))];
    const missing = asked.filter((n) => !this.batch.items.get(n));
    if (missing.length) throw new Error(`Önizleme güncel değil: ${missing.slice(0, 3).join(', ')} için hazır etiket yok. Önizlemeyi tekrar hazırlayın.`);
    const list = asked;
    const docs = list.map((n) => this.batch.items.get(n));
    if (!list.length) throw new Error('Yazdırılacak hazır etiket yok');
    if (output === 'print' && printer) {
      const pl = await this.listPrinters().catch(() => null);
      if (pl && !pl.some((p) => p.name === printer)) throw new Error(`Seçili yazıcı bulunamadı: "${printer}". Ayarlar › Kargo etiketi bölümünden yazıcıyı yeniden seçin.`);
    }
    const html = combineLabels(docs);
    const r = await this.output(html, { no: `toplu-${list.length}`, kind: this.batch.kind, output, printer, sticker });
    return { ...r, count: list.length, message: (r.status === 'printed' ? `${list.length} etiket tek seferde yazıcıya gönderildi. ` : '') + (r.message || '') };
  }

  makeCaptureWindow() {
    const { BrowserWindow } = this.electron;
    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { partition: this.partition, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.setAudioMuted(true);
    this.blockTrackers(win);
    return win;
  }

  /** Etiket pencerelerinde yalnızca reklam/izleme betiklerini engeller (sayfa daha hızlı açılır; panel işlevi etkilenmez). */
  blockTrackers(win) {
    this.labelWins = this.labelWins || new Set();
    this.labelWins.add(win.webContents.id);
    const ses = win.webContents.session;
    if (this.trackerHooked === ses) return;
    this.trackerHooked = ses;
    const BLOCK = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|hotjar\.com|hotjar\.io|clarity\.ms|facebook\.net|connect\.facebook\.com|segment\.io|mixpanel\.com|newrelic\.com|nr-data\.net|bugsnag\.com|fullstory\.com|insider\.com|useinsider\.com|criteo\.com|tiktok\.com|yandex\.ru)$/i;
    // Panelin "etiket yazdırıldı" işareti (prints/sticker | prints/paper isteği) pencere bazında izlenir:
    // istek bitmeden pencere başka sayfaya geçerse işaret Trendyol'a ulaşmaz (etiket basılır ama panelde basılmamış görünür)
    this.markReq = this.markReq || new Map();
    const isMark = (d) => /\/prints\/(paper|sticker)(\b|$)/i.test(d.url) && !/^(GET|OPTIONS|HEAD)$/i.test(d.method || '');
    const markOf = (id) => { let m = this.markReq.get(id); if (!m) { m = { started: 0, ok: 0, fail: 0 }; this.markReq.set(id, m); } return m; };
    const markEnd = (d, good) => { if (this.labelWins.has(d.webContentsId) && isMark(d)) markOf(d.webContentsId)[good ? 'ok' : 'fail']++; };
    ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (d) => markEnd(d, d.statusCode >= 200 && d.statusCode < 300));
    ses.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (d) => markEnd(d, false));
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => {
      if (!this.labelWins.has(d.webContentsId)) return cb({});
      if (isMark(d)) markOf(d.webContentsId).started++;
      let host = '';
      try { host = new URL(d.url).hostname; } catch (_) { /* yoksay */ }
      // Liste sayfasındaki ürün fotoğrafları (Trendyol CDN) etiket için gerekmez: yüklenmez, sayfa daha hızlı hazırlanır
      cb({ cancel: BLOCK.test(host) || (d.resourceType === 'image' && /(^|\.)dsmcdn\.com$/i.test(host)) });
    });
  }

  /** Pencerenin "yazdırıldı" işareti sayaçlarının anlık kopyası. */
  markSnap(win) { const m = (this.markReq && this.markReq.get(win.webContents.id)) || { started: 0, ok: 0, fail: 0 }; return { ...m }; }

  /**
   * Etiket alındıktan sonra panelin "yazdırıldı" isteğinin Trendyol'a ulaşmasını bekler (pencere bu sırada başka sayfaya geçmez).
   * Döner: 'ok' (onaylandı) | 'fail' (istek hata verdi) | 'slow' (başladı, 6 sn'de bitmedi) | 'none' (1,5 sn içinde hiç istek görülmedi)
   */
  async waitMark(win, before) {
    const cur = () => this.markSnap(win);
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      const c = cur();
      if (c.ok > before.ok) return 'ok';
      if (c.started > before.started) break;
      await sleep(40);
    }
    if (!(cur().started > before.started)) return cur().ok > before.ok ? 'ok' : 'none';
    while (Date.now() - t0 < 6000) {
      const c = cur();
      if (c.ok > before.ok) return 'ok';
      if (c.fail > before.fail && c.ok + c.fail >= c.started) return 'fail';
      await sleep(40);
    }
    return 'slow';
  }

  async captureLabel(no, kind, reuse) {
    const win = reuse || this.makeCaptureWindow();
    const run = (s) => win.webContents.executeJavaScript(s, true);
    try {
      // Oturum kapalıysa panel giriş sayfasına yönlendirir; bu durumda yükleme "ERR_ABORTED" ile biter
      const isLogin = () => /\/auth\/login|\/login(\?|$)/.test(win.webContents.getURL() || '');
      try {
        await Promise.race([
          win.loadURL(orderUrl(this.panelBase, no)),
          sleep(45000).then(() => { throw new Error('Satıcı paneli 45 saniyede yüklenemedi.'); }),
        ]);
      } catch (e) {
        await sleep(300);
        if (isLogin() || /auth\/login/.test(String(e.message))) throw loginError();
        if (/ERR_ABORTED/.test(String(e.message))) { await sleep(1500); if (isLogin()) throw loginError(); }
        else throw e;
      }
      if (isLogin()) throw loginError();
      await run(HOOK_SCRIPT);

      // Sipariş satırı ve düğme gelene kadar bekle
      let found = { state: 'wait' };
      for (let i = 0; i < 200; i++) { // en çok ~25 sn
        await sleep(120);
        await run(HOOK_SCRIPT).catch(() => {});
        found = await run(findScript(kind, no)).catch(() => ({ state: 'wait' }));
        if (found.state === 'login' || isLogin()) throw loginError();
        if (found.state === 'ready' || found.state === 'multi' || found.state === 'disabled' || found.state === 'empty') break;
        if (found.state === 'nobutton' && i >= 40) break; // satır geldi ama düğme yok (~5 sn)
      }
      const typeName = kind === 'a4' ? 'A4' : 'sticker';
      if (found.state === 'empty') throw new Error(`Sipariş ${no} panelde bulunamadı.`);
      if (found.state === 'nobutton') throw new Error(`Bu sipariş için panelde "${typeName}" etiket düğmesi yok. Kargoya verilmiş, iptal edilmiş veya bu kargo modelinde etiket desteklenmiyor olabilir.`);
      if (found.state === 'disabled') throw new Error('Panel bu sipariş için etiket yazdırmaya şu an izin vermiyor (düğme pasif; etiketi daha önce basılmış olabilir).');
      if (found.state === 'multi') return { fallback: true, status: 'fallback', reason: 'multi', message: `Sipariş birden çok pakete bölünmüş (${found.count}). Panel açıldı; yazdırmak istediğiniz paketi seçin.` };
      if (found.state !== 'ready') throw new Error('Panel sayfası beklenen sürede hazır olmadı; tekrar deneyin.');

      const markBefore = this.markSnap(win);
      const clicked = await run(clickScript(kind));
      if (!clicked) throw new Error('Etiket düğmesine ulaşılamadı.');

      let res = { state: 'wait' };
      for (let i = 0; i < 125; i++) { // en çok ~15 sn
        await sleep(120);
        res = await run(RESULT_SCRIPT).catch(() => ({ state: 'wait' }));
        if (res.state !== 'wait') break;
      }
      if (res.state === 'options') return { fallback: true, status: 'fallback', reason: 'options', message: 'Panel A4 etiket seçeneğini (ürün bilgili / bilgisiz) soruyor. Bu tercih bir kez panelde yapılmalı; panel açıldı.' };
      if (res.state === 'top') return { fallback: true, status: 'fallback', reason: 'layout', message: 'Panelin yazdırma yöntemi değişmiş görünüyor; güvenli olması için panel açıldı.' };
      if (res.state !== 'printed') return { fallback: true, status: 'fallback', reason: 'timeout', message: 'Panel etiketi hazırlamadı (ör. desi/koli bilgisi isteniyor olabilir). Panel açıldı; uyarıyı orada görebilirsiniz.' };

      await sleep(150); // görseller otursun
      const html = await run(EXTRACT_SCRIPT);
      if (!html || html.length < 200) throw new Error('Etiket içeriği okunamadı.');
      const text = await run(TEXT_SCRIPT).catch(() => '');
      // Pencere bir sonraki siparişe geçmeden/kapanmadan önce "yazdırıldı" işaretinin Trendyol'a ulaştığından emin ol
      const mark = process.env.TSP_NO_MARK_WAIT === '1' ? 'atlandı' : await this.waitMark(win, markBefore); // (değişken yalnızca geliştirici denemesi için)
      return { html, text: String(text || ''), mark };
    } finally {
      if (!reuse && !win.isDestroyed()) { this.labelWins && this.labelWins.delete(win.webContents.id); win.destroy(); }
    }
  }

  async output(html, { no, kind, output, printer, sticker }) {
    const st = kind === 'a4' ? null : normalizeSticker(sticker);
    const { BrowserWindow, app, shell } = this.electron;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-etiket-'));
    const file = path.join(tmpDir, 'etiket.html');
    // Ölçek yazıcıya bırakılmaz (Windows yazdırmasında "ölçek" bazen yok sayılıp etiket büyük çıkıyor):
    // küçültme belgenin içine işlenir, önizlemede görülen birebir basılır.
    fs.writeFileSync(file, st ? stickerHtml(utf8Html(html), st) : utf8Html(html), 'utf8');
    const win = new BrowserWindow({
      show: false, width: 900, height: 1200,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'tsp-etiket-cizim' },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    try {
      await win.loadFile(file);
      await sleep(500);
      const typeName = kind === 'a4' ? 'A4' : 'Sticker';
      if (output === 'pdf') {
        const pdf = await win.webContents.printToPDF(st ? {
          printBackground: st.background, landscape: st.landscape, scale: 1,
          pageSize: { width: st.w / 25.4, height: st.h / 25.4 },
          margins: { top: st.mt / 25.4, bottom: st.mb / 25.4, left: st.ml / 25.4, right: st.mr / 25.4 },
        } : { printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' }, pageSize: 'A4' });
        const dir = path.join(app.getPath('downloads'), 'Trendyol Etiketleri');
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, `etiket-${no}-${kind}.pdf`);
        fs.writeFileSync(out, pdf);
        if (process.env.TSP_LABEL_NO_OPEN !== '1') shell.openPath(out).catch(() => {});
        return { status: 'pdf', file: out, message: `${typeName} etiket PDF olarak kaydedildi.` };
      }
      const px = (mm) => Math.round((mm * 96) / 25.4);
      const opts = st ? {
        silent: !!printer, printBackground: st.background, landscape: st.landscape, scaleFactor: 100, pagesPerSheet: 1, copies: 1,
        pageSize: { width: Math.round(st.w * 1000), height: Math.round(st.h * 1000) }, // mikron
        margins: { marginType: 'custom', top: px(st.mt), bottom: px(st.mb), left: px(st.ml), right: px(st.mr) },
      } : { silent: !!printer, printBackground: true, margins: { marginType: 'none' } };
      if (printer) opts.deviceName = printer;
      // İptal edilebilir: Windows penceresi kaybolursa/takılırsa uygulama "Yazdırılıyor"da kalmasın
      const r = await new Promise((resolve) => {
        this.cancelPrintFn = () => resolve({ ok: false, reason: 'cancelled' });
        win.webContents.print(opts, (ok, reason) => resolve({ ok, reason }));
      });
      this.cancelPrintFn = null;
      if (r.ok) return { status: 'printed', message: printer ? `${typeName} etiket "${printer}" yazıcısına gönderildi.` : `${typeName} etiket yazdırıldı.` };
      if (/cancel/i.test(String(r.reason || ''))) return { status: 'cancelled', message: 'Yazdırma iptal edildi. (Panelde paket yine de "etiket yazdırıldı" olarak işaretlenmiş olabilir.)' };
      throw new Error('Yazıcı hatası: ' + (r.reason || 'bilinmiyor'));
    } finally {
      if (!win.isDestroyed()) win.destroy();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* yoksay */ }
    }
  }
}

/** Etiket belgesine UTF-8 bildirimi ekler; yoksa Windows dosyayı Türkçe kod sayfasıyla okur ve ş/ğ/ı bozulur. */
function utf8Html(html) {
  let h = String(html || '').replace(/<meta[^>]+charset[^>]*>/gi, '');
  if (!/<head[^>]*>/i.test(h)) h = h.replace(/<html[^>]*>/i, (m) => m + '<head></head>');
  if (!/<head[^>]*>/i.test(h)) h = '<head></head>' + h;
  return '\uFEFF' + h.replace(/<head[^>]*>/i, (m) => m + '<meta charset="utf-8">');
}

/** Sticker ayarlarını belgeye işler: kâğıt boyu ve kenar boşlukları @page ile, ölçek gövdeye zoom ile. */
function stickerHtml(html, st) {
  const W = st.landscape ? st.h : st.w, H = st.landscape ? st.w : st.h;
  const css = `<style>@page{size:${W}mm ${H}mm;margin:${st.mt}mm ${st.mr}mm ${st.mb}mm ${st.ml}mm}html,body{margin:0!important;padding:0!important}body{zoom:${st.scale / 100}}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, css + '</head>') : css + html;
}

function loginError() {
  const e = new Error('Satıcı paneli oturumu kapalı. "Satıcı paneline giriş yap" deyip açılan pencerede giriş yapın, sonra tekrar deneyin.');
  e.code = 'LOGIN';
  return e;
}

/** Birden çok etiket belgesini, her biri ayrı sayfa olacak şekilde tek belgede birleştirir. */
function combineLabels(htmls) {
  const head = (h) => (h.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ''])[1];
  const body = (h) => (h.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, h])[1];
  const pages = htmls.map((h, i) => `<div class="mf-etiket" style="position:relative;break-inside:avoid;page-break-inside:avoid;${i < htmls.length - 1 ? 'break-after:page;page-break-after:always;' : ''}">${body(h)}</div>`).join('');
  return `<!DOCTYPE html><html><head>${head(htmls[0])}</head><body>${pages}</body></html>`;
}

/**
 * Sticker yazdırma ayarları (Ayarlar > Kargo etiketi). Varsayılanlar Xprinter XP-470B ile denenmiş ayarlar:
 * 4x4 inç kağıt, %50 ölçek (ilk %32 denemesinde bu yazıcıda küçük çıktı), kenar boşlukları üst 8 / alt 8 / sol 14 / sağ 0 mm, dikey, arka plan grafikleri kapalı.
 */
const STICKER_DEFAULTS = { w: 101.6, h: 101.6, scale: 50, mt: 8, mb: 8, ml: 14, mr: 0, landscape: false, background: false };
function normalizeSticker(v) {
  const o = { ...STICKER_DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
  const n = (x, min, max, d) => { const k = Number(x); return Number.isFinite(k) && k >= min && k <= max ? Math.round(k * 10) / 10 : d; };
  return {
    w: n(o.w, 25, 300, STICKER_DEFAULTS.w), h: n(o.h, 25, 400, STICKER_DEFAULTS.h), scale: Math.round(n(o.scale, 10, 200, STICKER_DEFAULTS.scale)),
    mt: n(o.mt, 0, 50, 8), mb: n(o.mb, 0, 50, 8), ml: n(o.ml, 0, 50, 14), mr: n(o.mr, 0, 50, 0),
    landscape: !!o.landscape, background: !!o.background,
  };
}

module.exports = { PANEL_PRINTED_SCRIPT, PANEL_LIST_READY, utf8Html, stickerHtml, BULK: { BULK_LIST_SCRIPT, pageSizeScript, bulkSelectScript, BULK_CHECKED_SCRIPT, BULK_OPEN_MENU, bulkMenuScript, bulkSplitScript, TEXT_SCRIPT }, STICKER_DEFAULTS, normalizeSticker, combineLabels, LabelPrinter, orderUrl, HOOK_SCRIPT, findScript, clickScript, RESULT_SCRIPT, EXTRACT_SCRIPT, PANEL_ORIGIN };
