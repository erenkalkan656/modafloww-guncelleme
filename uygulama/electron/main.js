'use strict';
const path = require('path');
const electron = require('electron');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, session } = electron;
const { JsonStore } = require('../core/store');
const { createServices } = require('./services');

const fs = require('fs');

// ---------- Hata kaydı ----------
// Açılış adımları ve hatalar hem kullanıcı veri klasörüne hem de (kuruluysa) uygulama klasörünün yanına
// "hata-kaydi.txt" olarak yazılır. Gizli bilgi (API anahtarı vb.) yazılmaz.
const LOG_FILES = [];
try { if (app.isPackaged) LOG_FILES.push(path.join(path.dirname(process.execPath), '..', 'hata-kaydi.txt')); } catch (_) { /* yoksay */ }
function log(...parts) {
  const line = new Date().toISOString() + ' ' + parts.map((p) => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\r\n';
  for (const f of LOG_FILES) {
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, '');
      fs.appendFileSync(f, line, 'utf8');
    } catch (_) { /* yazılamazsa yoksay */ }
  }
}
process.on('uncaughtException', (e) => {
  log('YAKALANMAYAN HATA:', e);
  try { electron.dialog.showErrorBox('Pazaryeri Satıcı Paneli — beklenmeyen hata', String(e && (e.stack || e.message) || e) + '\n\nAyrıntı hata-kaydi.txt dosyasına yazıldı.'); } catch (_) { /* yoksay */ }
});
process.on('unhandledRejection', (e) => log('YAKALANMAYAN SÖZ HATASI:', e instanceof Error ? e : String(e)));

const isDev = !app.isPackaged && process.env.TSP_DEV === '1';
const startHidden = process.argv.includes('--hidden');

if (process.env.TSP_USER_DATA) app.setPath('userData', process.env.TSP_USER_DATA);
// Tarih seçiciler ve sayı biçimleri Türkçe görünsün (gg.aa.yyyy)
app.commandLine.appendSwitch('lang', 'tr');
// Bellek: ağ servisi ayrı süreç yerine ana süreçte çalışır (arka planda bir süreç daha az)
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
// Paketsiz (Squirrel'sız) kurulumda Windows bildirimlerinin görünmesi için exe yolu kimlik olarak kullanılır
app.setAppUserModelId(process.platform === 'win32' ? process.execPath : 'com.eren.trendyolpanel');

try { LOG_FILES.push(path.join(app.getPath('userData'), 'hata-kaydi.txt')); } catch (_) { /* yoksay */ }
log('---- Başlatılıyor · sürüm', app.getVersion(), '· electron', process.versions.electron, '· argv', process.argv.slice(1).join(' '));

