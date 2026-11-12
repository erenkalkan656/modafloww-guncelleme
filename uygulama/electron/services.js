'use strict';
const fs = require('fs');
const panelReport = require('../core/panel-report');
const { TrendyolClient } = require('../core/trendyol/client');
const { syncCatalog } = require('../core/catalog');
const { buildPricePlan, buildStockPlan, mergePriceStockPlans } = require('../core/pricing');
const profitCore = require('../core/profit');
const finance = require('../core/finance');
const { parseCargoPdf } = require('../core/cargo-pdf');
const { JobManager, JobError } = require('../core/jobs');
const { ProductOps, planCopy, planAddVariants, planArchive, planContentUpdate } = require('../core/productops');
const { patchCatalog, summarize } = require('../core/catalog');
const support = require('../core/support');
const { analyzeReturns } = require('../core/returns');
const { syncOrders, migrateOrderDates, NEW_STATUSES } = require('../core/orders');
const { labelExpectations } = require('../core/label-groups');
const BL = require('../core/blacklist');
const { checkNewOrders, orderSummary } = require('../core/order-watch');
const { OrderPopups } = require('./order-popup');
const { Scheduler } = require('../core/scheduler');
const { addAudit, queryAudit } = require('../core/audit');
const { toCSV } = require('../core/csv');
const { uid, nowIso, sanitize } = require('../core/util');
const { createSecrets, redact, hashPin, verifyPin, pinWaitMs, PIN_FREE_ATTEMPTS } = require('./secrets');
const { RewardWatcher, PARTITION } = require('./rewards');
const { LabelPrinter } = require('./label-printer');
const { AutoServerClient, DEFAULT_SERVER } = require('../core/autoserver-client');
const themeCore = require('../core/theme');
const opps = require('../core/opportunities');
const transfer = require('../core/catalog-transfer');
const brandCore = require('../core/brand-check');
const { Updater } = require('./updater');
const pickCore = require('../core/pick');
const { BrandChecker, READ_SCRIPT: TABLE_READ_SCRIPT } = require('./turkpatent');
const { BuyboxBridge, newToken: newBridgeToken } = require('./buybox-bridge');

const DEFAULT_SETTINGS = {
  sellerId: '',
  apiKey: null,
  apiSecret: null,
  apiKeyHint: null,
  env: 'prod',
  lowStock: 5,
  unusualPct: 30,
  runInTray: true,
  startWithWindows: false,
  pin: null,
  rewardClaimTexts: ['Hemen Al', 'Talep Et', 'Ücretsiz Al', 'Ödülü Al', 'Al'],
  rewardAutoClaim: false,
  rewardRequireFree: true,
  rewardMaxPerRun: 1,
  rewardAutoPoints: false,
  rewardMaxPoints: 15000,
  rewardMinBalance: 20000,
  rewardConfirmTexts: ['Onayla', 'Evet', 'Satın Al', 'Ödülü Al', 'Al', 'Puanla Al'],
  orderDays: 14,
  autoServerUrl: DEFAULT_SERVER,
  autoToken: null,
  autoDeviceId: null,
  autoRole: null,
  bbBridgeToken: null,
  catalogAddUrl: null,
  turkpatentUrl: null,
};
// Sunucu istemcisinde izin verilen işlemler (arayüz yalnızca bunları çağırabilir)
const AUTO_METHODS = new Set(['qnaConfig', 'saveQnaConfig', 'qnaSimulate', 'qnaLog', 'qnaStatus', 'qnaReportQueue', 'health', 'createPairCode', 'devices', 'revokeDevice', 'credentials', 'status', 'runNow', 'rules', 'rule', 'createRule', 'updateRule', 'deleteRule', 'simulate', 'activate', 'pause', 'reopenPreview', 'reopen', 'verify', 'reset', 'history', 'palettes', 'savePalettes']);

