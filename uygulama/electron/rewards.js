'use strict';
const { buildExtractScript, buildClickScript, buildConfirmScript } = require('../core/rewards/extract');
const { classify, decideClaims, verifyClaim, assessPage } = require('../core/rewards/engine');
const { addAudit } = require('../core/audit');
const { sleep, nowIso } = require('../core/util');

const PARTITION = 'persist:trendyol-satici-paneli';
const DEFAULT_PANEL_URL = 'https://partner.trendyol.com/';
const DEFAULT_REWARD_URL = 'https://partner.trendyol.com/growth-center/level-rewards';
// Panelde incelendi (Ekim 2026): Gelişim Merkezi > Ödül Mağazası
const REWARD_STORE_URL = 'https://partner.trendyol.com/growth-center/level-rewards';
const ALLOWED_HOST = /(^|\.)trendyol\.com$/i;

/**
 * Gelişim / seviye ödül sayfası izleyicisi.
 *
 * Trendyol bu bölüm için resmî API sunmaz. Bu modül, kullanıcının KENDİSİNİN giriş yaptığı
 * satıcı paneli oturumunu (uygulamaya özel, kalıcı tarayıcı bölümü) kullanarak sayfayı okur.
 * - Giriş, CAPTCHA ve iki adımlı doğrulama kullanıcı tarafından elle yapılır; atlatılmaya çalışılmaz.
 * - Oturum kapanırsa veya sayfa yapısı değişirse otomatik talep DURDURULUR.
 * - Puan/para/hak harcayan veya şart içeren ödüller asla otomatik talep edilmez.
 * - Bir ödül için en fazla BİR otomatik deneme yapılır; sonuç belirsizse tekrar denenmez.
 */
class RewardWatcher {
  constructor({ electron, store, emit, notify, devAllowLocal = false }) {
    this.electron = electron;
    this.devAllowLocal = devAllowLocal; // yalnızca geliştirici testi: yerel sahte sayfaya izin
    this.store = store;
    this.emit = emit;
    this.notify = notify;
    this.panelWin = null;
    this.busy = false;
  }

  state() {
    const st = this.store.get('rewards', { url: DEFAULT_REWARD_URL, lastCheckAt: null, lastStatus: null, lastMessage: null, lastCardCount: 0, cards: [], progressLines: [], history: {}, knownKeys: [] });
    if (!st.url) st.url = DEFAULT_REWARD_URL;
    return st;
  }
  save(st) { this.store.set('rewards', st, { immediate: true }); this.emit('rewards', this.publicState()); }
  publicState() {
    const s = this.state();
    return { ...s, url: s.url || REWARD_STORE_URL, defaultUrl: REWARD_STORE_URL, busy: this.busy, panelOpen: !!(this.panelWin && !this.panelWin.isDestroyed()) };
  }
  cfg() {
    const settings = this.store.get('settings', {});
    return {
      claimTexts: settings.rewardClaimTexts && settings.rewardClaimTexts.length ? settings.rewardClaimTexts : ['Hemen Al', 'Talep Et', 'Ücretsiz Al', 'Ödülü Al', 'Al'],
      confirmTexts: settings.rewardConfirmTexts && settings.rewardConfirmTexts.length ? settings.rewardConfirmTexts : ['Onayla', 'Evet', 'Satın Al', 'Ödülü Al', 'Al', 'Puanla Al'],
    };
  }

  isSafeUrl(u) {
    try {
      const x = new URL(u);
      if (this.devAllowLocal && x.protocol === 'http:' && x.hostname === '127.0.0.1') return true;
      return x.protocol === 'https:' && ALLOWED_HOST.test(x.hostname);
    } catch (_) { return false; }
  }