if (!app.requestSingleInstanceLock()) {
  log('Başka bir kopya zaten çalışıyor; o kopyanın penceresi öne getirilecek ve bu kopya kapanıyor.');
  app.quit();
} else {
  let mainWin = null;
  let tray = null;
  let quitting = false;
  const store = new JsonStore(path.join(app.getPath('userData'), 'veri'));
  log('Veri klasörü:', store.dir);

  const emit = (type, payload) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('event', { type, payload });
    if (type === 'notification' && tray) tray.setToolTip('Pazaryeri Satıcı Paneli — ' + (payload.title || ''));
  };
  // Tema: pencere çerçevesi (başlık çubuğu düğmeleri) ve sistem teması arayüzle uyumlu olsun
  const { nativeTheme } = electron;
  const themePref = () => { const t = (store.get('settings', {}) || {}).theme; return ['light', 'dark', 'system'].includes(t) ? t : 'light'; };
  function applyWindowTheme(pref) {
    if (!['light', 'dark', 'system'].includes(pref)) pref = themePref();
    try { nativeTheme.themeSource = pref; } catch (_) { /* yoksay */ }
    const dark = pref === 'dark' || (pref === 'system' && nativeTheme.shouldUseDarkColors);
    // Pencere düğmelerinin zemini üst çubukla aynı renkte olsun (seçili görünümden okunur)
    let frame = dark ? '#1E1F23' : '#3D3F45', symbol = dark ? '#ECEAE5' : '#F5F3EE';
    try {
      const themeCore = require('../core/theme');
      const pal = themeCore.resolvePalette(themeCore.normalizeAppearance((store.get('settings', {}) || {}).appearance), dark ? 'dark' : 'light', 'desktop');
      if (pal && themeCore.isHex(pal.topbar)) { frame = pal.topbar; symbol = themeCore.textOn(frame); }
    } catch (_) { /* varsayılan renkler kalır */ }
    if (mainWin && !mainWin.isDestroyed()) {
      try { mainWin.setBackgroundColor(frame); } catch (_) { /* yoksay */ }
      try { if (typeof mainWin.setTitleBarOverlay === 'function') mainWin.setTitleBarOverlay({ color: frame, symbolColor: symbol, height: 60 }); } catch (_) { /* yoksay */ }
    }
  }
  nativeTheme.on('updated', () => { if (themePref() === 'system') applyWindowTheme('system'); });
  const openOrder = (orderNumber) => {
    showWindow();
    const wc = mainWin && !mainWin.isDestroyed() ? mainWin.webContents : null;
    const send = () => emit('open-order', { orderNumber: orderNumber || null });
    if (wc && wc.isLoading()) wc.once('did-finish-load', () => setTimeout(send, 600)); else send();
  };
  const services = createServices({ electron, store, emit, isDev, onTheme: (t) => applyWindowTheme(t), onOpenOrder: (n) => openOrder(n) });

  const iconPath = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'app.ico' : 'icon.png');

  function createWindow() {
    mainWin = new BrowserWindow({
      width: 1480, height: 920, minWidth: 1120, minHeight: 700,
      backgroundColor: '#3D3F45', show: false, title: 'Pazaryeri Satıcı Paneli', icon: iconPath,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#3D3F45', symbolColor: '#F5F3EE', height: 60 },
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    mainWin.removeMenu();
    applyWindowTheme();
    // Uygulama içinde başka sayfaya gidilmesini engelle; dış bağlantıları varsayılan tarayıcıda aç
    mainWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    mainWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://') && !url.startsWith('http://localhost')) { e.preventDefault(); } });
    const wc = mainWin.webContents;
    wc.on('did-fail-load', (_e, code, desc, url) => log('Sayfa yüklenemedi:', code, desc, url));
    wc.on('render-process-gone', (_e, d) => {
      log('Arayüz süreci kapandı:', d);
      // Arayüz çökerse/öldürülürse kendini toparla: pencereyi yeniden yükle
      if (!quitting && d && d.reason !== 'clean-exit') {
        setTimeout(() => {
          try { if (mainWin && !mainWin.isDestroyed()) { mainWin.reload(); log('Arayüz yeniden yüklendi'); } } catch (e) { log('Yeniden yükleme hatası:', e); }
        }, 800);
      }
    });
    wc.on('unresponsive', () => log('Arayüz yanıt vermiyor'));
    wc.on('preload-error', (_e, p, err) => log('Preload hatası:', p, err));
    wc.on('console-message', (...a) => {
      const ev = a[0] || {};
      const level = ev.level != null ? ev.level : a[1];
      const message = ev.message != null ? ev.message : a[2];
      if (level === 'error' || level === 3) log('Arayüz hatası:', String(message).slice(0, 2000));
    });
    mainWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html')).then(() => log('Arayüz yüklendi')).catch((e) => log('loadFile hatası:', e));
    let shown = false;
    const reveal = (why) => { if (shown || startHidden || !mainWin || mainWin.isDestroyed()) return; shown = true; mainWin.show(); log('Pencere gösterildi (' + why + ')'); };
    mainWin.once('ready-to-show', () => reveal('hazır'));
    // Güvenlik ağı: herhangi bir nedenle "hazır" olayı gelmezse pencere yine de açılır
    setTimeout(() => reveal('zaman aşımı'), 5000);
    mainWin.on('close', () => {
      // Tepside çalışma: pencere GİZLENMEZ, tamamen kapanır (arayüz belleği boşalır). Otomasyonlar, eşitleme ve
      // bildirimler ana süreçte sürer; tepsiden "Paneli aç" deyince arayüz yeniden yüklenir.
      if (!quitting && services.settings().runInTray) {
        log('Pencere kapatıldı; uygulama tepside çalışmaya devam ediyor (arayüz bellekten boşaltıldı)');
        if (!store.get('trayHintShown', false)) {
          store.set('trayHintShown', true);
          services.notify({ level: 'info', title: 'Arka planda çalışıyor', body: 'Otomasyonlar devam ediyor. Kapatmak için sistem tepsisindeki simgeye sağ tıklayıp "Çıkış" seçin.' });
        }
      }
    });
    mainWin.on('closed', () => { mainWin = null; });
    if (isDev && process.env.TSP_DEVTOOLS === '1') mainWin.webContents.openDevTools({ mode: 'detach' });
  }

  function showWindow() {
    log('Pencere öne getiriliyor');
    if (mainWin && !mainWin.isDestroyed() && mainWin.webContents.isCrashed()) { log('Çökmüş arayüz yeniden yükleniyor'); mainWin.reload(); }
    if (!mainWin || mainWin.isDestroyed()) createWindow();
    mainWin.show();
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  }

  function createTray() {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray.png'));
      tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
      const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Paneli aç', click: showWindow },
        { type: 'separator' },
        { label: services.scheduler.globalPaused ? 'Otomasyonları sürdür' : 'Tüm otomasyonları duraklat', click: () => { services.scheduler.setGlobalPause(!services.scheduler.globalPaused); rebuild(); } },
        { type: 'separator' },
        { label: 'Çıkış', click: () => { quitting = true; app.quit(); } },
      ]));
      rebuild();
      tray.setToolTip('Pazaryeri Satıcı Paneli');
      tray.on('click', showWindow);
    } catch (e) { tray = null; log('Tepsi simgesi oluşturulamadı:', e); }
  }

  app.on('second-instance', showWindow);

  app.whenReady().catch((e) => log('whenReady hatası:', e));
  app.whenReady().then(() => {
    // Ek güvenlik: uygulama penceresi için izin isteklerini (kamera, konum vb.) reddet
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ipcMain.handle('api', async (_e, method, args) => {
      try {
        return { ok: true, data: await services.handle(method, args) };
      } catch (e) {
        return { ok: false, error: { message: e.message, code: e.code || null, data: e.data != null ? JSON.parse(JSON.stringify(e.data)) : null } };
      }
    });
    try { services.startup(); log('Servisler başlatıldı'); } catch (e) { log('Servis başlatma hatası:', e); }
    // Windows açılışında gizli başlatıldıysa arayüz hiç yüklenmez (tepsiden açılınca yüklenir)
    if (!startHidden) createWindow(); else log('Gizli başlatıldı: arayüz tepsiden açılınca yüklenecek');
    createTray();
    log('Pencere ve tepsi oluşturuldu');
    app.on('activate', showWindow);
  });

  app.on('before-quit', () => { quitting = true; services.scheduler.stop(); try { services.bridge.stop(); } catch (_) { /* yoksay */ } store.flushAll(); });
  app.on('window-all-closed', () => {
    if (!services.settings().runInTray || quitting) app.quit();
  });
}
