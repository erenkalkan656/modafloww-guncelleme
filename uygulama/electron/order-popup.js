'use strict';
// Masaüstü sipariş bildirimi: ekranın sağ altında, uygulamanın renkleriyle küçük bir kart.
// Kart penceresinde JavaScript kapalıdır; düğmeler bağlantı olarak çalışır ve ana süreçte yakalanır.

const W = 360;
const H = 268;
const GAP = 10;
const MARGIN = 16;
const MAX_VISIBLE = 3;
const LIFETIME_MS = 20000;

// Kısa, yumuşak iki tonlu bildirim sesi (WAV, 8 kHz mono) — dosya gerektirmez, sistem sesine bağlı değildir
const CHIME = (() => {
  const rate = 8000, dur = 0.42, n = Math.floor(rate * dur);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = t < 0.16 ? 880 : 1318.5;
    const local = t < 0.16 ? t : t - 0.16;
    const env = Math.exp(-local * 9) * Math.min(1, local * 200);
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * t) * env * 0.32 * 32767), 44 + i * 2);
  }
  return 'data:audio/wav;base64,' + buf.toString('base64');
})();

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v, cur = 'TRY') => {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  try { return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: cur || 'TRY' }).format(Number(v)); } catch (_) { return Number(v).toFixed(2) + ' ' + cur; }
};

function cardHtml(s, { sound = false } = {}) {
  const box = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
  const tags = [s.fast ? 'Hızlı teslimat' : null, s.abroad ? 'Yurt dışı' : null].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const title = s.summaryCount ? `${s.summaryCount} yeni sipariş daha` : 'Yeni sipariş geldi';
  const body = s.summaryCount
    ? `<div class="amount">${esc(money(s.amount, s.currency))}</div><div class="line">Toplam ${esc(s.summaryCount)} paket bekliyor</div>`
    : `<div class="amount">${esc(money(s.amount, s.currency))}</div>
       <div class="line">Sipariş #${esc(s.orderNumber)}</div>
       <div class="line icon">${box}<span>${esc(s.units)} ürün sipariş edildi${s.more ? ` · ${esc(s.more + 1)} farklı ürün` : ''}</span></div>
       ${s.product ? `<div class="product" title="${esc(s.product)}">${esc(s.product)}</div>` : ''}
       ${tags ? `<div class="tags">${tags}</div>` : ''}`;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; media-src data:">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; -webkit-font-smoothing: antialiased; user-select: none; }
  .card { position: absolute; inset: 6px; border-radius: 16px; background: #3D3F45; color: #F5F3EE; padding: 14px 16px 14px; box-shadow: 0 12px 32px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.06); display: flex; flex-direction: column; animation: in .22s ease-out; }
  @keyframes in { from { transform: translateY(10px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  .head { display: flex; align-items: center; gap: 10px; }
  .mark { width: 30px; height: 30px; border-radius: 9px; background: #F5F3EE; color: #3D3F45; display: grid; place-items: center; font-weight: 700; font-size: 15px; flex: none; }
  .who { flex: 1; min-width: 0; line-height: 1.25; }
  .who b { display: block; font-size: 13px; font-weight: 600; }
  .who span { font-size: 11.5px; color: rgba(245,243,238,.62); display: inline-flex; align-items: center; gap: 6px; }
  .who span i { width: 7px; height: 7px; border-radius: 50%; background: #4ADE80; box-shadow: 0 0 0 3px rgba(74,222,128,.22); display: inline-block; }
  .x { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; color: rgba(245,243,238,.6); text-decoration: none; font-size: 17px; line-height: 1; flex: none; }
  .x:hover { background: rgba(245,243,238,.12); color: #F5F3EE; }
  hr { border: 0; border-top: 1px solid rgba(245,243,238,.14); margin: 12px 0 10px; }
  .amount { font-size: 22px; font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
  .line { font-size: 13px; color: rgba(245,243,238,.86); margin-top: 4px; display: flex; align-items: center; gap: 7px; }
  .product { font-size: 12px; color: rgba(245,243,238,.6); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tags { display: flex; gap: 6px; margin: 7px 0 10px; }
  .tag { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: rgba(245,243,238,.12); color: #F5F3EE; }
  .btn { margin-top: auto; flex: none; display: block; text-align: center; text-decoration: none; background: #F5F3EE; color: #242529; font-weight: 600; font-size: 13.5px; padding: 10px 0; border-radius: 10px; }
  .btn:hover { background: #FFFFFF; }
</style></head><body><div class="card" role="alert">
  <div class="head"><div class="mark">P</div><div class="who"><b>Pazaryeri Satıcı Paneli</b><span><i></i>${esc(title)}</span></div><a class="x" href="https://bildirim.tsp.invalid/close" title="Kapat" aria-label="Kapat">×</a></div>
  <hr>${body}
  <a class="btn" href="https://bildirim.tsp.invalid/open">${s.summaryCount ? 'Siparişleri görüntüle' : 'Siparişi görüntüle'} →</a>
</div>${sound ? `<audio autoplay src="${CHIME}"></audio>` : ''}</body></html>`;
}

class OrderPopups {
  /** @param {{ electron: any, onOpen: (orderNumber: string|null) => void, log?: Function }} o */
  constructor({ electron, onOpen, log = () => {} }) {
    this.electron = electron;
    this.onOpen = onOpen;
    this.log = log;
    this.wins = [];
  }

  layout() {
    const { screen } = this.electron;
    const wa = screen.getPrimaryDisplay().workArea;
    this.wins = this.wins.filter((w) => !w.isDestroyed());
    this.wins.forEach((w, i) => {
      const x = wa.x + wa.width - W - MARGIN;
      const y = wa.y + wa.height - MARGIN - (i + 1) * H - i * GAP;
      try { w.setBounds({ x, y, width: W, height: H }); } catch (_) { /* yoksay */ }
    });
  }

  /** @param {object} summary core/order-watch orderSummary() çıktısı */
  show(summary, { sound = false } = {}) {
    const { BrowserWindow } = this.electron;
    if (!BrowserWindow) return null;
    // En fazla 3 kart: fazlası en eskiyi kapatır
    while (this.wins.filter((w) => !w.isDestroyed()).length >= MAX_VISIBLE) {
      const old = this.wins.shift();
      try { if (old && !old.isDestroyed()) old.close(); } catch (_) { /* yoksay */ }
    }
    const win = new BrowserWindow({
      width: W, height: H, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, hasShadow: false, backgroundColor: '#00000000',
      title: 'Yeni sipariş',
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    try { win.setAlwaysOnTop(true, 'floating'); } catch (_) { /* yoksay */ }
    const handle = (e, url) => {
      e.preventDefault();
      if (String(url).startsWith('https://bildirim.tsp.invalid/open')) { try { this.onOpen(summary.summaryCount ? null : summary.orderNumber); } catch (err) { this.log('Sipariş açılamadı', err); } }
      try { if (!win.isDestroyed()) win.close(); } catch (_) { /* yoksay */ }
    };
    win.webContents.on('will-navigate', handle);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => { this.wins = this.wins.filter((w) => w !== win); this.layout(); });
    this.wins.push(win);
    this.layout();
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(cardHtml(summary, { sound }))).then(() => {
      if (!win.isDestroyed()) win.showInactive();
    }).catch((err) => this.log('Sipariş bildirimi gösterilemedi', err));
    setTimeout(() => { try { if (!win.isDestroyed()) win.close(); } catch (_) { /* yoksay */ } }, LIFETIME_MS).unref?.();
    return win;
  }
}

module.exports = { OrderPopups, cardHtml };