function createServices({ electron, store, emit, isDev, onTheme, onOpenOrder, startupPushDelayMs = 15000 }) {
  const { safeStorage, Notification, app, dialog, shell } = electron;
  const secrets = createSecrets(safeStorage);
  let locked = false;
  let clientCache = null;
  let syncing = null;
  let ordersSyncing = null;

  const settings = () => ({ ...DEFAULT_SETTINGS, ...store.get('settings', {}) });
  // ---------- Hesap önbelleği ----------
  // Pahalı türetilmiş veriler (Buybox listesi, hakediş özeti, sipariş kârları) bağımlı oldukları depoların sürümü
  // (store.rev) değişmedikçe yeniden hesaplanmaz. Depolara her yazma store.set/update ile yapıldığından sürüm güvenilirdir.
  // ttl: zamana bağlı sonuçlar (bugün, "yeni" süresi) için en uzun geçerlilik.
  const memos = new Map();
  function memo(key, deps, fn, ttl = 0) {
    const sig = deps.map((d) => store.rev(d)).join('.');
    const m = memos.get(key);
    if (m && m.sig === sig && (!ttl || Date.now() - m.at < ttl)) return m.value;
    const value = fn();
    if (memos.size > 60) memos.clear();
    memos.set(key, { sig, value, at: Date.now() });
    return value;
  }
  const profitData = () => memo('profitData', ['profit', 'orders'], profitDataRaw);
  const profitDataRaw = () => {
    const p = store.get('profit', {});
    const rates = p.rates && Array.isArray(p.rates.carriers) ? p.rates : null;
    const recent = ((store.get('orders', { items: [] }) || {}).items || []).slice(0, 300);
    const cutoff = profitCore.normalizeProfitSettings(p.settings || {}).sameDayCutoff;
    const settings = profitCore.normalizeProfitSettings({ ...(p.settings || {}), _rates: rates || undefined, _storeFast: profitCore.inferStoreFast(recent) ?? undefined, _sameDayShare: profitCore.inferSameDayShare(recent, cutoff) ?? undefined });
    return { settings, costs: { models: (p.costs || {}).models || {}, barcodes: (p.costs || {}).barcodes || {} }, defaults: profitCore.DEFAULT_PROFIT_SETTINGS, rates: rates || profitCore.OFFICIAL_RATES, ratesUpdated: rates ? rates.fetchedAt : null, barem: profitCore.OFFICIAL_BAREM };
  };
  const saveSettings = (patch) => store.set('settings', { ...settings(), ...patch }, { immediate: true });
  const autoClient = () => {
    const s = settings();
    if (!s.autoToken) { const e = new Error('Bu bilgisayar ortak otomasyon sunucusuna bağlı değil'); e.code = 'not_paired'; throw e; }
    return new AutoServerClient({ baseUrl: s.autoServerUrl || DEFAULT_SERVER, token: secrets.decrypt(s.autoToken), fetchImpl: (a, b) => fetch(a, b) });
  };

  function getClient() {
    const s = settings();
    if (!s.sellerId || !s.apiKey || !s.apiSecret) return null;
    const key = s.sellerId + '|' + s.env + '|' + s.apiKey.v + '|' + s.apiSecret.v;
    if (clientCache && clientCache.key === key) return clientCache.client;
    const client = new TrendyolClient({
      sellerId: s.sellerId, apiKey: secrets.decrypt(s.apiKey), apiSecret: secrets.decrypt(s.apiSecret), env: s.env,
      // Yalnızca geliştirici testleri için: canlı paket bu değişkeni kullanmaz
      baseUrl: isDev && process.env.TRENDYOL_BASE_URL ? process.env.TRENDYOL_BASE_URL : undefined,
    });
    clientCache = { key, client };
    return client;
  }
  const requireClient = () => {
    const c = getClient();
    if (!c) throw new Error('Trendyol API bilgileri girilmemiş. Ayarlar sayfasından Satıcı ID, API Key ve API Secret girin.');
    return c;
  };

  // ---------- Bildirimler ----------
  function notify({ level = 'info', title, body, silent = false }) {
    const n = { id: uid('n'), at: nowIso(), level, title, body, read: false };
    store.update('notifications', [], (cur) => [n, ...cur].slice(0, 200));
    emit('notification', n);
    if (!silent && Notification && Notification.isSupported()) {
      try { new Notification({ title: 'Trendyol Paneli — ' + title, body: body || '' }).show(); } catch (_) { /* yoksay */ }
    }
    return n;
  }

  // ---------- Yeni sipariş bildirimi (masaüstü kartı) ----------
  const popups = new OrderPopups({ electron, onOpen: (orderNumber) => { if (onOpenOrder) onOpenOrder(orderNumber); } });
  const watchSettings = () => ({ popup: true, sound: true, ...(((store.get('automations', {}) || {}).new_orders_watch || {}).settings || {}) });
  function announceOrders(fresh, cfg = watchSettings()) {
    if (!fresh.length) return;
    for (const o of fresh) {
      const sm = orderSummary(o);
      notify({ level: 'success', title: 'Yeni sipariş', body: `#${sm.orderNumber} · ${sm.amount != null ? Number(sm.amount).toLocaleString('tr-TR', { style: 'currency', currency: sm.currency || 'TRY' }) : ''} · ${sm.units} ürün${sm.product ? ' · ' + sm.product : ''}`, silent: true });
    }
    if (cfg.popup !== false) {
      const shown = fresh.slice(-2);
      const rest = fresh.slice(0, -2);
      if (rest.length) popups.show({ summaryCount: rest.length, amount: rest.reduce((a, o) => a + (Number(o.totalPrice) || 0), 0), currency: 'TRY' });
      // Ses yalnızca son kartta bir kez çalar
      shown.forEach((o, i) => popups.show(orderSummary(o), { sound: cfg.sound !== false && i === shown.length - 1 }));
    }
    emit('orders-updated', {});
  }

  // ---------- Buybox Fırsatları ----------
  const bridgeToken = () => {
    const s = settings();
    if (s.bbBridgeToken) { try { return secrets.decrypt(s.bbBridgeToken); } catch (_) { /* yeniden üret */ } }
    const t = newBridgeToken();
    saveSettings({ bbBridgeToken: secrets.encrypt(t) });
    return t;
  };
  const oppOwn = () => memo('oppOwn', ['catalog', 'buybox', 'settings'], () => ({ byContent: opps.ownIndex(store.get('catalog', null)), buybox: store.get('buybox', {}), sellerId: settings().sellerId }));
  async function refreshOwnBuybox(contentIds, force) {
    const own = opps.ownIndex(store.get('catalog', null));
    const barcodes = [...new Set(contentIds.flatMap((id) => own.get(String(id)) || []))];
    if (!barcodes.length || !getClient()) return 0;
    await api['buybox.get']({ barcodes, force });
    return barcodes.length;
  }
  const bridge = new BuyboxBridge({
    getToken: bridgeToken,
    onImport: async (body) => {
      if (locked) throw new Error('Panel kilitli. Önce PIN ile açın.');
      const { db, scan } = opps.mergeScan(store.get('opps', null), body || {}, { scanId: uid('tarama-') });
      store.set('opps', db, { immediate: true });
      emit('opps-updated', { scan });
      autoBrandCheck(4000);
      const ids = ((body && body.items) || []).map((x) => opps.parseProductUrl(x && x.url)).filter(Boolean).map((x) => x.contentId);
      refreshOwnBuybox(ids, false).then((n) => { if (n) emit('opps-updated', {}); }).catch(() => {});
      return { added: scan.added, updated: scan.updated, invalid: scan.invalid };
    },
  });

  const brandChecker = new BrandChecker({
    electron,
    getUrl: () => (isDev && process.env.TSP_TURKPATENT_URL) || settings().turkpatentUrl,
    devAllowLocal: !!isDev && process.env.TSP_REWARD_TEST === '1',
    gapMs: isDev && process.env.TSP_REWARD_TEST === '1' ? 300 : 1000,
    onResult: (brand, res) => {
      store.update('brandChecks', {}, (c) => { c[brandCore.normBrand(brand)] = { ...res, brand }; return c; });
      addAudit(store, { type: 'system', action: 'TÜRKPATENT marka sorgusu', initiator: 'user', status: res.status === 'unverified' ? 'warning' : 'info', message: `${brand}: ${res.reason}` });
      emit('opps-updated', {});
    },
    onState: (st) => {
      emit('brands-state', st);
      // Sorgu bittiğinde (durdurulmadıysa) bu sırada yeni gelen markalar varsa onları da sorgula
      if (prevBrandRunning && !st.running && !st.stoppedReason) autoBrandCheck(3000);
      prevBrandRunning = st.running;
    },
  });
  let prevBrandRunning = false;
  let autoBrandTimer = null;
  /** Hiç sorgulanmamış markalar (aynı markanın ürünleri tek sayılır). Doğrulanamayanlar otomatik tekrar denenmez. */
  const pendingBrands = () => memo('pendingBrands', ['opps', 'brandChecks'], pendingBrandsRaw);
  function pendingBrandsRaw() {
    const db = store.get('opps', null);
    if (!db) return [];
    const checks = store.get('brandChecks', {});
    const m = new Map();
    for (const it of Object.values(db.items)) {
      const b = opps.cleanBrand(it.brand, it.url, it.title);
      const k = b && brandCore.normBrand(b);
      if (k && !checks[k] && !m.has(k)) m.set(k, b);
    }
    return [...m.values()];
  }
  /**
   * Buybox listesinin zenginleştirilmiş görünümü: düzeltilmiş marka, marka sorgu sonucu ve tahmini kâr eklenmiş ürünler.
   * İki katman önbelleklenir: (1) marka düzeltme + tahmini kâr (ürünler/katalog/kâr ayarı değişince), (2) marka sorgu
   * sonuçlarının eklenmesi (her TÜRKPATENT sonucunda yalnızca bu ucuz katman yenilenir).
   */
  function oppsView(db) {
    const base = memo('oppsBase', ['opps', 'catalog', 'profit', 'orders'], () => {
      const comm = commissionByCategory();
      const pdata = profitData();
      const def = db.planDefaults || {};
      // Aynı markanın farklı yazımları ("KOTON", "Koton") tek marka: en çok görülen yazım kullanılır
      const cleaned = {}, seen = new Map();
      for (const [id, it] of Object.entries(db.items)) {
        const b = opps.cleanBrand(it.brand, it.url, it.title);
        cleaned[id] = b;
        if (!b) continue;
        const k = brandCore.normBrand(b);
        const m = seen.get(k) || new Map();
        m.set(b, (m.get(b) || 0) + 1); seen.set(k, m);
      }
      const canon = new Map([...seen].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
      const rows = [];
      for (const [id, it] of Object.entries(db.items)) {
        const k = cleaned[id] ? brandCore.normBrand(cleaned[id]) : null;
        rows.push({ id, key: k, item: { ...it, brand: k ? canon.get(k) || cleaned[id] : cleaned[id], est: estimateFor(it, (db.plans || {})[id], def, comm, pdata) } });
      }
      return { rows };
    });
    return memo('oppsView', ['opps', 'catalog', 'profit', 'orders', 'brandChecks'], () => {
      const checks = store.get('brandChecks', {});
      const view = { ...db, items: {} };
      for (const r of base.rows) view.items[r.id] = { ...r.item, brandCheck: (r.key && checks[r.key]) || null };
      return view;
    });
  }

  /** Ürün aktarılınca markaları kendiliğinden TÜRKPATENT'te sorgular (arka planda). */
  function autoBrandCheck(delay = 4000) {
    if (settings().bbAutoBrand === false || (isDev && process.env.TSP_NO_AUTO_BRAND === '1')) return;
    clearTimeout(autoBrandTimer);
    autoBrandTimer = setTimeout(() => {
      if (locked || brandChecker.state.running) return;
      const list = pendingBrands();
      if (list.length) brandChecker.run(list).catch(() => {});
    }, delay);
    if (autoBrandTimer.unref) autoBrandTimer.unref();
  }
  // Ürün listesinden komisyon (aynı kategorideki kendi ürünlerin) ve plan bilgisiyle tahmini kâr; eksik veri varsa kâr null
  function estimateFor(it, plan, def, commByCat, pdata) {
    const price = transfer.money(plan && plan.price) || it.buyboxPrice || it.price || null;
    const cost = (plan && plan.cost !== '' && plan.cost != null ? plan.cost : def && def.cost !== '' && def.cost != null ? def.cost : null);
    const costN = cost == null ? null : transfer.money(cost);
    const cat = (it.categories || []).map((c) => (c.id && commByCat.get(Number(c.id))) ?? (c.name && commByCat.get('n:' + String(c.name).toLocaleLowerCase('tr-TR')))).find((x) => x != null);
    if (!price) return { profit: null, marginPct: null, missing: ['price'] };
    const r = profitCore.calcProfit({ price, commissionPct: cat ?? null, cost: costN, vatPct: def && def.kdv != null ? def.kdv : undefined }, pdata.settings);
    return { profit: r.profit, marginPct: r.marginPct, missing: r.missing, commissionPct: cat ?? null, price, priceFrom: plan && plan.price ? 'plan' : it.buyboxPrice ? 'buybox' : 'list' };
  }
  function commissionByCategory() {
    const cat = store.get('catalog', null);
    const m = new Map();
    for (const v of (cat && cat.variants) || []) {
      if (v.categoryId == null || !Number.isFinite(v.commission)) continue;
      for (const k of [Number(v.categoryId), v.category ? 'n:' + String(v.category).toLocaleLowerCase('tr-TR') : null]) { if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(v.commission); }
    }
    const out = new Map();
    for (const [k, list] of m) { list.sort((a, b) => a - b); out.set(k, list[Math.floor(list.length / 2)]); }
    return out;
  }

  // ---------- Kara liste: bu ürünlere hiçbir değişiklik yapılmaz, ürün listelerinde görünmez ----------
  const blockedBarcodes = () => BL.blockedSet(store.get('blacklist', null), (store.get('catalog', null) || {}).variants || []);
  /** Kara listeyi ortak otomasyon sunucusuna iletir (grup otomasyonu da dokunmasın). Bağlı değilse sessizce atlar. */
  async function pushBlacklistToServer() {
    let c;
    try { c = autoClient(); } catch (_) { return { ok: false, notPaired: true }; }
    try {
      const barcodes = [...blockedBarcodes()];
      await c.putBlacklist(barcodes);
      store.set('blacklistServer', { at: Date.now(), count: barcodes.length, ok: true, sig: barcodes.slice().sort().join(',') });
      return { ok: true, count: barcodes.length };
    } catch (e) {
      store.set('blacklistServer', { at: Date.now(), ok: false, error: e.message });
      return { ok: false, error: e.message };
    }
  }

  /** Katalog eşitlenince (kara listedeki ürüne yeni beden gelmiş olabilir) ya da açılışta, liste değiştiyse sunucuya yeniden gönder. */
  function syncBlacklistIfChanged() {
    const bl = BL.normalize(store.get('blacklist', null));
    const last = store.get('blacklistServer', null);
    if (!bl.items.length && !(last && last.count)) return;
    const sig = [...blockedBarcodes()].sort().join(',');
    if (last && last.ok && last.sig === sig) return;
    pushBlacklistToServer().catch(() => {});
  }

  const jobs = new JobManager({ store, getClient, emit, blocked: blockedBarcodes });
  const productOps = new ProductOps({ store, getClient, emit });

  function catalogOrThrow() {
    const cat = store.get('catalog', null);
    if (!cat) throw new Error('Katalog boş. Önce ürünleri senkronize edin.');
    if (!cat.contents) throw new Error('Bu işlem için ürün içerik bilgisi gerekiyor. Lütfen bir kez "Senkronize et" yapın (yeni sürümle birlikte gelen alanlar).');
    return cat;
  }
  function planProductOp(a) {
    const cat = catalogOrThrow();
    switch (a.kind) {
      case 'copy': return planCopy({ catalog: cat, contentId: a.contentId, form: a.form || {} });
      case 'addVariant': return planAddVariants({ catalog: cat, contentId: a.contentId, form: a.form || {} });
      case 'archive': return planArchive({ catalog: cat, barcodes: a.barcodes, archived: a.archived !== false });
      case 'content': return planContentUpdate({ catalog: cat, contentId: a.contentId, title: a.title, description: a.description });
      default: throw new Error('Geçersiz işlem');
    }
  }
  const rewards = new RewardWatcher({ electron, store, emit, notify, devAllowLocal: !!isDev && process.env.TSP_REWARD_TEST === '1' });
  const labelPanelBase = isDev && process.env.TSP_PANEL_BASE ? process.env.TSP_PANEL_BASE : undefined;
  const labels = new LabelPrinter({ electron, partition: PARTITION, panelBase: labelPanelBase });
  let panelReadBusy = null;
  // Panel iskeleti tanısı (yalnızca düğme/kimlik adları; kişisel veri yok): toplu yol bulunamadığında veri klasörüne yazılır
  labels.onDiag = (key, data) => { try { store.set('panelDiag', { ...(store.get('panelDiag', {}) || {}), [key]: { at: Date.now(), ...data } }); } catch (_) { /* yoksay */ } };

  async function runCatalogSync(initiator = 'user') {
    if (syncing) return syncing;
    const client = requireClient();
    syncing = (async () => {
      const t0 = Date.now();
      try {
        const cat = await syncCatalog(client, store, { onProgress: (p) => emit('sync-progress', p) });
        addAudit(store, { type: 'sync', action: 'Ürün senkronizasyonu', initiator, status: 'success', message: `${cat.counts.products} ürün, ${cat.counts.variants} varyant (${Math.round((Date.now() - t0) / 1000)} sn)` });
        emit('catalog-updated', { syncedAt: cat.syncedAt });
        syncBlacklistIfChanged();
        return { products: cat.counts.products, variants: cat.counts.variants, syncedAt: cat.syncedAt };
      } catch (e) {
        addAudit(store, { type: 'sync', action: 'Ürün senkronizasyonu', initiator, status: 'failed', message: e.message });
        emit('sync-progress', { stage: 'error', message: e.message });
        throw e;
      } finally {
        syncing = null;
        emit('sync-progress', { stage: 'done' });
      }
    })();
    return syncing;
  }

  let financeSyncing = null;
  async function runFinanceSync(initiator = 'user', full = false) {
    if (financeSyncing) return financeSyncing;
    const client = requireClient();
    financeSyncing = (async () => {
      try {
        const prevFin = store.get('finance', null);
        const r = await finance.syncFinance(client, store, { full: full || !prevFin || prevFin.version !== 2, onProgress: (p) => emit('finance-progress', p) });
        addAudit(store, { type: 'sync', action: 'Cari hesap (hakediş) senkronizasyonu', initiator, status: r.errors ? 'warning' : 'success', message: `${r.records} hareket okundu` + (r.errors ? `, ${r.errors} işlem türü okunamadı` : '') });
        emit('finance-updated', {});
        return r;
      } catch (e) {
        addAudit(store, { type: 'sync', action: 'Cari hesap (hakediş) senkronizasyonu', initiator, status: 'failed', message: e.message });
        emit('finance-progress', { stage: 'done' });
        throw e;
      } finally { financeSyncing = null; }
    })();
    return financeSyncing;
  }
  async function runPanelPaymentsSync(initiator = 'user') {
    const text = await rewards.readPaymentDashboardText();
    const parsed = finance.parsePaymentDashboard(text);
    if (!parsed || !parsed.items.length) throw new Error('Ödemeler ekranında ödeme takvimi bulunamadı.');
    store.set('financePanel', { ...parsed, fetchedAt: nowIso() });
    pushPanelToServer();
    addAudit(store, { type: 'sync', action: 'Ödeme takvimi (satıcı paneli) okundu', initiator, status: 'success', message: `Bakiye ${parsed.balance ?? '—'} ₺, ${parsed.items.length} ödeme satırı` });
    emit('finance-updated', {});
    return { balance: parsed.balance, items: parsed.items.length };
  }
  /** Panelden okunan kesin ödeme takvimini ortak sunucuya gönderir (telefon aynı tutarları gösterir). Hata işi durdurmaz. */
  function pushPanelToServer() {
    const s = settings();
    const panel = store.get('financePanel', null);
    if (!s.autoToken || s.autoRole !== 'owner' || !panel || !Array.isArray(panel.items)) return Promise.resolve(false);
    return autoClient().putFinancePanel({ balance: panel.balance, earlyAvailable: panel.earlyAvailable, items: panel.items, fetchedAt: panel.fetchedAt })
      .then(() => true).catch(() => false);
  }
  /** Spam soruları satıcı panelinden bildirir (sunucudaki kuyruktan; sonuç sunucuya yazılır). */
  let qnaReporting = null;
  function runQnaReports(initiator = 'user') {
    if (qnaReporting) return qnaReporting;
    qnaReporting = (async () => {
      const s = settings();
      if (!s.autoToken) return { skipped: 'Ortak sunucuya bağlı değil' };
      const c = autoClient();
      const q = await c.qnaReportQueue();
      if (!q.items.length) return { reported: 0, failed: 0, skipped: null };
      let reported = 0, failed = 0;
      for (const item of q.items.slice(0, 5)) {
        const r = await rewards.withHiddenPage((isDev && process.env.TSP_PANEL_QNA_URL) || panelReport.QUESTIONS_URL, (win) => panelReport.reportOne((src) => win.webContents.executeJavaScript(src, true), item, q.reason));
        if (r.login) { addAudit(store, { type: 'question', action: 'Spam soru bildirimi', initiator, status: 'warning', message: 'Satıcı paneline giriş gerekli' }); return { skipped: 'Satıcı paneline giriş gerekli', reported, failed }; }
        await c.qnaReportResult(item.id, r.ok, r.message).catch(() => {});
        if (r.ok) reported++; else failed++;
        addAudit(store, { type: 'question', action: 'Spam soru bildirimi', initiator, status: r.ok ? 'success' : 'failed', title: item.productName || null, message: `${r.message} · "${String(item.text).slice(0, 80)}"` });
      }
      return { reported, failed, skipped: null };
    })().finally(() => { qnaReporting = null; });
    return qnaReporting;
  }

  function financeSummary(offset) {
    const pd = profitData();
    const cat = store.get('catalog', null);
    const vmap = new Map(((cat && cat.variants) || []).map((v) => [String(v.barcode), v]));
    const orders = store.get('orders', { items: [] }).items || [];
    // Tahmin: komisyon, kargo, hizmet bedeli ve stopaj düşülmüş tutar (maliyet gerekmez)
    const estimateFn = (o) => {
      const { items } = profitCore.orderShipmentItems(o, vmap, pd.costs, pd.settings, { ignoreCost: true });
      if (!items.length || items.some((i) => i.commissionPct == null)) return null;
      return profitCore.calcShipment(items, pd.settings).payout;
    };
    const panel = store.get('financePanel', null);
    const freshPanel = panel && Date.now() - Date.parse(panel.fetchedAt) < 3 * 86400000 ? panel : null;
    const byOrderNo = new Map(orders.map((o) => [String(o.orderNumber) + ':' + String(o.shipmentPackageId), o]));
    const packageFees = ({ orderNumber, shipmentPackageId, records }) => profitCore.estimatePackageFees({ order: byOrderNo.get(String(orderNumber) + ':' + String(shipmentPackageId)) || null, records, variantsByBarcode: vmap, costs: pd.costs, settings: pd.settings });
    return { ...finance.summarizeFinance(store.get('finance', null), { offset, orders, estimateFn, panel: freshPanel, packageFees }), panelStale: !!(panel && !freshPanel), syncing: !!financeSyncing };
  }

  async function runOrdersSync(initiator = 'user', days) {
    if (ordersSyncing) return ordersSyncing;
    const client = requireClient();
    ordersSyncing = (async () => {
      try {
        const r = await syncOrders(client, store, { days: days || settings().orderDays || 14 });
        emit('orders-updated', {});
        return r;
      } catch (e) {
        addAudit(store, { type: 'order', action: 'Sipariş senkronizasyonu', initiator, status: 'failed', message: e.message });
        throw e;
      } finally { ordersSyncing = null; }
    })();
    return ordersSyncing;
  }

  // ---------- Otomasyonlar ----------
  const scheduler = new Scheduler({
    store, emit, tickMs: 5000, // saniye bazlı otomasyon (yeni sipariş) için 5 sn hassasiyet
    definitions: [
      {
        id: 'catalog_sync', name: 'Ürün, stok ve fiyat senkronizasyonu', defaultIntervalMin: 15, minIntervalMin: 5, defaultEnabled: true, neverPause: true,
        description: 'Trendyol V2 ürün servislerinden tüm varyantları, stok ve fiyatları günceller. Yalnızca okuma yapar.',
        run: async () => { if (!getClient()) return { status: 'skipped', message: 'API bilgileri girilmemiş' }; const r = await runCatalogSync('automation'); return { message: `${r.variants} varyant güncellendi` }; },
      },
      {
        id: 'orders_sync', name: 'Sipariş senkronizasyonu', defaultIntervalMin: 5, minIntervalMin: 2, defaultEnabled: true, neverPause: true,
        description: 'Son siparişleri (V2 sipariş servisi) çeker. Yalnızca okuma yapar.',
        run: async () => {
          if (!getClient()) return { status: 'skipped', message: 'API bilgileri girilmemiş' };
          const before = new Set((store.get('orders', { items: [] }).items || []).map((o) => String(o.shipmentPackageId)));
          const r = await runOrdersSync('automation');
          const after = store.get('orders', { items: [] }).items || [];
          const fresh = before.size ? after.filter((o) => !before.has(String(o.shipmentPackageId)) && NEW_STATUSES.has(o.status)) : [];
          const watchOn = !!(((store.get('automations', {}) || {}).new_orders_watch || {}).enabled);
          if (fresh.length && !watchOn) notify({ level: 'info', title: 'Yeni sipariş', body: `${fresh.length} yeni sipariş paketi geldi.` });
          return { message: `${r.count} sipariş paketi okundu` + (fresh.length ? `, ${fresh.length} yeni` : '') };
        },
      },
      {
        id: 'new_orders_watch', name: 'Yeni sipariş bildirimi', unit: 'sec', defaultIntervalSec: 30, minIntervalSec: 20, defaultEnabled: true, neverPause: true,
        defaultSettings: { popup: true, sound: true },
        description: 'Yeni gelen siparişleri kısa aralıklarla tek istekle kontrol eder ve masaüstünde bildirim kartı gösterir. Yalnızca okuma yapar.',
        run: async ({ settings: cfg }) => {
          if (!getClient()) return { status: 'skipped', message: 'API bilgileri girilmemiş' };
          const r = await checkNewOrders(getClient(), store);
          if (r.primed) return { message: `İzleme başladı (${r.checked} bekleyen sipariş mevcut, bildirim gönderilmedi)` };
          announceOrders(r.fresh, { popup: true, sound: true, ...(cfg || {}) });
          return { message: r.fresh.length ? `${r.fresh.length} yeni sipariş bildirildi` : 'Yeni sipariş yok' };
        },
      },
      {
        id: 'pending_jobs', name: 'Bekleyen toplu işlem kontrolü', defaultIntervalMin: 2, minIntervalMin: 1, defaultEnabled: true,
        description: 'Gönderilmiş fiyat/stok işlemlerinin Trendyol sonucunu (batch) kontrol eder. Yeni istek göndermez.',
        run: async () => { if (!getClient()) return { status: 'skipped', message: 'API bilgileri girilmemiş' }; const r = await jobs.pollAllPending(); const n = await productOps.pollAllPending(); return { message: (r.checked || n) ? `${r.checked} fiyat/stok, ${n} ürün işlemi kontrol edildi` : 'Bekleyen iş yok' }; },
      },
      {
        id: 'questions_sync', name: 'Müşteri soruları', defaultIntervalMin: 15, minIntervalMin: 5, defaultEnabled: true, neverPause: true,
        description: 'Ürün sorularını çeker ve cevap bekleyen yeni soru gelince bildirir (3 iş günü içinde cevaplanmazsa kapanır). Yalnızca okuma yapar.',
        run: async () => {
          if (!getClient()) return { status: 'skipped', message: 'API bilgileri girilmemiş' };
          const before = new Set((store.get('questions', { items: [] }).items || []).map((q) => String(q.id)));
          const r = await support.syncQuestions(getClient(), store);
          const fresh = (store.get('questions', { items: [] }).items || []).filter((q) => q.status === 'WAITING_FOR_ANSWER' && !before.has(String(q.id)));
          if (before.size && fresh.length) notify({ level: 'info', title: 'Yeni müşteri sorusu', body: `${fresh.length} yeni soru cevap bekliyor: "${fresh[0].text.slice(0, 80)}"` });
          emit('questions-updated', {});
          return { message: `${r.waiting} soru cevap bekliyor` };
        },
      },
      {
        id: 'claims_sync', name: 'İade talepleri', defaultIntervalMin: 60, minIntervalMin: 15, defaultEnabled: true, neverPause: true,
        description: 'Son 90 günün iade taleplerini çeker (geçmiş birikerek saklanır); aksiyon bekleyen yeni iade gelince bildirir. Yalnızca okuma yapar.',
        run: async () => {
          if (!getClient()) return { status: 'skipped', message: 'API bilgileri girilmemiş' };
          const before = new Set((store.get('claims', { items: [] }).items || []).map((c) => String(c.id)));
          const r = await support.syncClaims(getClient(), store);
          const fresh = (store.get('claims', { items: [] }).items || []).filter((c) => !before.has(String(c.id)));
          if (before.size && fresh.length) notify({ level: 'warning', title: 'Yeni iade talebi', body: `${fresh.length} yeni iade talebi (sipariş ${fresh[0].orderNumber}).` });
          emit('claims-updated', {});
          return { message: `${r.count} iade, ${r.waiting} aksiyon bekliyor` };
        },
      },
      {
        id: 'finance_sync', name: 'Hakediş / cari hesap', defaultIntervalMin: 360, minIntervalMin: 60, defaultEnabled: true, neverPause: true,
        description: 'Cari hesap ekstresini (satış, iade, komisyon, kesinti faturaları, stopaj, ödemeler) son 10 hafta için okur. Yalnızca okuma yapar.',
        run: async () => {
          if (!getClient()) return { status: 'skipped', message: 'API bilgileri girilmemiş' };
          const r = await runFinanceSync('automation');
          let panelMsg = '';
          try { const p = await runPanelPaymentsSync('automation'); panelMsg = `, panel takvimi okundu (bakiye ${p.balance} ₺)`; } catch (e) { panelMsg = ' (panel takvimi okunamadı: ' + e.message.slice(0, 80) + ')'; }
          return { message: `${r.records} hareket okundu` + panelMsg };
        },
      },
      {
        id: 'payments_panel', name: 'Ödeme takvimi (satıcı paneli)', defaultIntervalMin: 60, minIntervalMin: 30, defaultEnabled: true, neverPause: true,
        description: 'Satıcı panelindeki Ödemeler ekranından yatacak tutarları ve ödeme günlerini okur. Panelde hiçbir şey değiştirmez; satıcı paneline bir kez giriş yapılmış olmalı.',
        run: async () => {
          if (!getClient()) return { status: 'skipped', message: 'API bilgileri girilmemiş' };
          const p = await runPanelPaymentsSync('automation');
          return { message: `Bakiye ${p.balance} ₺, ${p.items} ödeme satırı` };
        },
      },
      {
        id: 'qna_report', name: 'Spam soruları Trendyol\'a bildir', defaultIntervalMin: 15, minIntervalMin: 5, defaultEnabled: true, neverPause: true,
        description: 'Soru otomasyonunun reklam/bot yönlendirmesi olarak işaretlediği soruları satıcı panelinden "Sorun Bildir" ile bildirir. Ortak sunucuya bağlı olmalı ve satıcı paneline bir kez giriş yapılmış olmalı.',
        run: async () => {
          const r = await runQnaReports('automation');
          return r.skipped ? { status: 'skipped', message: r.skipped } : { message: `${r.reported} bildirildi, ${r.failed} bildirilemedi` };
        },
      },
      {
        id: 'low_stock', name: 'Düşük stok uyarısı', defaultIntervalMin: 60, minIntervalMin: 15, defaultEnabled: true,
        description: 'Yerel katalogda stoğu tükenen veya eşik altına düşen varyantlar için bildirim oluşturur.',
        run: async () => {
          const cat = store.get('catalog', null);
          if (!cat) return { status: 'skipped', message: 'Katalog henüz senkronize edilmedi' };
          const th = Number(settings().lowStock) || 5;
          const blk = blockedBarcodes(); // kara listedekiler için bildirim yok
          const low = cat.variants.filter((v) => v.status === 'onSale' && v.quantity != null && v.quantity <= th && !blk.has(String(v.barcode)));
          const prev = new Set(store.get('lowStockSeen', []));
          const fresh = low.filter((v) => !prev.has(v.barcode));
          store.set('lowStockSeen', low.map((v) => v.barcode));
          if (fresh.length) notify({ level: 'warning', title: 'Düşük stok', body: `${fresh.length} varyant ${th} adet veya altına düştü (ör. ${fresh[0].title} ${fresh[0].size || ''}).` });
          return { message: `${low.length} varyant eşik altında, ${fresh.length} yeni` };
        },
      },
      {
        id: 'reward_watch', name: 'Gelişim / seviye ödül izleyici', defaultIntervalMin: 60, minIntervalMin: 15, defaultEnabled: false, risk: 'high',
        description: 'Satıcı paneli oturumunuzla Gelişim Merkezi > Ödül Mağazası\'nı okur, yeni ödülleri bildirir. Ayarlarda açıkça izin verilirse kurala uyan ödülleri (ücretsiz veya belirlediğiniz puan sınırı içinde) tek seferlik alır. Her kontrol Gelişim Merkezi\'ni ziyaret eder.',
        run: async () => rewards.check({ trigger: 'schedule', allowAutoClaim: true }),
      },
    ],
  });

  // ---------- PIN deneme sınırı ----------
  function checkPinGuard(s) {
    const wait = (s.pinUntil || 0) - Date.now();
    if (wait > 0) {
      const e = new Error(`Çok fazla hatalı PIN denemesi. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.`);
      e.code = 'pin_locked'; e.data = { retryAfterMs: wait };
      throw e;
    }
  }
  function pinFailed(s, msg = 'PIN hatalı') {
    const fails = (s.pinFails || 0) + 1;
    const wait = pinWaitMs(fails);
    saveSettings({ pinFails: fails, pinUntil: wait ? Date.now() + wait : 0 });
    addAudit(store, { type: 'security', action: 'Hatalı PIN girişi', status: 'warning', message: wait ? `${fails}. hatalı deneme; ${Math.round(wait / 1000)} sn bekleme` : undefined });
    const left = PIN_FREE_ATTEMPTS - fails;
    const e = new Error(wait ? `${msg}. Çok fazla hatalı deneme: ${Math.round(wait / 1000)} saniye bekleyin.` : left > 0 && left <= 2 ? `${msg}. ${left} deneme hakkınız kaldı, sonra bekleme başlar.` : msg);
    e.code = wait ? 'pin_locked' : 'pin_wrong';
    if (wait) e.data = { retryAfterMs: wait };
    throw e;
  }

  // Hata mesajlarından maskelenecek gizli değerler (kayıtlı olanlar + bu çağrıda girilenler)
  function secretValues(args) {
    const s = settings();
    const out = [];
    for (const k of ['apiKey', 'apiSecret', 'autoToken']) { try { const v = secrets.decrypt(s[k]); if (v) out.push(v); } catch (_) { /* yoksay */ } }
    for (const k of ['apiKey', 'apiSecret', 'token', 'code']) if (args && typeof args[k] === 'string') out.push(args[k]);
    return out;
  }

  // Eski 'yerel AES' kayıtlarını Windows DPAPI'ye taşır (anahtarlar düz metin olarak hiçbir yere yazılmaz)
  function upgradeSecrets() {
    const s = settings();
    const patch = {};
    for (const k of ['apiKey', 'apiSecret', 'autoToken']) {
      if (!s[k] || secrets.isStrong(s[k])) continue;
      try { const u = secrets.upgrade(s[k]); if (u && u !== s[k]) patch[k] = u; } catch (_) { /* çözülemeyen eski kayıt: dokunma */ }
    }
    if (Object.keys(patch).length) {
      saveSettings(patch);
      clientCache = null;
      addAudit(store, { type: 'security', action: 'Kayıtlı anahtarlar Windows DPAPI şifrelemesine taşındı', status: 'success' });
    }
  }

  // ---------- IPC API ----------
  const openMethods = new Set(['app.status', 'app.unlock']);

  /** Etiketi basılan siparişleri kaydeder ("Daha önce yazdırılmış!" uyarısı için). 45 günden eskiler silinir. */
  /**
   * Etiketi yazıcıya giden siparişleri Trendyol'da "İşleme Al" (Picking) yapar — ayar açıksa (labelAutoPick, varsayılan açık).
   * Yalnızca yeni paketler; resmi API uç noktasıyla. Sonuç işlem geçmişine yazılır ve yerel sipariş durumu güncellenir.
   */
  async function pickAfterPrint(orderNumbers) {
    if ((store.get('settings', {}) || {}).labelAutoPick === false) return null;
    const client = getClient();
    if (!client) return { ok: 0, failed: (orderNumbers || []).length, skipped: 0, message: 'Trendyol API bağlantısı yok; işleme alınmadı' };
    const items = (store.get('orders', { items: [] }) || {}).items || [];
    const results = await pickCore.pickPackages({ client, items, orderNumbers });
    if (results.some((r) => r.ok)) {
      store.update('orders', { items: [] }, (cur) => ({ ...cur, items: pickCore.markPicked((cur && cur.items) || [], results).items }));
      emit('orders-updated', {});
    }
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok && !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    const message = `${ok}/${results.length} paket işleme alındı (etiketi yazdırıldıktan sonra)${failed.length ? ` · alınamadı: ${failed.slice(0, 5).map((r) => `${r.orderNumber} (${r.message})`).join(', ')}` : ''}${skipped.length ? ` · ${skipped.length} paket zaten işlemde ya da kargoda` : ''}`;
    addAudit(store, { type: 'order', action: 'Otomatik İşleme Al', initiator: 'user', status: failed.length ? (ok ? 'warning' : 'failed') : 'success', message });
    return { ok, failed: failed.length, skipped: skipped.length, message, results: results.map((r) => ({ orderNumber: r.orderNumber, ok: r.ok, skipped: !!r.skipped, message: r.message })) };
  }

  function recordLabelPrints(orderNumbers, kind, mode) {
    const now = Date.now();
    const cur = store.get('labelPrints', {}) || {};
    const next = {};
    for (const [k, v] of Object.entries(cur)) if (v && now - v.at < 45 * 86400000) next[k] = v;
    for (const n of orderNumbers || []) {
      const k = String(n); const prev = next[k];
      next[k] = { at: now, count: (prev ? prev.count : 0) + 1, kind, mode };
    }
    store.set('labelPrints', next);
    emit('labels-history', {});
  }

  // ---------- Uzaktan güncelleme ----------
  // Geliştirici denemelerinde yalnızca TSP_UPDATE_BASE verilirse çalışır (gerçek güncelleme deposuna gidilmez)
  const updateBase = isDev ? (process.env.TSP_UPDATE_BASE || null) : undefined;
  const updater = new Updater({
    electron, appDir: (() => { try { return app.getAppPath(); } catch (_) { return ''; } })(), base: updateBase || undefined, emit, isDev,
    restart: () => { try { app.relaunch(); } catch (_) { /* yoksay */ } if (!(isDev && process.env.TSP_UPDATE_NO_RELAUNCH === '1')) app.exit(0); },
  });
  // Yalnızca kurulu kopyada (…/resources/app) ya da deneme sunucusu verilmişse açık: testler ve kaynak klasörü gerçek depoya gitmez
  const updateEnabled = isDev ? !!updateBase : !!updater.target();
  let updateNotified = 0;
  async function checkUpdate(force) {
    if (!updateEnabled) return updater.status();
    const st = await updater.check({ force });
    if (st.available && st.canInstall && st.latest && updateNotified !== st.latest.build) {
      updateNotified = st.latest.build;
      try { notify({ level: 'info', title: 'Yeni sürüm hazır: ' + st.latest.version, body: st.latest.notes || 'Sağ üstteki "Güncelle" düğmesinden kurabilirsiniz.' }); } catch (_) { /* yoksay */ }
    }
    return st;
  }

  const api = {
    'app.status': () => {
      const s = settings();
      return {
        locked, version: app.getVersion(), configured: !!(s.sellerId && s.apiKey && s.apiSecret), env: s.env, sellerId: s.sellerId || null,
        dataDir: store.dir, encryption: secrets.available() ? 'Windows DPAPI' : 'yerel AES', hasPin: !!s.pin, isDev: !!isDev,
        devBaseUrl: isDev && process.env.TRENDYOL_BASE_URL ? process.env.TRENDYOL_BASE_URL : null,
        // Kurulum sihirbazı ilk açılışta kendiliğinden çıkar; geliştirici denemelerinde yalnızca istenirse (TSP_WIZARD=1)
        autoWizard: !isDev || process.env.TSP_WIZARD === '1',
        autoSync: (() => { const a = scheduler.state().catalog_sync; return a ? { enabled: !!a.enabled, intervalMin: a.intervalMin } : null; })(),
      };
    },
    'update.status': () => ({ ...updater.status(), enabled: updateEnabled }),
    'update.check': async () => ({ ...(await checkUpdate(true)), enabled: updateEnabled }),
    // Kurulum yalnızca kullanıcı açıkça onaylayınca: indir → doğrula → dosyaları yaz → yeniden başlat
    'update.install': async ({ confirm } = {}) => {
      if (confirm !== true) throw new Error('Güncelleme onaylanmadı.');
      if (!updateEnabled) throw new Error('Güncelleme bu kopyada kapalı.');
      await updater.download();
      addAudit(store, { type: 'system', action: 'Uygulama güncellendi', initiator: 'user', status: 'success', message: `Sürüm ${updater.status().version || '-'} → ${updater.state.latest.version}` });
      return updater.install();
    },
    'app.unlock': ({ pin }) => {
      const s = settings();
      if (!s.pin) { locked = false; return true; }
      checkPinGuard(s);
      if (!verifyPin(pin || '', s.pin)) { pinFailed(s); }
      saveSettings({ pinFails: 0, pinUntil: 0 });
      locked = false;
      return true;
    },
    'app.lock': () => { if (settings().pin) locked = true; return locked; },
    'app.setPin': ({ current, next }) => {
      const s = settings();
      if (s.pin) { checkPinGuard(s); if (!verifyPin(current || '', s.pin)) pinFailed(s, 'Mevcut PIN hatalı'); saveSettings({ pinFails: 0, pinUntil: 0 }); }
      if (next && !/^\d{4,8}$/.test(next)) throw new Error('PIN 4–8 haneli rakam olmalı');
      saveSettings({ pin: next ? hashPin(next) : null });
      addAudit(store, { type: 'security', action: next ? 'Uygulama PIN\'i ayarlandı' : 'Uygulama PIN\'i kaldırıldı', status: 'info' });
      return true;
    },
    'app.openExternal': ({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; },
    'app.openDataDir': () => { shell.openPath(store.dir); return true; },

    'settings.get': () => {
      const s = settings();
      return { ...s, apiKey: undefined, apiSecret: undefined, pin: undefined, autoToken: undefined, pinFails: undefined, pinUntil: undefined, hasApiKey: !!s.apiKey, hasApiSecret: !!s.apiSecret, hasPin: !!s.pin, autoPaired: !!s.autoToken };
    },

    // ---------- Ortak otomasyon sunucusu ----------
    'auto.state': () => {
      const s = settings();
      return { paired: !!s.autoToken, url: s.autoServerUrl || DEFAULT_SERVER, deviceId: s.autoDeviceId, role: s.autoRole, hasLocalCredentials: !!(s.apiKey && s.apiSecret && s.sellerId) };
    },
    'auto.pair': async ({ url, setupCode, pairCode, name, sendCredentials }) => {
      const s = settings();
      const baseUrl = String(url || s.autoServerUrl || DEFAULT_SERVER).trim();
      const c = new AutoServerClient({ baseUrl, fetchImpl: (a, b) => fetch(a, b) });
      const r = await c.pair({ setupCode: setupCode ? String(setupCode).trim() : undefined, pairCode: pairCode ? String(pairCode).replace(/\s/g, '') : undefined, name: String(name || require('os').hostname()).slice(0, 60), platform: 'windows' });
      saveSettings({ autoServerUrl: c.baseUrl, autoToken: secrets.encrypt(r.token), autoDeviceId: r.deviceId, autoRole: r.role });
      addAudit(store, { type: 'security', action: 'Ortak otomasyon sunucusuna bağlanıldı', status: 'success', message: `${c.baseUrl} · ${r.role === 'owner' ? 'ana cihaz' : 'ek cihaz'}` });
      let credentials = null;
      if (r.role === 'owner' && sendCredentials) credentials = await api['auto.pushCredentials']();
      if (r.role === 'owner') pushPanelToServer();
      return { ...api['auto.state'](), credentials };
    },
    'auto.unpair': () => {
      saveSettings({ autoToken: null, autoDeviceId: null, autoRole: null });
      addAudit(store, { type: 'security', action: 'Ortak otomasyon sunucusu bağlantısı bu bilgisayardan kaldırıldı', status: 'info' });
      return api['auto.state']();
    },
    'auto.pushCredentials': async () => {
      const s = settings();
      if (!s.apiKey || !s.apiSecret || !s.sellerId) throw new Error('Önce Ayarlar > Trendyol bağlantısı bölümünden API bilgilerini girin');
      const r = await autoClient().putCredentials({ sellerId: s.sellerId, apiKey: secrets.decrypt(s.apiKey), apiSecret: secrets.decrypt(s.apiSecret), env: s.env });
      addAudit(store, { type: 'security', action: 'Trendyol API bilgileri ortak sunucuya şifreli gönderildi', status: 'success', message: `Satıcı ${s.sellerId}` });
      return r;
    },
    'qna.reportNow': () => runQnaReports('user'),
    'auto.call': async ({ method, args }) => {
      if (!AUTO_METHODS.has(method)) throw new Error('İzin verilmeyen sunucu işlemi: ' + method);
      const c = autoClient();
      const res = await c[method](...(Array.isArray(args) ? args : []));
      if (method === 'saveQnaConfig') addAudit(store, { type: 'question', action: 'Soru otomasyonu kuralları kaydedildi', status: 'success', message: 'Mod: ' + ({ off: 'kapalı', simulate: 'simülasyon', auto: 'tam otomatik' })[res && res.mode] });
      if (['activate', 'reopen', 'pause', 'verify', 'createRule', 'deleteRule'].includes(method)) {
        addAudit(store, { type: 'automation', action: 'Grup otomasyonu: ' + ({ activate: 'kural etkinleştirildi', reopen: 'ürünler yeniden açıldı', pause: 'kural durduruldu', verify: 'işlem doğrulandı', createRule: 'kural oluşturuldu', deleteRule: 'kural silindi' })[method], status: 'success' });
      }
      return res;
    },
    'settings.save': (patch) => {
      const allowed = ['setupDone', 'theme', 'lowStock', 'unusualPct', 'runInTray', 'startWithWindows', 'rewardClaimTexts', 'rewardAutoClaim', 'rewardRequireFree', 'rewardMaxPerRun', 'orderDays', 'rewardAutoPoints', 'rewardMaxPoints', 'rewardMinBalance', 'rewardConfirmTexts', 'labelOutput', 'labelPrinterA4', 'labelPrinterSticker', 'labelPrintAck', 'labelSticker', 'labelMainCargo', 'labelMainCargoName', 'labelAutoPick', 'appearance', 'storeName', 'storeLogo'];
      const clean = {};
      for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
      if (clean.lowStock != null && !(Number.isInteger(Number(clean.lowStock)) && clean.lowStock >= 0 && clean.lowStock <= 1000)) throw new Error('Düşük stok eşiği 0–1000 olmalı');
      if (clean.unusualPct != null && !(Number(clean.unusualPct) > 0 && Number(clean.unusualPct) <= 500)) throw new Error('Olağandışı değişim eşiği 1–500 olmalı');
      if (clean.rewardMaxPerRun != null && !(Number(clean.rewardMaxPerRun) >= 1 && Number(clean.rewardMaxPerRun) <= 5)) throw new Error('Tek seferde en fazla 1–5 ödül');
      if (clean.orderDays != null && !(Number(clean.orderDays) >= 1 && Number(clean.orderDays) <= 30)) throw new Error('Sipariş geçmişi 1–30 gün olmalı');
      if (clean.rewardMaxPoints != null && !(Number.isInteger(Number(clean.rewardMaxPoints)) && clean.rewardMaxPoints >= 0 && clean.rewardMaxPoints <= 1000000)) throw new Error('Ödül başına en fazla puan 0–1.000.000 olmalı');
      if (clean.rewardMinBalance != null && !(Number.isInteger(Number(clean.rewardMinBalance)) && clean.rewardMinBalance >= 0)) throw new Error('Kalacak en az puan 0 veya pozitif olmalı');
      if (clean.theme != null && !['light', 'dark', 'system'].includes(clean.theme)) throw new Error('Tema açık, koyu veya sistem olmalı');
      if (clean.labelOutput != null && !['print', 'pdf'].includes(clean.labelOutput)) throw new Error('Etiket çıktısı yazıcı veya PDF olmalı');
      for (const k of ['labelPrinterA4', 'labelPrinterSticker']) if (clean[k] != null) clean[k] = String(clean[k]).slice(0, 200);
      if (clean.labelSticker != null) clean.labelSticker = require('./label-printer').normalizeSticker(clean.labelSticker);
      if (clean.labelPrintAck != null) clean.labelPrintAck = !!clean.labelPrintAck;
      if (clean.labelMainCargo != null) clean.labelMainCargo = String(clean.labelMainCargo).toLocaleLowerCase('tr-TR').slice(0, 80);
      if (clean.labelMainCargoName != null) clean.labelMainCargoName = String(clean.labelMainCargoName).slice(0, 80);
      if (clean.labelAutoPick != null) clean.labelAutoPick = !!clean.labelAutoPick;
      if (clean.storeName != null) clean.storeName = String(clean.storeName).replace(/\s+/g, ' ').trim().slice(0, 40);
      if (clean.storeLogo != null) {
        // Mağaza fotoğrafı arayüzde küçültülmüş resim olarak gelir; yalnızca resim verisi ve makul boyut kabul edilir
        const v = String(clean.storeLogo);
        if (v && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) throw new Error('Mağaza fotoğrafı PNG, JPG veya WEBP olmalı');
        if (v.length > 400000) throw new Error('Mağaza fotoğrafı çok büyük');
        clean.storeLogo = v;
      }
      if (clean.appearance !== undefined) { const { mode: _m, ...ap } = themeCore.normalizeAppearance(clean.appearance); clean.appearance = ap; }
      if (clean.rewardConfirmTexts) clean.rewardConfirmTexts = clean.rewardConfirmTexts.map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
      if (clean.rewardClaimTexts) clean.rewardClaimTexts = clean.rewardClaimTexts.map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
      saveSettings(clean);
      if ((clean.theme !== undefined || clean.appearance !== undefined) && onTheme) { try { onTheme(clean.theme !== undefined ? clean.theme : undefined); } catch (_) { /* pencere yoksa yoksay */ } }
      if (clean.setupDone !== undefined) clean.setupDone = !!clean.setupDone;
      if (clean.startWithWindows !== undefined) {
        try { app.setLoginItemSettings({ openAtLogin: !!clean.startWithWindows, args: ['--hidden'] }); } catch (_) { /* yoksay */ }
      }
      if (clean.rewardAutoClaim !== undefined) addAudit(store, { type: 'reward', action: 'Otomatik ödül talebi ' + (clean.rewardAutoClaim ? 'açıldı' : 'kapatıldı'), status: 'info' });
      if (clean.rewardAutoPoints !== undefined) addAudit(store, { type: 'reward', action: 'Puanla otomatik ödül alma ' + (clean.rewardAutoPoints ? 'açıldı' : 'kapatıldı'), status: 'info', message: `En fazla ${settings().rewardMaxPoints} puan/ödül, en az ${settings().rewardMinBalance} puan kalsın` });
      return api['settings.get']();
    },
    'settings.saveCredentials': async ({ sellerId, apiKey, apiSecret, env }) => {
      const s = settings();
      const sid = String(sellerId || '').trim();
      if (!/^\d+$/.test(sid)) throw new Error('Satıcı ID yalnızca rakamlardan oluşmalı');
      const e = env === 'stage' ? 'stage' : 'prod';
      const key = apiKey ? String(apiKey).trim() : null;
      const sec = apiSecret ? String(apiSecret).trim() : null;
      const nextKey = key ? secrets.encrypt(key) : s.apiKey;
      const nextSec = sec ? secrets.encrypt(sec) : s.apiSecret;
      if (!nextKey || !nextSec) throw new Error('API Key ve API Secret gerekli');
      // Kaydetmeden önce bağlantıyı test et
      const test = new TrendyolClient({ sellerId: sid, apiKey: key || secrets.decrypt(s.apiKey), apiSecret: sec || secrets.decrypt(s.apiSecret), env: e, baseUrl: isDev && process.env.TRENDYOL_BASE_URL ? process.env.TRENDYOL_BASE_URL : undefined, retryDelays: [1000] });
      const r = await test.testConnection();
      const changedStore = s.sellerId && (s.sellerId !== sid || s.env !== e);
      saveSettings({ sellerId: sid, env: e, apiKey: nextKey, apiSecret: nextSec, apiKeyHint: key ? '••••' + key.slice(-4) : s.apiKeyHint });
      clientCache = null;
      if (changedStore) {
        // Farklı mağaza/ortam: eski önbellek verisini karıştırma
        store.set('catalog', null, { immediate: true });
        store.set('orders', { items: [] }, { immediate: true });
      }
      addAudit(store, { type: 'security', action: 'API bilgileri güncellendi', status: 'success', message: `Satıcı ${sid}, ortam ${e === 'prod' ? 'Canlı' : 'Test'}` });
      return { ok: true, totalProducts: r.totalProducts };
    },
    'settings.testConnection': async () => {
      const t0 = Date.now();
      const r = await requireClient().testConnection();
      return { ...r, ms: Date.now() - t0 };
    },
    'settings.clearCredentials': () => {
      saveSettings({ apiKey: null, apiSecret: null, apiKeyHint: null });
      clientCache = null;
      addAudit(store, { type: 'security', action: 'API bilgileri silindi', status: 'info' });
      return true;
    },

    'catalog.get': ({ includeBlocked } = {}) => {
      const c = store.get('catalog', null);
      if (!c) return { variants: [], counts: null, syncedAt: null, unapproved: [], unapprovedCounts: {}, conflicts: [], blockedCount: 0 };
      if (includeBlocked) return c;
      // Kara listedeki ürünler listelerde görünmez
      const bl = blockedBarcodes();
      if (!bl.size) return { ...c, blockedCount: 0 };
      const variants = c.variants.filter((v) => !bl.has(String(v.barcode)));
      return { ...c, variants, counts: summarize(variants), conflicts: (c.conflicts || []).filter((x) => !bl.has(String(x.barcode))), blockedCount: c.variants.length - variants.length };
    },
    'catalog.sync': () => runCatalogSync('user'),
    'catalog.syncing': () => !!syncing,

    'plan.price': ({ barcodes, cfg }) => {
      const variants = pickVariants(barcodes);
      const s = settings();
      const pd = profitData();
      // Zarar kilidi ana süreçte, kayıtlı maliyetlerden hesaplanır (arayüzden gelen değere güvenilmez)
      const minPrices = {};
      if (cfg && cfg.blockLoss) {
        for (const v of variants) {
          const rc = profitCore.resolveCost(v, pd.costs);
          if (rc.cost == null || v.commission == null) continue;
          const be = profitCore.priceForMargin({ commissionPct: v.commission, vatPct: v.vatRate, cost: rc.cost, desi: rc.desi }, pd.settings, 0);
          if (be != null) minPrices[v.barcode] = be;
        }
      }
      const { blockLoss, minPrices: _ignored, ...rest } = cfg || {};
      const plan = buildPricePlan(variants, { unusualPct: Number(s.unusualPct) || 30, ...rest, minPrices: blockLoss ? minPrices : null });
      const byBc = new Map(variants.map((v) => [v.barcode, v]));
      let withCost = 0;
      for (const r of plan.rows) {
        const v = byBc.get(r.barcode);
        if (!v || r.newSale == null) continue;
        const p = profitCore.variantProfit(v, pd.costs, pd.settings, r.newSale);
        if (p.profit != null) { withCost++; r.profit = p.profit; r.marginPct = p.marginPct; }
        if (minPrices[r.barcode] != null) r.breakEven = minPrices[r.barcode];
      }
      plan.summary.withCost = withCost;
      plan.summary.lossBlocked = plan.rows.filter((r) => r.error && /^Zarar kilidi/.test(r.error)).length;
      plan.summary.lossRows = plan.rows.filter((r) => r.status === 'ok' && r.profit != null && r.profit < 0).length;
      return plan;
    },

    // ---------- Hakediş / cari hesap ----------
    'finance.sync': ({ full } = {}) => runFinanceSync('user', !!full),
    'finance.summary': ({ offset } = {}) => { const o = Number(offset) || 0; return memo('finance.summary:' + o, ['finance', 'financePanel', 'orders', 'catalog', 'profit'], () => financeSummary(o), 60000); },
    'finance.records': () => (store.get('finance', { records: [] }).records || []).map(finance.normalizeRecord),
    'finance.panelSync': () => runPanelPaymentsSync('user'),

    // ---------- Kâr hesaplayıcı ----------
    'profit.get': () => profitData(),
    'profit.updateRates': async () => {
      const url = await rewards.fetchCargoPdfUrl();
      const res = await fetch(url);
      if (!res.ok) throw new Error('Kargo fiyat listesi indirilemedi (' + res.status + ')');
      const buf = new Uint8Array(await res.arrayBuffer());
      const zlib = require('zlib');
      const parsed = await parseCargoPdf(buf, async (b) => { try { return new Uint8Array(zlib.inflateSync(Buffer.from(b))); } catch (_) { return new Uint8Array(zlib.inflateSync(Buffer.from(b), { finishFlush: zlib.constants.Z_SYNC_FLUSH })); } });
      const rows = Object.keys(parsed.rows).map(Number).sort((a, b) => a - b).map((d) => parsed.rows[d]);
      if (!parsed.carriers.includes('TEX') || rows.length < 31) throw new Error('Kargo fiyat listesi beklenen yapıda değil; mevcut liste korunuyor.');
      const cur = store.get('profit', {});
      const rates = { source: 'Trendyol satıcı paneli · Güncel Kargo Fiyatları', effectiveDate: parsed.effectiveDate, carriers: parsed.carriers, rows, url, fetchedAt: nowIso() };
      store.set('profit', { ...cur, rates }, { immediate: true });
      addAudit(store, { type: 'sync', action: 'Kargo fiyat listesi güncellendi', initiator: 'user', status: 'success', message: `${parsed.effectiveDate || 'tarih yok'} tarihli liste, ${parsed.carriers.length} firma, 0–${rows.length - 1} desi` });
      emit('profit-updated', {});
      return profitData();
    },
    'profit.saveSettings': ({ settings: ps }) => {
      const cur = store.get('profit', {});
      const { _rates, _storeFast, _sameDayShare, ...clean } = ps || {};
      const { _rates: _r2, _storeFast: _sf, _sameDayShare: _ss, ...next } = profitCore.normalizeProfitSettings({ ...(cur.settings || {}), ...clean });
      store.set('profit', { ...cur, settings: next }, { immediate: true });
      emit('profit-updated', {});
      return profitData();
    },
    'profit.setCosts': ({ entries }) => {
      if (!Array.isArray(entries)) throw new Error('Geçersiz maliyet listesi');
      const cur = store.get('profit', {});
      const costs = { models: { ...((cur.costs || {}).models || {}) }, barcodes: { ...((cur.costs || {}).barcodes || {}) } };
      const val = (x, max) => { if (x === '' || x == null) return null; const n = Number(String(x).replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > max) throw new Error('Geçersiz değer: ' + x); return Math.round(n * 100) / 100; };
      let n = 0;
      for (const e of entries.slice(0, 50000)) {
        const key = e.barcode ? String(e.barcode) : e.model ? String(e.model) : null;
        if (!key) continue;
        const bucket = e.barcode ? costs.barcodes : costs.models;
        const prev = bucket[key] || {};
        const item = { ...prev };
        if ('cost' in e) item.cost = val(e.cost, 1e6);
        if ('desi' in e) item.desi = val(e.desi, 1000);
        if (item.cost == null && item.desi == null) delete bucket[key]; else bucket[key] = { ...item, updatedAt: nowIso() };
        n++;
      }
      store.set('profit', { ...cur, costs }, { immediate: true });
      emit('profit-updated', {});
      return { updated: n, ...profitData() };
    },
    'profit.orders': ({ days } = {}) => {
      const d = Number(days) || 30;
      return memo('profit.orders:' + d, ['orders', 'catalog', 'profit'], () => {
        const pd = profitData();
        const cat = store.get('catalog', null);
        const vmap = new Map(((cat && cat.variants) || []).map((v) => [String(v.barcode), v]));
        const all = store.get('orders', { items: [] }).items || [];
        const cutoff = Date.now() - d * 86400000;
        const list = all.filter((o) => { const t = typeof o.orderDate === 'number' ? o.orderDate : Date.parse(o.orderDate); return !Number.isFinite(t) || t >= cutoff; });
        return profitCore.ordersProfit(list, vmap, pd.costs, pd.settings);
      }, 60000);
    },
    'plan.stock': ({ barcodes, cfg }) => buildStockPlan(pickVariants(barcodes), cfg),
    // Fiyat + stok birlikte: iki plan ayrı ayrı (zarar kilidi dahil) hesaplanıp birleştirilir
    'plan.both': ({ barcodes, cfg }) => {
      if (!cfg || !cfg.price || !cfg.stock) throw new Error('Fiyat ve stok ayarları eksik');
      const plan = mergePriceStockPlans(api['plan.price']({ barcodes, cfg: cfg.price }), buildStockPlan(pickVariants(barcodes), cfg.stock));
      return plan;
    },

    'jobs.create': ({ type, barcodes, cfg, description, meta }) => {
      // Plan, arayüzden gelen satırlara güvenilmeden ana süreçte yeniden hesaplanır.
      const plan = type === 'price' ? api['plan.price']({ barcodes, cfg }) : type === 'both' ? api['plan.both']({ barcodes, cfg }) : api['plan.stock']({ barcodes, cfg });
      const job = jobs.createFromPlan({ type, plan, description, meta });
      return jobs.get(job.id);
    },
    'jobs.execute': ({ id }) => {
      const job = jobs.get(id);
      if (!job) throw new Error('İş bulunamadı');
      // Hataları yakalayıp hemen döndür; ilerleme olaylarla gelir
      const p = jobs.execute(id);
      return p.then((r) => ({ ok: true, job: r })).catch((e) => { throw e; });
    },
    'jobs.list': ({ limit } = {}) => jobs.list({ limit }),
    'jobs.get': ({ id }) => jobs.get(id),
    'jobs.cancel': ({ id }) => jobs.cancelDraft(id),
    'jobs.verify': ({ id }) => jobs.verifyUncertain(id),
    'jobs.recheck': async ({ id }) => { await jobs.postVerify(id, { once: true }); return jobs.get(id); },
    'jobs.poll': ({ id }) => jobs.pollJob(id, { timeoutMs: 0 }),
    'jobs.retry': ({ id }) => jobs.get(jobs.createRetryJob(id).id),
    'jobs.revert': ({ id, barcodes } = {}) => jobs.get(jobs.createRevertJob(id, Array.isArray(barcodes) ? barcodes.map(String).slice(0, 5000) : null).id),
    // Geri alma seçimi için: işin başarılı kalemleri + katalogdaki şu anki değer (işlemden sonra değişmiş mi?)
    'jobs.revertCandidates': ({ id } = {}) => {
      const job = jobs.get(id);
      if (!job) throw new Error('İş bulunamadı');
      const cat = store.get('catalog', { variants: [], syncedAt: null }) || { variants: [] };
      const byBc = new Map((cat.variants || []).map((v) => [v.barcode, v]));
      const items = job.items.filter((i) => i.status === 'success').map((i) => {
        const v = byBc.get(i.barcode);
        const cur = v ? { quantity: v.quantity, salePrice: v.salePrice } : null;
        const changed = !cur ? null : ((i.new.quantity != null && cur.quantity !== i.new.quantity) || (i.new.salePrice != null && Math.abs((cur.salePrice || 0) - i.new.salePrice) > 0.009));
        return { barcode: i.barcode, title: i.title, size: i.size, old: i.old, new: i.new, current: cur, changed };
      });
      return { type: job.type, items, catalogSyncedAt: cat.syncedAt || null };
    },

    'product.detail': ({ contentId }) => {
      const cat = store.get('catalog', null);
      if (!cat) throw new Error('Katalog boş');
      const variants = cat.variants.filter((v) => String(v.contentId) === String(contentId));
      const content = cat.contents ? cat.contents[contentId] : null;
      return { content, variants, needsResync: !cat.contents };
    },
    'product.variantAttributes': async ({ categoryId }) => {
      // Kategorinin varyant belirleyen nitelikleri (ör. Beden) ve izin verilen değerleri. 7 gün önbellek.
      const client = requireClient();
      const cache = store.get('categoryCache', {});
      const hit = cache[categoryId];
      if (hit && Date.now() - hit.t < 7 * 86400000) return hit.data;
      const res = await client.getCategoryAttributes(categoryId);
      const attrs = ((res && res.categoryAttributes) || []).filter((a) => a && a.varianter && a.attribute);
      const out = [];
      for (const a of attrs) {
        let values = [];
        if (!a.allowCustom) {
          const vr = await client.getCategoryAttributeValues(categoryId, a.attribute.id);
          values = ((vr && vr.content) || []).map((x) => ({ id: x.attributeValueId ?? x.id, name: x.attributeValue ?? x.name })).filter((x) => x.id != null);
          if (!values.length && Array.isArray(a.attributeValues)) values = a.attributeValues.map((x) => ({ id: x.id, name: x.name }));
        }
        out.push({ attributeId: a.attribute.id, name: a.attribute.name, allowCustom: !!a.allowCustom, required: !!a.required, values });
      }
      cache[categoryId] = { t: Date.now(), data: out };
      store.set('categoryCache', cache);
      return out;
    },
    'product.plan': (a) => planProductOp(a),
    'product.run': async (a) => {
      // Plan ana süreçte yeniden hesaplanır; arayüzden gelen hazır kalemlere güvenilmez.
      const plan = planProductOp(a);
      if (!plan.ok) { const e = new Error(plan.errors.join(' · ')); throw e; }
      // Kara listedeki ürünlere ürün işlemi (arşiv, bilgi güncelleme, varyant ekleme, kopyalama) yapılmaz
      {
        const vs = (store.get('catalog', null) || {}).variants || [];
        const bl = blockedBarcodes();
        const blC = BL.blockedContentIds(store.get('blacklist', null), vs);
        const hit = (a.contentId != null && blC.has(String(a.contentId))) || (Array.isArray(a.barcodes) && a.barcodes.some((b) => bl.has(String(b))));
        if (hit) throw new Error('Bu ürün kara listede; üzerinde işlem yapılmaz. Önce kara listeden çıkarın.');
      }
      const op = await productOps.run({ kind: a.kind, items: plan.items, title: a.title || null, meta: { contentId: a.contentId || null } });
      const ok = op.items.filter((i) => i.status === 'success').map((i) => i.key);
      if (a.kind === 'archive' && ok.length) {
        const archived = a.archived !== false;
        patchCatalog(store, ok.map((b) => [b, { archived, status: archived ? 'archived' : 'notOnSale' }]));
        emit('catalog-updated', {});
      }
      if (a.kind === 'content' && ok.length) {
        const cat = store.get('catalog', null);
        const it = plan.items[0];
        if (cat && cat.contents && cat.contents[a.contentId]) {
          if (it.title) cat.contents[a.contentId].title = it.title;
          if (it.description) cat.contents[a.contentId].description = it.description;
          if (it.title) cat.variants.forEach((v) => { if (String(v.contentId) === String(a.contentId)) { v.title = it.title; delete v._hay; } });
          store.set('catalog', cat);
          emit('catalog-updated', {});
        }
      }
      if ((a.kind === 'copy' || a.kind === 'addVariant') && ok.length) {
        // Yeni ürünler onay sürecine girer; listede görünmeleri için arka planda senkronize et
        runCatalogSync('system').catch(() => {});
      }
      return op;
    },
    'product.ops': ({ limit = 100 } = {}) => productOps.list().slice(-limit).reverse().map(({ items, ...rest }) => ({ ...rest, items: items.map(({ request, ...r }) => r) })),
    'product.op': ({ id }) => productOps.get(id),
    'product.opPoll': ({ id }) => productOps.poll(id, 0),

    'questions.get': () => store.get('questions', { items: [], syncedAt: null }),
    'questions.sync': async () => { const r = await support.syncQuestions(requireClient(), store); emit('questions-updated', {}); return r; },
    'questions.answer': ({ id, text }) => support.answerQuestion(requireClient(), store, { id, text }),
    'claims.get': () => store.get('claims', { items: [], syncedAt: null }),
    'returns.analyze': ({ days } = {}) => analyzeReturns({ claims: store.get('claims', null), finance: store.get('finance', null), catalog: store.get('catalog', null), days: Number(days) > 0 ? Math.min(Number(days), 400) : null }),
    'claims.sync': async () => { const r = await support.syncClaims(requireClient(), store); emit('claims-updated', {}); return r; },
    // Siparişi satıcı panelinde açar (yalnızca o sipariş filtrelenir) ve istenen düğmeyi vurgular; hiçbir şeye tıklamaz
    'panel.openOrder': ({ orderNumber, action }) => {
      const no = String(orderNumber || '');
      if (!/^\d{5,20}$/.test(no)) throw new Error('Geçersiz sipariş numarası');
      const label = { a4: 'Kargo Etiketini A4 Yazdır', sticker: 'Kargo Etiketini Sticker Yazdır', invoice: 'Fatura İşlemleri' }[action] || null;
      rewards.openPanelAt(`https://partner.trendyol.com/orders/shipment-packages/all?orderNumber=%22${no}%22&page=0`, label);
      return true;
    },
    // Kargo etiketini panele gitmeden yazdırır (görünmez panel penceresi; panel paketi "etiket yazdırıldı" olarak işaretler)
    'labels.printers': () => labels.listPrinters(),
    'labels.cancelPrint': () => labels.cancelPrint(),
    // Bu uygulamadan etiketi basılmış siparişler: { siparişNo: { at, count, kind, mode } }
    'labels.history': () => store.get('labelPrints', {}),
    // Trendyol panelinde etiketi basılmış paketler (düğme gri): salt okuma
    // Çok sık okunmaz: son okuma 45 sn'den yeniyse (ve zorlanmadıysa) o döner; aynı anda ikinci okuma başlamaz.
    'labels.panelPrinted': async ({ force = false } = {}) => {
      const last = store.get('panelPrinted', null);
      if (!force && last && last.at && Date.now() - last.at < 45000) return { ...last, cached: true, note: '' };
      if (panelReadBusy) return panelReadBusy;
      // Etiketi basılabilecek (açık) siparişler: bunların hepsi görülene kadar listenin sonraki sayfaları da okunur
      const want = (store.get('orders', {}).items || []).filter((o) => ['Created', 'ReadyToShip', 'Picking', 'Approved'].includes(o.status)).map((o) => String(o.orderNumber));
      panelReadBusy = labels.readPanelPrinted({ want, parallel: force ? 2 : 1 }).then((r) => {
        if (r && r.at) { store.set('panelPrinted', { at: r.at, rows: r.rows, read: r.read }); emit('labels-history', {}); }
        return r;
      }).finally(() => { panelReadBusy = null; });
      return panelReadBusy;
    },
    'labels.panelPrintedCached': () => store.get('panelPrinted', null),
    'blacklist.get': () => {
      const bl = BL.normalize(store.get('blacklist', null));
      const vs = (store.get('catalog', null) || {}).variants || [];
      const by = new Map();
      for (const v of vs) { const k = BL.productKey(v); if (k) { if (!by.has(k)) by.set(k, []); by.get(k).push(v); } }
      const items = bl.items.map((it) => {
        const cur = by.get(it.key) || [];
        return { ...it, title: (cur[0] && cur[0].title) || it.title, image: (cur[0] && cur[0].image) || it.image, variantCount: cur.length || (it.barcodes || []).length, sizes: [...new Set(cur.map((v) => v.size).filter(Boolean))], stock: cur.reduce((a, v) => a + (Number(v.quantity) || 0), 0), inCatalog: cur.length > 0 };
      }).sort((a, b) => b.addedAt - a.addedAt);
      return { items, blockedCount: blockedBarcodes().size, server: store.get('blacklistServer', null), paired: !!settings().autoToken };
    },
    'blacklist.add': async ({ barcodes } = {}) => {
      if (!Array.isArray(barcodes) || !barcodes.length) throw new Error('Ürün seçilmedi');
      const vs = (store.get('catalog', null) || {}).variants || [];
      const r = BL.addByBarcodes(store.get('blacklist', null), barcodes.map(String).slice(0, 20000), vs);
      store.set('blacklist', r.list, { immediate: true });
      addAudit(store, { type: 'product', action: 'Kara listeye eklendi', initiator: 'user', status: 'info', message: `${r.added} ürün kara listeye alındı: artık stok, fiyat ve ürün işlemleri yapılmaz.` });
      emit('catalog-updated', {});
      const server = await pushBlacklistToServer();
      return { added: r.added, missing: r.missing, server };
    },
    'blacklist.remove': async ({ keys } = {}) => {
      if (!Array.isArray(keys) || !keys.length) throw new Error('Ürün seçilmedi');
      const r = BL.removeKeys(store.get('blacklist', null), keys);
      store.set('blacklist', r.list, { immediate: true });
      addAudit(store, { type: 'product', action: 'Kara listeden çıkarıldı', initiator: 'user', status: 'info', message: `${r.removed} ürün kara listeden çıkarıldı.` });
      emit('catalog-updated', {});
      const server = await pushBlacklistToServer();
      return { removed: r.removed, server };
    },
    'blacklist.syncServer': () => pushBlacklistToServer(),
    // Kara listeye ekleme penceresi için: katalogdaki tüm ürünler (kara listedekiler işaretli)
    'blacklist.candidates': () => {
      const c = store.get('catalog', null);
      const bl = blockedBarcodes();
      return ((c && c.variants) || []).map((v) => ({ barcode: v.barcode, productMainId: v.productMainId, contentId: v.contentId, title: v.title, image: v.image, size: v.size, color: v.color, quantity: v.quantity, blocked: bl.has(String(v.barcode)) }));
    },
    'labels.repreview': async ({ scale } = {}) => {
      const cur = store.get('settings', {});
      const st = require('./label-printer').normalizeSticker({ ...(cur.labelSticker || {}), scale: Number(scale) });
      store.set('settings', { ...cur, labelSticker: st });
      return { sticker: st, previews: await labels.repreview({ sticker: st }) };
    },
    'labels.prepareBatch': async ({ orderNumbers } = {}) => {
      const s = store.get('settings', {});
      if (!s.labelPrintAck) throw new Error('Önce etiket yazdırma onayını verin.');
      // Her etiket, kendi siparişinin numarası / kargo takip numarasıyla doğrulanır (karışma olmasın)
      const { expect, others } = labelExpectations((store.get('orders', { items: [] }) || {}).items || [], orderNumbers || []);
      const r = await labels.prepareBatch({ orderNumbers, kind: 'sticker', sticker: s.labelSticker, onProgress: (p) => emit('labels-progress', p), expect, others });
      const ok = r.filter((x) => x.ok).length;
      const t = (r[0] && r[0].timing) || {};
      const sec = (ms) => (ms == null ? null : (ms / 1000).toFixed(1).replace('.', ',') + ' sn');
      const how = [t.totalMs != null ? sec(t.totalMs) : null, t.bulk ? `${t.bulk} toplu` : null, t.single ? `${t.single} tek tek` : null, t.warm ? `liste ${t.warm}` : null, t.single ? `işaret onayı ${t.markOk || 0}/${t.single}` : null].filter(Boolean).join(', ');
      addAudit(store, { type: 'label', action: 'Toplu sticker önizleme', initiator: 'user', status: ok === r.length ? 'success' : 'warning', message: `${ok}/${r.length} etiket hazırlandı${how ? ` · ${how}` : ''}${r[0] && r[0].bulkNote ? ` · ${r[0].bulkNote}` : ''}${t.markBad && t.markBad.length ? ` · Trendyol'da "yazdırıldı" işareti onaylanamayanlar: ${t.markBad.slice(0, 8).join(', ')}` : ''} (Trendyol'da "etiket yazdırıldı" olarak işaretlendi)` });
      return r;
    },
    // Toplu sticker penceresi açılınca panel listesi arka planda hazırlanır (hiçbir şeye basılmaz); kapanınca bırakılır
    'labels.warm': () => { labels.warmBulk().catch(() => {}); return { state: 'started' }; },
    'labels.release': () => { labels.releaseWarm(); return true; },
    'labels.printBatch': async ({ orderNumbers, printer: pick, remember, batch, trial } = {}) => {
      const s = store.get('settings', {});
      const output = s.labelOutput === 'pdf' ? 'pdf' : 'print';
      // Uygulama içinden seçilen yazıcı: Windows yazdırma penceresi açılmaz (alt-tab ile kaybolup takılmaz)
      const chosen = typeof pick === 'string' && pick.trim() ? pick.trim().slice(0, 200) : '';
      const r = await labels.printBatch({ orderNumbers, output, printer: chosen || String(s.labelPrinterSticker || ''), sticker: s.labelSticker, batch: typeof batch === 'string' ? batch : null });
      if (chosen && remember && r.status === 'printed') store.set('settings', { ...store.get('settings', {}), labelPrinterSticker: chosen });
      addAudit(store, { type: 'label', action: 'Toplu sticker yazdırma', initiator: 'user', status: r.status === 'cancelled' ? 'info' : 'success', message: r.message });
      if (r.status === 'printed' || r.status === 'pdf') recordLabelPrints(orderNumbers, 'sticker', r.status);
      // Etiket yazıcıya gittiyse siparişler işleme alınır ("1 etiket dene" ve PDF kaydı hariç)
      if (r.status === 'printed' && !trial) {
        try { r.pick = await pickAfterPrint(orderNumbers); } catch (e) { r.pick = { ok: 0, failed: (orderNumbers || []).length, skipped: 0, message: 'İşleme alınamadı: ' + e.message }; }
      }
      return r;
    },
    'labels.print': async ({ orderNumber, kind }) => {
      const s = store.get('settings', {});
      if (!s.labelPrintAck) throw new Error('Önce etiket yazdırma onayını verin.');
      const output = s.labelOutput === 'pdf' ? 'pdf' : 'print';
      const printer = String((kind === 'a4' ? s.labelPrinterA4 : s.labelPrinterSticker) || '');
      const typeName = kind === 'a4' ? 'A4' : 'sticker';
      try {
        const lx = labelExpectations((store.get('orders', { items: [] }) || {}).items || [], [orderNumber]);
        const ex = lx.expect[String(orderNumber)];
        // Sticker etiketinde sipariş no ve kargo no yazar (gerçek etiketlerle doğrulandı); A4 biçimi doğrulanmadığı için kontrol yalnızca sticker'da
        const r = await labels.print({ orderNumber, kind, output, printer, sticker: s.labelSticker, expect: kind === 'sticker' && ex ? { ids: ex.ids, others: lx.others } : null });
        if (r.status === 'fallback') {
          const base = labelPanelBase || 'https://partner.trendyol.com';
          const label = kind === 'a4' ? 'Kargo Etiketini A4 Yazdır' : 'Kargo Etiketini Sticker Yazdır';
          try { rewards.openPanelAt(`${base}/orders/shipment-packages/all?orderNumber=%22${orderNumber}%22&page=0`, label); } catch (_) { /* yoksay */ }
        }
        addAudit(store, { type: 'label', action: `Kargo etiketi (${typeName})`, initiator: 'user', status: r.status === 'fallback' ? 'warning' : r.status === 'cancelled' ? 'info' : 'success', title: `Sipariş ${orderNumber}`, message: r.message });
        if (r.status === 'printed' || r.status === 'pdf') recordLabelPrints([orderNumber], kind, r.status);
        if (r.status === 'printed' && kind === 'sticker') {
          try { r.pick = await pickAfterPrint([orderNumber]); } catch (e) { r.pick = { ok: 0, failed: 1, skipped: 0, message: 'İşleme alınamadı: ' + e.message }; }
        }
        return r;
      } catch (e) {
        addAudit(store, { type: 'label', action: `Kargo etiketi (${typeName})`, initiator: 'user', status: 'failed', title: `Sipariş ${orderNumber}`, message: e.message });
        throw e;
      }
    },
    'panel.open': ({ path }) => { if (!/^\/[A-Za-z0-9\-_/?=&.]*$/.test(String(path || ''))) throw new Error('Geçersiz sayfa'); rewards.openPanel('https://partner.trendyol.com' + path); return true; },

    'rules.list': () => store.get('ruleSets', []),
    'rules.save': (rs) => {
      if (!rs || !String(rs.name || '').trim()) throw new Error('Kural seti adı gerekli');
      if (!Array.isArray(rs.rules) || !rs.rules.length) throw new Error('En az bir kural gerekli');
      const { validateRule } = require('../core/pricing');
      rs.rules.forEach((r, i) => { const err = validateRule(r); if (err) throw new Error(`Kural ${i + 1}: ${err}`); });
      const item = { id: rs.id || uid('kural-'), name: String(rs.name).trim().slice(0, 80), enabled: rs.enabled !== false, rules: rs.rules.map((r) => ({ sizes: r.sizes || [], op: r.op, value: r.value })), ending: rs.ending || 'none', listMode: rs.listMode || 'keep', updatedAt: nowIso() };
      store.update('ruleSets', [], (cur) => { const i = cur.findIndex((x) => x.id === item.id); if (i === -1) cur.push(item); else cur[i] = item; return cur; });
      return item;
    },
    'rules.delete': ({ id }) => { store.update('ruleSets', [], (cur) => cur.filter((x) => x.id !== id)); return true; },

    'buybox.get': async ({ barcodes, force } = {}) => {
      // Salt okunur: Trendyol Buybox Kontrol servisi (10 barkod/istek). 30 dk önbellek.
      const client = requireClient();
      const uniq = [...new Set((barcodes || []).map(String))].slice(0, 500);
      const cache = store.get('buybox', {});
      const now = Date.now();
      const need = uniq.filter((b) => force || !cache[b] || now - cache[b].t > 30 * 60 * 1000);
      for (let i = 0; i < need.length; i += 10) {
        const res = await client.getBuyboxInformation(need.slice(i, i + 10));
        const got = new Set();
        for (const x of (res && res.buyboxInfo) || []) {
          if (x && x.barcode) { got.add(String(x.barcode)); cache[String(x.barcode)] = { order: x.buyboxOrder ?? null, price: x.buyboxPrice ?? null, multi: !!x.hasMultipleSeller, second: x.secondBuyboxPrice ?? null, t: now }; }
        }
        // Trendyol'un bilgi döndürmediği barkodlar (ör. satışta olmayanlar) da işaretlenir; aksi hâlde sürekli tekrar sorulurdu
        for (const b of need.slice(i, i + 10)) if (!got.has(b)) cache[b] = { none: true, t: now };
      }
      // Önbelleği sınırla
      const keys = Object.keys(cache);
      if (keys.length > 20000) keys.sort((a, b) => cache[a].t - cache[b].t).slice(0, keys.length - 20000).forEach((k) => delete cache[k]);
      store.set('buybox', cache);
      const out = {};
      for (const b of uniq) if (cache[b]) out[b] = cache[b];
      return out;
    },

    'opps.query': (q = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      const own = oppOwn();
      let changed = false;
      for (const it of Object.values(db.items)) {
        if (it.join && it.join.status === 'pending' && own.byContent.has(String(it.contentId))) { it.join = { ...it.join, status: 'ok', verifiedAt: Date.now(), message: 'Ürün mağazanın kataloğunda görüldü' }; changed = true; }
      }
      if (changed) store.set('opps', db);
      const view = oppsView(db);
      const r = opps.query(view, own, q);
      r.pendingBrands = pendingBrands().length;
      const selected = (db.selected || []).filter((id) => db.items[id]);
      return { ...r, selected, scans: (db.scans || []).slice(0, 30), recentCats: db.recentCats || [] };
    },
    'opps.plans': ({ ids } = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      const list = (ids && ids.length ? ids : db.selected || []).map(String).filter((id) => db.items[id]);
      const own = opps.ownIndex(store.get('catalog', null));
      return { items: list.map((id) => { const it = db.items[id]; return { ...it, brand: opps.cleanBrand(it.brand, it.url, it.title), own: own.has(id) }; }), plans: Object.fromEntries(list.map((id) => [id, (db.plans || {})[id] || null])), defaults: db.planDefaults || { price: '', kdv: 10, prefix: 'MF', qty: {} }, catalogAddUrl: settings().catalogAddUrl };
    },
    'opps.savePlans': ({ plans, defaults } = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      db.plans = { ...(db.plans || {}) };
      for (const [id, pl] of Object.entries(plans || {})) {
        if (!db.items[id] || !pl) continue;
        const qty = {};
        for (const [k, v] of Object.entries(pl.qty || {})) if (v !== '' && v != null && String(k).length <= 24) qty[String(k)] = Number(v);
        db.plans[id] = { price: String(pl.price ?? '').slice(0, 20), cost: String(pl.cost ?? '').slice(0, 20), qty };
      }
      if (defaults) db.planDefaults = { price: String(defaults.price ?? '').slice(0, 20), cost: String(defaults.cost ?? '').slice(0, 20), kdv: Number(defaults.kdv) || 0, prefix: String(defaults.prefix || 'MF').slice(0, 10), qty: defaults.qty || {} };
      store.set('opps', db);
      return true;
    },
    'opps.transferPreview': ({ ids, kdv, prefix } = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      const items = (ids || []).map(String).map((id) => db.items[id]).filter(Boolean);
      return transfer.buildTransfer({ items, plans: db.plans || {}, kdv, prefix, ownContent: new Set(opps.ownIndex(store.get('catalog', null)).keys()) });
    },
    'opps.transferCreate': ({ ids, kdv, prefix } = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      const items = (ids || []).map(String).map((id) => db.items[id]).filter(Boolean);
      const r = transfer.buildTransfer({ items, plans: db.plans || {}, kdv, prefix, ownContent: new Set(opps.ownIndex(store.get('catalog', null)).keys()) });
      if (!r.rows.length) throw new Error('Excel\'e yazılacak satır yok. Ürünlere fiyat ve beden stoğu girin.');
      const dir = require('path').join(app.getPath('userData'), 'urun-transferleri');
      fs.mkdirSync(dir, { recursive: true });
      const file = require('path').join(dir, `urun-transferi-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.xlsx`);
      fs.writeFileSync(file, transfer.transferXlsx(r.rows));
      const now = Date.now();
      for (const p of r.products) if (p.rows) db.items[p.contentId].join = { status: 'pending', at: now, file, rows: p.rows, message: null };
      store.set('opps', db, { immediate: true });
      addAudit(store, { type: 'system', action: 'Katalog ürün transferi Excel\'i hazırlandı', initiator: 'user', status: 'info', message: `${r.products.filter((p) => p.rows).length} ürün, ${r.rows.length} beden satırı · ${file}` });
      emit('opps-updated', {});
      return { file, rows: r.rows.length, products: r.products };
    },
    'opps.transferSaveAs': async ({ file } = {}) => {
      if (!file || !fs.existsSync(file) || !file.startsWith(require('path').join(app.getPath('userData'), 'urun-transferleri'))) throw new Error('Dosya bulunamadı');
      const res = await dialog.showSaveDialog({ title: 'Ürün transferi Excel dosyasını kaydet', defaultPath: require('path').basename(file), filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
      if (res.canceled || !res.filePath) return { saved: false };
      fs.copyFileSync(file, res.filePath);
      return { saved: true, path: res.filePath };
    },
    'opps.openCatalogAdd': () => { rewards.openPanel(settings().catalogAddUrl || undefined); return true; },
    'opps.useCatalogAddUrl': () => {
      const u = rewards.currentPanelUrl();
      if (!u || !/^https:\/\/partner\.trendyol\.com\//.test(u)) throw new Error('Önce satıcı paneli penceresinde "Katalogdan Ürün Ekle" sayfasını açın.');
      saveSettings({ catalogAddUrl: u });
      return { url: u };
    },
    'opps.attachTransfer': async ({ file } = {}) => {
      if (!file || !fs.existsSync(file) || !file.startsWith(require('path').join(app.getPath('userData'), 'urun-transferleri'))) throw new Error('Dosya bulunamadı');
      return rewards.attachFileToPanel(file);
    },
    'opps.setJoin': ({ ids, status, message } = {}) => {
      if (!['ok', 'docRequired', 'rejected', 'failed', 'pending', null].includes(status ?? null)) throw new Error('Geçersiz durum');
      const db = store.get('opps', null) || opps.emptyDb();
      for (const id of (ids || []).map(String)) if (db.items[id]) db.items[id].join = status ? { ...(db.items[id].join || {}), status, message: message ? String(message).slice(0, 300) : null, at: Date.now(), manual: true } : null;
      store.set('opps', db, { immediate: true });
      emit('opps-updated', {});
      return true;
    },
    'brands.state': () => brandChecker.publicState(),
    'brands.check': ({ ids, force } = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      const checks = store.get('brandChecks', {});
      const list = (ids && ids.length ? ids.map(String).map((id) => db.items[id]).filter(Boolean) : Object.values(db.items)).map((it) => opps.cleanBrand(it.brand, it.url, it.title)).filter(Boolean);
      const brands = [...new Map(list.map((b) => [brandCore.normBrand(b), b])).entries()].filter(([k]) => k && (force || !checks[k] || checks[k].status === 'unverified')).map(([, b]) => b);
      if (!brands.length) throw new Error('Sorgulanmamış marka yok');
      return brandChecker.run(brands);
    },
    'brands.stop': () => { brandChecker.stop(); return brandChecker.publicState(); },
    'brands.open': () => { brandChecker.open(); return true; },
    'brands.readCurrent': ({ brand } = {}) => { if (!brand) throw new Error('Marka seçilmedi'); return brandChecker.readCurrent(String(brand)); },
    'brands.useCurrentUrl': () => {
      const w = brandChecker.win;
      const u = w && !w.isDestroyed() ? w.webContents.getURL() : null;
      if (!u || !/^https:\/\/([a-z0-9-]+\.)*turkpatent\.gov\.tr\//.test(u)) throw new Error('Önce TÜRKPATENT penceresinde marka araştırma sayfasını açın');
      saveSettings({ turkpatentUrl: u });
      return { url: u };
    },
    'opps.readJoinResults': async () => {
      const page = await rewards.readPanelTables(TABLE_READ_SCRIPT);
      const rows = (page.tables || []).flatMap((t) => t.rows || []).map((r) => r.join(' | '));
      const db = store.get('opps', null) || opps.emptyDb();
      let matched = 0;
      const now = Date.now();
      for (const it of Object.values(db.items)) {
        if (!it.join || !it.variants) continue;
        const bcs = it.variants.map((v) => v.barcode);
        const hits = rows.filter((r) => bcs.some((b) => r.includes(b)));
        if (!hits.length) continue;
        const kinds = hits.map(brandCore.classifyJoinMessage);
        const status = kinds.includes('ok') ? 'ok' : kinds.includes('docRequired') ? 'docRequired' : kinds.includes('rejected') ? 'rejected' : kinds.includes('failed') ? 'failed' : null;
        if (!status) continue;
        it.join = { ...it.join, status, message: hits[0].slice(0, 300), at: now, fromPanel: true };
        matched++;
      }
      store.set('opps', db, { immediate: true });
      emit('opps-updated', {});
      return { rows: rows.length, matched };
    },
    'opps.select': ({ ids, on, clear } = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      let sel = new Set(clear ? [] : db.selected || []);
      for (const id of (ids || []).map(String)) { if (on === false) sel.delete(id); else if (db.items[id]) sel.add(id); }
      store.set('opps', { ...db, selected: [...sel].slice(0, 5000) });
      return [...sel];
    },
    'opps.remove': ({ ids } = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      for (const id of (ids || []).map(String)) delete db.items[id];
      db.selected = (db.selected || []).filter((id) => db.items[id]);
      store.set('opps', db, { immediate: true });
      return true;
    },
    'opps.clear': ({ scope = 'all', ids, brands = false, scans = false } = {}) => {
      if (brandChecker.state.running) brandChecker.stop('Liste temizlendi');
      const db = store.get('opps', null) || opps.emptyDb();
      const before = Object.keys(db.items).length;
      if (scope === 'all') { db.items = {}; db.selected = []; db.plans = {}; }
      else {
        for (const id of (ids || []).map(String)) { delete db.items[id]; if (db.plans) delete db.plans[id]; }
        db.selected = (db.selected || []).filter((id) => db.items[id]);
      }
      if (scans) db.scans = [];
      store.set('opps', db, { immediate: true });
      if (brands) store.set('brandChecks', {}, { immediate: true });
      const removed = before - Object.keys(db.items).length;
      addAudit(store, { type: 'system', action: 'Buybox Fırsatları listesi temizlendi', initiator: 'user', status: 'info', message: `${removed} ürün silindi${brands ? ', marka sorgu sonuçları silindi' : ''}${scans ? ', tarama geçmişi silindi' : ''}` });
      emit('opps-updated', {});
      return { removed, left: Object.keys(db.items).length };
    },
    'opps.refreshMine': async ({ ids } = {}) => {
      const db = store.get('opps', null) || opps.emptyDb();
      requireClient();
      const n = await refreshOwnBuybox(ids && ids.length ? ids : Object.keys(db.items), true);
      return { checked: n };
    },
    'opps.categories': async ({ force } = {}) => {
      const cached = store.get('categoryTree', null);
      if (!force && cached && Date.now() - cached.at < 7 * 86400000 && cached.tree.length) return cached;
      const res = await requireClient().getProductCategories();
      const tree = opps.normalizeCategoryTree(res);
      if (!tree.length) throw new Error('Trendyol kategori listesi boş döndü');
      const out = { at: Date.now(), tree };
      store.set('categoryTree', out);
      return out;
    },
    'opps.openScan': ({ categories } = {}) => {
      const list = (categories || []).filter((c) => c && Number.isInteger(Number(c.id))).slice(0, 10);
      if (!list.length) throw new Error('Kategori seçilmedi');
      for (const c of list) shell.openExternal(`https://www.trendyol.com/sr?wc=${Number(c.id)}#mf-cat=${Number(c.id)}~${encodeURIComponent(String(c.name || '').slice(0, 80))}`);
      const db = store.get('opps', null) || opps.emptyDb();
      db.recentCats = [...list.map((c) => ({ id: Number(c.id), name: String(c.name || ''), path: c.path || null })), ...(db.recentCats || []).filter((x) => !list.some((c) => Number(c.id) === x.id))].slice(0, 12);
      store.set('opps', db);
      return { opened: list.length };
    },
    'opps.bridge': () => ({ ...bridge.state, token: bridgeToken() }),
    'opps.bridgeRestart': async ({ rotate } = {}) => {
      if (rotate) saveSettings({ bbBridgeToken: secrets.encrypt(newBridgeToken()) });
      bridge.stop();
      await bridge.start();
      return { ...bridge.state, token: bridgeToken() };
    },
    'opps.openExternal': ({ url } = {}) => { if (!opps.parseProductUrl(url)) throw new Error('Geçersiz Trendyol linki'); shell.openExternal(opps.parseProductUrl(url).url); return true; },

    'orders.get': () => store.get('orders', { items: [], syncedAt: null }),
    // Ana sayfa ve alt menü rozetleri için küçük özet (yalnızca yerel veriden; Trendyol'a istek atmaz)
    'dash.summary': () => memo('dashSummary', ['orders', 'questions', 'claims', 'buybox'], () => {
      const qs = (store.get('questions', { items: [] }) || {}).items || [];
      const cs = (store.get('claims', { items: [] }) || {}).items || [];
      const os = (store.get('orders', { items: [] }) || {}).items || [];
      let mine = 0, total = 0, at = 0;
      for (const v of Object.values(store.get('buybox', {}) || {})) { if (!v || v.none || v.order == null) continue; total++; if (Number(v.order) === 1) mine++; if (v.t > at) at = v.t; }
      return {
        questions: qs.filter((q) => q && q.status === 'WAITING_FOR_ANSWER').length,
        claims: cs.filter((c) => c && (c.items || []).some((i) => i && i.status === 'WaitingInAction')).length,
        newOrders: os.filter((o) => o && o.status === 'Created').length,
        buybox: { mine, total, at: at || null },
      };
    }),
    'orders.sync': ({ days } = {}) => runOrdersSync('user', days),

    'audit.query': (f) => queryAudit(store, f || {}),

    'export.csv': async ({ name, rows, columns }) => {
      const res = await dialog.showSaveDialog({ title: 'CSV olarak kaydet', defaultPath: (name || 'disa-aktarim') + '-' + new Date().toISOString().slice(0, 10) + '.csv', filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }] });
      if (res.canceled || !res.filePath) return { saved: false };
      fs.writeFileSync(res.filePath, toCSV(rows || [], columns || []), 'utf8');
      return { saved: true, path: res.filePath };
    },

    'automations.list': () => scheduler.list(),
    // Örnek kart: son siparişi (yoksa açıkça "Örnek" yazan veriyi) gösterir; hiçbir şey kaydetmez
    'orderWatch.preview': () => {
      const last = (store.get('orders', { items: [] }).items || [])[0];
      popups.show(last ? orderSummary(last) : { orderNumber: 'ÖRNEK', amount: 349.9, currency: 'TRY', units: 2, product: 'Örnek bildirim — gerçek sipariş değil', more: 0 }, { sound: watchSettings().sound !== false });
      return true;
    },
    'automations.configure': ({ id, ...cfg }) => { scheduler.configure(id, cfg); return scheduler.list(); },
    'automations.run': async ({ id }) => scheduler.run(id, 'manual'),
    'automations.pauseAll': ({ paused }) => { scheduler.setGlobalPause(paused); return scheduler.list(); },

    'notifications.list': () => store.get('notifications', []),
    'notifications.markAllRead': () => { store.update('notifications', [], (cur) => cur.map((n) => ({ ...n, read: true }))); return true; },
    'notifications.clear': () => { store.set('notifications', []); return true; },

    'rewards.state': () => rewards.publicState(),
    'rewards.openPanel': ({ url } = {}) => { rewards.openPanel(url); return true; },
    'rewards.useCurrentUrl': () => {
      const u = rewards.currentPanelUrl();
      if (!u) throw new Error('Önce "Satıcı panelini aç" ile paneli açın ve ödül sayfasına gidin.');
      return rewards.setUrl(u);
    },
    'rewards.setUrl': ({ url }) => rewards.setUrl(url),
    'rewards.check': () => rewards.check({ trigger: 'manual', allowAutoClaim: false }),
    'rewards.claim': ({ key, confirmSpend, force }) => rewards.manualClaim(key, { confirmSpend, force }),
    'rewards.resetHistory': ({ key }) => { rewards.resetHistory(key); return true; },
  };

  function pickVariants(barcodes) {
    if (!Array.isArray(barcodes) || !barcodes.length) throw new Error('Varyant seçilmedi');
    const cat = store.get('catalog', null);
    if (!cat) throw new Error('Katalog boş. Önce ürünleri senkronize edin.');
    const map = new Map(cat.variants.map((v) => [v.barcode, v]));
    const uniq = [...new Set(barcodes.map(String))];
    const missing = uniq.filter((b) => !map.has(b));
    if (missing.length) throw new Error(`${missing.length} barkod katalogda yok (ör. ${missing[0]}). Senkronize edip tekrar deneyin.`);
    // Kara listedekiler hiçbir plana girmez
    const bl = blockedBarcodes();
    const ok = uniq.filter((b) => !bl.has(b));
    if (!ok.length) throw new Error('Seçilen ürünlerin hepsi kara listede; bunlara değişiklik yapılmaz.');
    return ok.map((b) => map.get(b));
  }

  async function handle(method, args) {
    if (!Object.prototype.hasOwnProperty.call(api, method)) throw new Error('Bilinmeyen işlem: ' + method);
    if (locked && !openMethods.has(method)) throw new Error('Uygulama kilitli. PIN ile açın.');
    try {
      return await api[method](args || {});
    } catch (e) {
      const out = new Error(redact(e && e.message ? e.message : String(e), secretValues(args)));
      out.code = e && (e.code || e.kind);
      if (e && e.data) out.data = JSON.parse(redact(JSON.stringify(e.data), secretValues(args)));
      throw out;
    }
  }

  function startup() {
    locked = !!settings().pin;
    upgradeSecrets();
    // Bağlıysa son okunan ödeme takvimini sunucuya bir kez gönder (telefon güncel takvimi görsün)
    { const t = setTimeout(() => { pushPanelToServer(); syncBlacklistIfChanged(); }, startupPushDelayMs); if (t && t.unref) t.unref(); }
    try { migrateOrderDates(store); } catch (_) { /* yoksay */ }
    const recovered = jobs.recoverOnStartup();
    if (recovered) notify({ level: 'warning', title: 'Doğrulama gerekli', body: `${recovered} toplu işlem uygulama kapanırken yarım kaldı. İşlem Geçmişi > Toplu işler bölümünden doğrulayın.` });
    // Geçiş: eski varsayılan aralıklar (60/15 dk) yeni otomatik senkron aralıklarına çekilir
    const mig = store.get('migrations', {});
    if (!mig.autoSync2) {
      const st = store.get('automations', {});
      try {
        if (st.catalog_sync && st.catalog_sync.intervalMin === 60) scheduler.configure('catalog_sync', { intervalMin: 15 });
        if (st.orders_sync && st.orders_sync.intervalMin === 15) scheduler.configure('orders_sync', { intervalMin: 5 });
        for (const id of ['catalog_sync', 'orders_sync', 'questions_sync', 'claims_sync']) {
          if (st[id] && st[id].enabled === false && (st[id].consecutiveFailures || 0) >= 3) scheduler.configure(id, { enabled: true });
        }
      } catch (_) { /* yoksay */ }
      store.set('migrations', { ...mig, autoSync2: true });
    }
    // Geçiş: TÜRKPATENT sorguları sitede 25/35 sınıf filtresi uygulanamadan yapılmıştı (sınıf listesi tabloda 6'da kesiliyor,
    // 20'den fazla sonuç okunmuyordu). Kesin olmayan sonuçlar silinir ve açılıştan sonra 25/35 filtresiyle yeniden sorgulanır.
    if (!store.get('migrations', {}).brandChecks2535) {
      try {
        const db = store.get('opps', null);
        const used = new Set();
        for (const it of Object.values((db && db.items) || {})) {
          const b = opps.cleanBrand(it.brand, it.url, it.title);
          const k = b && brandCore.normBrand(b);
          if (k) used.add(k);
        }
        const before = store.get('brandChecks', {});
        if (Object.keys(before).length) {
          const { checks, stats } = brandCore.pruneStaleChecks(before, used, brandChecker.classes);
          store.set('brandChecks', checks, { immediate: true });
          if (stats.requery) notify({ level: 'info', title: 'Marka sorguları düzeltiliyor', body: `${stats.requery} marka TÜRKPATENT'te 25/35 sınıf filtresiyle yeniden sorgulanacak; ${stats.revalidated} sonuç kesin olduğu için korundu, yanlış adla yapılmış ${stats.orphan} sorgu silindi.` });
        }
      } catch (_) { /* yoksay */ }
      store.set('migrations', { ...store.get('migrations', {}), brandChecks2535: true });
    }
    // Geçiş: yeni arayüz (alt menü + Mozaik Turuncu, koyu) bir kez varsayılan yapılır; Ayarlar > Görünüm'den değiştirilebilir.
    if (!store.get('migrations', {}).uiMozaik) {
      try {
        const cur = themeCore.normalizeAppearance(settings().appearance);
        saveSettings({ theme: 'dark', appearance: { preset: 'mozaik', custom: { light: {}, dark: {} }, saved: cur.saved } });
        if (onTheme) { try { onTheme('dark'); } catch (_) { /* pencere yoksa yoksay */ } }
      } catch (_) { /* yoksay */ }
      store.set('migrations', { ...store.get('migrations', {}), uiMozaik: true });
    }
    scheduler.start();
    bridge.start().catch(() => {});
    autoBrandCheck(30000);
    // Açılışta otomatik yenileme: ürünler 10 dakikadan eskiyse ve siparişler her açılışta
    const t = setTimeout(() => {
      if (!getClient() || !scheduler.timer || process.env.TSP_NO_STARTUP_SYNC === '1') return; // (hız ölçümünde açılış yenilemesi kapatılır)
      const cat = store.get('catalog', null);
      const age = cat && cat.syncedAt ? Date.now() - Date.parse(cat.syncedAt) : Infinity;
      if (age > 10 * 60000) scheduler.run('catalog_sync', 'startup').catch(() => {});
      setTimeout(() => scheduler.run('orders_sync', 'startup').catch(() => {}), 4000).unref?.();
      const fin = store.get('finance', null);
      if (!fin || fin.version !== 2 || Date.now() - Date.parse(fin.syncedAt) > 6 * 3600000) setTimeout(() => scheduler.run('finance_sync', 'startup').catch(() => {}), 20000).unref?.();
      else setTimeout(() => scheduler.run('payments_panel', 'startup').catch(() => {}), 15000).unref?.();
    }, 2500);
    if (t.unref) t.unref();
    if (updateEnabled) {
      const u0 = setTimeout(() => checkUpdate(false).catch(() => {}), 25000); if (u0.unref) u0.unref();
      const ui = setInterval(() => checkUpdate(false).catch(() => {}), 6 * 3600000); if (ui.unref) ui.unref();
    }
  }

  return { handle, startup, scheduler, jobs, productOps, rewards, settings, notify, sanitize, JobError, bridge };
}

module.exports = { createServices, DEFAULT_SETTINGS };