  /** Kullanıcının giriş yapacağı görünür panel penceresi. */
  openPanel(url) {
    const { BrowserWindow, shell } = this.electron;
    if (this.panelWin && !this.panelWin.isDestroyed()) { this.panelWin.show(); this.panelWin.focus(); return; }
    const target = url && this.isSafeUrl(url) ? url : (this.state().url || DEFAULT_PANEL_URL);
    this.panelWin = new BrowserWindow({
      width: 1280, height: 860, title: 'Pazaryeri Satıcı Paneli — Oturum', backgroundColor: '#ffffff', autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.panelWin.webContents.setWindowOpenHandler(({ url: u }) => {
      if (this.isSafeUrl(u)) { this.panelWin.loadURL(u); } else if (/^https:/.test(u)) { shell.openExternal(u); }
      return { action: 'deny' };
    });
    this.panelWin.on('closed', () => { this.panelWin = null; this.emit('rewards', this.publicState()); });
    this.panelWin.loadURL(target);
    this.emit('rewards', this.publicState());
  }

  /**
   * Satıcı panelinde bir sayfayı açar ve (varsa) metniyle verilen düğmeyi görünür yapıp vurgular.
   * Düğmeye TIKLAMAZ: kargo etiketi yazdırma ve fatura işlemlerini satıcı kendisi yapar.
   */
  openPanelAt(url, highlightText) {
    if (!this.isSafeUrl(url)) throw new Error('Geçersiz panel adresi');
    if (this.panelWin && !this.panelWin.isDestroyed()) { this.panelWin.loadURL(url); this.panelWin.show(); this.panelWin.focus(); } else { this.openPanel(url); }
    const win = this.panelWin;
    if (!win || !highlightText) return;
    const script = `(async () => {
      const want = ${JSON.stringify(String(highlightText))};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 40; i++) {
        const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === want);
        if (b) { b.scrollIntoView({ block: 'center', inline: 'center' }); b.style.outline = '3px solid #F59E0B'; b.style.outlineOffset = '3px'; b.style.borderRadius = '8px'; return 'ok'; }
        await sleep(500);
      }
      return 'yok';
    })()`;
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => { if (!win.isDestroyed()) win.webContents.executeJavaScript(script, true).catch(() => {}); }, 800);
    });
  }

  /**
   * Açık panel sayfasındaki dosya seçme alanına dosyayı koyar (Chrome DevTools protokolü ile).
   * Hiçbir düğmeye basmaz; yüklemeyi/onayı satıcı kendisi yapar. Alan yoksa attached:false döner.
   */
  async attachFileToPanel(filePath) {
    const win = this.panelWin;
    if (!win || win.isDestroyed()) throw new Error('Satıcı paneli penceresi açık değil');
    const dbg = win.webContents.debugger;
    let attachedHere = false;
    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
      if (!nodeIds || !nodeIds.length) return { attached: false, inputs: 0 };
      await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: nodeIds[0] });
      return { attached: true, inputs: nodeIds.length };
    } finally {
      if (attachedHere) { try { dbg.detach(); } catch (_) { /* yoksay */ } }
    }
  }

  /** Açık panel penceresindeki tabloları okur (yalnızca okuma). */
  async readPanelTables(script) {
    const win = this.panelWin;
    if (!win || win.isDestroyed()) throw new Error('Satıcı paneli penceresi açık değil');
    return win.webContents.executeJavaScript(script, true);
  }

  currentPanelUrl() {
    if (!this.panelWin || this.panelWin.isDestroyed()) return null;
    return this.panelWin.webContents.getURL();
  }

  setUrl(url) {
    if (!this.isSafeUrl(url)) throw new Error('Yalnızca https://...trendyol.com adresleri kabul edilir.');
    const st = this.state();
    st.url = url;
    this.save(st);
    return st.url;
  }

  async withHiddenPage(url, fn) {
    const { BrowserWindow } = this.electron;
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.setAudioMuted(true);
    try {
      await Promise.race([
        win.loadURL(url),
        sleep(45000).then(() => { throw new Error('Ödül sayfası 45 saniyede yüklenemedi'); }),
      ]);
      return await fn(win);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  /**
   * Satıcı panelindeki "Güncel Kargo Fiyatları" PDF bağlantısını bulur (yalnızca okuma; sayfada hiçbir ayar değiştirilmez).
   * Kargo İşlemleri sayfasındaki düğme PDF'i yeni sekmede açar; bu açılış engellenip adres yakalanır.
   */
  async fetchCargoPdfUrl() {
    return this.withHiddenPage('https://partner.trendyol.com/support/cargo-operations', async (win) => {
      let captured = null;
      win.webContents.setWindowOpenHandler(({ url }) => { if (!captured) captured = url; return { action: 'deny' }; });
      const script = `(() => {
        if (/\\/(login|giris|auth)/i.test(location.pathname) || document.querySelector('input[type="password"]')) return 'login';
        const b = document.querySelector('[data-test-id="cargo-desi-prices"]');
        if (b) { const x = b.shadowRoot && b.shadowRoot.querySelector('button'); (x || b).click(); return 'clicked'; }
        const tab = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim() === 'Kargo Fiyatları & Desi');
        if (tab) { (tab.closest('bl-tab,[role="tab"],button,a,li') || tab).click(); return 'tab'; }
        return 'wait';
      })()`;
      for (let i = 0; i < 20 && !captured; i++) {
        await sleep(1500);
        const r = await win.webContents.executeJavaScript(script, true).catch(() => 'wait');
        if (r === 'login') throw new Error('Satıcı paneline giriş yapılmamış. Gelişim Ödülleri sayfasından "Satıcı panelini aç" ile bir kez giriş yapın.');
      }
      if (!captured) throw new Error('Kargo fiyat listesi bağlantısı bulunamadı; panel yapısı değişmiş olabilir.');
      if (!/^https:\/\/s3\.trendyol\.com\/[^\s]*cargo-desi-prices[^\s]*\.pdf$/i.test(captured)) throw new Error('Beklenmeyen kargo listesi adresi: ' + captured.slice(0, 120));
      return captured;
    });
  }

  /** Satıcı paneli › Ödemeler ekranının metnini okur (yalnızca okuma). Giriş yoksa hata verir. */
  async readPaymentDashboardText() {
    return this.withHiddenPage('https://partner.trendyol.com/payments/my-payments/payment-dashboard', async (win) => {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const script = `(() => {
        if (/\\/(login|giris|auth)/i.test(location.pathname) || document.querySelector('input[type="password"]')) return { login: true };
        const m = document.querySelector('main') || document.body;
        return { text: m ? m.innerText : '' };
      })()`;
      let last = '';
      for (let i = 0; i < 20; i++) {
        await sleep(1500);
        const r = await win.webContents.executeJavaScript(script, true).catch(() => ({}));
        if (r.login) throw new Error('Satıcı paneline giriş yapılmamış. Gelişim Ödülleri sayfasından "Satıcı panelini aç" ile bir kez giriş yapın.');
        const t = r.text || '';
        if (/Toplam Güncel Bakiye/.test(t) && /(Ödeme Günü|Sıradaki Ödeme)/.test(t)) {
          if (t === last) return t; // içerik oturdu
          last = t;
        }
      }
      if (last) return last;
      throw new Error('Ödemeler ekranı okunamadı; panel yapısı değişmiş olabilir.');
    });
  }

  /** Sayfa tek sayfa uygulaması olduğu için içerik oturana kadar okumayı tekrarlar. */
  async readStable(win) {
    const script = buildExtractScript(this.cfg());
    let last = null;
    for (let i = 0; i < 8; i++) {
      await sleep(i === 0 ? 2500 : 1500);
      const page = await win.webContents.executeJavaScript(script, true);
      if (page.loginRequired) return page;
      if (last && page.cards.length === last.cards.length && page.cards.length > 0) return page;
      last = page;
    }
    return last;
  }

  /**
   * Ödül sayfasını kontrol eder; izin verilmişse ücretsiz ödülleri talep eder.
   * @returns {status, message, pause?}
   */
  async check({ trigger = 'manual', allowAutoClaim = false } = {}) {
    if (this.busy) return { status: 'skipped', message: 'Kontrol zaten sürüyor' };
    const st = this.state();
    if (!st.url) st.url = REWARD_STORE_URL;
    const settings = this.store.get('settings', {});
    this.busy = true;
    this.emit('rewards', this.publicState());
    try {
      return await this.withHiddenPage(st.url, async (win) => {
        const page = await this.readStable(win);
        const assess = assessPage(page, st);
        st.lastCheckAt = nowIso();
        st.lastStatus = assess.status;
        st.lastMessage = assess.message;
        st.pageUrl = page && page.url;
        if (assess.status === 'session_expired' || assess.status === 'structure_changed' || assess.status === 'error') {
          this.save(st);
          this.notify({ level: 'warning', title: 'Ödül izleyici', body: assess.message });
          addAudit(this.store, { type: 'reward', action: 'Ödül sayfası kontrolü', initiator: trigger === 'manual' ? 'user' : 'automation', status: 'warning', message: assess.message });
          return { status: 'warning', message: assess.message, pause: assess.status !== 'error' };
        }
        const cards = page.cards.map((c) => ({ ...c, ...classify(c), history: st.history[c.key] || null }));
        const known = new Set(st.knownKeys || []);
        const fresh = cards.filter((c) => !known.has(c.key));
        st.cards = cards;
        st.progressLines = page.progressLines || [];
        st.level = page.level || st.level || null;
        st.balance = Number.isFinite(page.balance) ? page.balance : (st.balance ?? null);
        st.layout = page.layout || null;
        st.lastCardCount = cards.length;
        st.knownKeys = [...new Set([...(st.knownKeys || []), ...cards.map((c) => c.key)])].slice(-500);
        const claimableNew = fresh.filter((c) => ['free', 'points', 'costly', 'conditional'].includes(c.cls));
        if (known.size > 0 && claimableNew.length) {
          this.notify({ level: 'info', title: 'Yeni ödül', body: `${claimableNew.length} yeni ödül görüldü: ${claimableNew.slice(0, 3).map((c) => c.title).join(', ')}` });
        }
        this.save(st);

        const claims = [];
        if (allowAutoClaim && (settings.rewardAutoClaim || settings.rewardAutoPoints)) {
          const keys = decideClaims(cards, {
            autoClaim: !!settings.rewardAutoClaim, requireFreeMarker: settings.rewardRequireFree !== false,
            autoPoints: !!settings.rewardAutoPoints, maxPoints: Number(settings.rewardMaxPoints) || 0, minBalance: Number(settings.rewardMinBalance) || 0,
            balance: Number.isFinite(page.balance) ? page.balance : null,
            history: st.history, maxPerRun: Math.min(Number(settings.rewardMaxPerRun) || 1, 5),
          });
          for (const key of keys) {
            const r = await this.claimOnPage(win, key, cards.find((c) => c.key === key), 'automation', page.balance);
            claims.push(r);
            if (r.result !== 'success') {
              return { status: 'warning', message: `Otomatik talep "${r.title}" için ${r.result === 'failed' ? 'başarısız' : 'belirsiz'} sonuçlandı; güvenlik için otomasyon durduruldu.`, pause: true, claims };
            }
          }
        }
        const counts = cards.reduce((a, c) => { a[c.cls] = (a[c.cls] || 0) + 1; return a; }, {});
        const msg = (st.level ? `Seviye ${st.level} · ${Number(st.balance || 0).toLocaleString('tr-TR')} puan · ` : '') + `${cards.length} ödül · puanla alınabilir ${counts.points || 0} · ücretsiz ${counts.free || 0} · tükenen/uygun değil ${counts.unavailable || 0}` + (claims.length ? ` · ${claims.length} ödül otomatik alındı` : '');
        return { status: 'success', message: msg, claims };
      });
    } finally {
      this.busy = false;
      this.emit('rewards', this.publicState());
    }
  }

  /** Talep: deneme kaydı TIKLAMADAN ÖNCE diske yazılır, sonra tıklanır ve sonuç sayfadan doğrulanır. */
  async claimOnPage(win, key, card, initiator, balanceBefore) {
    const st = this.state();
    const h = st.history[key] || { title: card ? card.title : key, attempts: 0 };
    h.attempts += 1;
    h.status = 'pending';
    h.lastAt = nowIso();
    h.initiator = initiator;
    st.history[key] = h;
    this.save(st);
    let result, reason;
    const click = await win.webContents.executeJavaScript(buildClickScript({ ...this.cfg(), key }), true);
    if (!click.clicked) {
      result = 'failed';
      reason = click.reason || 'Tıklanamadı';
    } else {
      // Tıklamadan sonra açılan onay penceresi varsa, yalnızca tanınan TEK onay butonuna basılır
      await sleep(1800);
      let confirmInfo = null;
      try { confirmInfo = await win.webContents.executeJavaScript(buildConfirmScript(this.cfg()), true); } catch (_) { /* yoksay */ }
      if (confirmInfo && confirmInfo.dialog && !confirmInfo.clicked) {
        result = 'uncertain';
        reason = 'Onay penceresi açıldı ama onay butonu tanınamadı (' + (confirmInfo.reason || '') + '). Panelden kontrol edin.';
      } else {
        await sleep(4000);
        const after = await win.webContents.executeJavaScript(buildExtractScript(this.cfg()), true);
        const v = verifyClaim(key, after, { balance: balanceBefore, cost: card && card.cost, wasClaimable: true });
        result = v.result;
        reason = v.reason + (confirmInfo && confirmInfo.clicked ? ' (onay penceresi onaylandı)' : '');
      }
    }
    const st2 = this.state();
    st2.history[key] = { ...st2.history[key], status: result, reason, verifiedAt: nowIso() };
    this.save(st2);
    addAudit(this.store, { type: 'reward', action: 'Ödül talebi', initiator, status: result === 'success' ? 'success' : result === 'failed' ? 'failed' : 'uncertain', title: h.title, message: reason });
    this.notify({ level: result === 'success' ? 'success' : 'warning', title: result === 'success' ? 'Ödül alındı' : 'Ödül talebi doğrulanamadı', body: `${h.title}: ${reason}` });
    return { key, title: h.title, result, reason };
  }

  /** Kullanıcının arayüzden başlattığı tek ödül talebi. */
  async manualClaim(key, { confirmSpend = false, force = false } = {}) {
    if (this.busy) throw new Error('Başka bir ödül işlemi sürüyor');
    const st = this.state();
    if (!st.url) st.url = REWARD_STORE_URL;
    const h = st.history[key];
    if (h && h.status === 'success') throw new Error('Bu ödül daha önce başarıyla alındı.');
    if (h && h.status === 'uncertain' && !force) throw new Error('Bu ödülün önceki talep sonucu belirsiz. Panelden kontrol etmeden tekrar denemeyin.');
    this.busy = true;
    this.emit('rewards', this.publicState());
    try {
      return await this.withHiddenPage(st.url, async (win) => {
        const page = await this.readStable(win);
        if (page.loginRequired) throw new Error('Satıcı paneli oturumu kapalı. Önce panele giriş yapın.');
        const card = page.cards.map((c) => ({ ...c, ...classify(c) })).find((c) => c.key === key);
        if (!card) throw new Error('Ödül kartı sayfada artık bulunamıyor.');
        if (card.cls === 'claimed') throw new Error('Ödül zaten alınmış görünüyor.');
        if (card.cls === 'unavailable') throw new Error('Ödül şu anda talep edilemiyor: ' + card.reason);
        if ((card.cls === 'costly' || card.cls === 'conditional' || card.cls === 'points') && !confirmSpend) {
          const e = new Error('Bu ödül harcama veya ek şart içeriyor; açık onay gerekli.');
          e.code = 'confirm_required';
          throw e;
        }
        return this.claimOnPage(win, key, card, 'user', page.balance);
      });
    } finally {
      this.busy = false;
      this.emit('rewards', this.publicState());
    }
  }

  resetHistory(key) {
    const st = this.state();
    delete st.history[key];
    this.save(st);
  }
}

module.exports = { RewardWatcher, PARTITION, DEFAULT_PANEL_URL, REWARD_STORE_URL };
