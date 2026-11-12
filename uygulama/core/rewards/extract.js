'use strict';

/**
 * ÖNEMLİ: Bu iki fonksiyon Trendyol Satıcı Paneli sayfasının İÇİNDE çalıştırılır
 * (Electron executeJavaScript). Dış değişken kullanmamalı, kendi içinde bağımsız olmalıdır.
 *
 * Trendyol'un ödül/gelişim sayfası için resmî API yoktur ve sayfa yapısı önceden bilinemez.
 * Bu yüzden genel bir yöntem kullanılır: "Al / Talep Et" gibi buton metinlerinden yola çıkarak
 * her butonu içeren en küçük anlamlı "kart" bulunur ve kart metni sınıflandırılır.
 * Güvenilir şekilde kart bulunamazsa otomasyon tıklama yapmaz.
 */
function extractRewardPage(cfg) {
  var claimTexts = (cfg && cfg.claimTexts || []).map(function (t) { return String(t).toLocaleLowerCase('tr-TR').trim(); }).filter(Boolean);
  function txt(el) {
    var t = (el && (el.innerText != null ? el.innerText : el.textContent)) || '';
    return String(t).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  }
  function norm(s) { return String(s || '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim(); }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'r' + (h >>> 0).toString(36);
  }
  var href = String(location.href);
  var hasPassword = !!document.querySelector('input[type="password"]');
  var loginLike = /\/(login|giris|signin|auth)(\/|\?|$)/i.test(location.pathname) || hasPassword;
  if (loginLike) return { ok: true, url: href, loginRequired: true, cards: [], progressLines: [], title: document.title };

  // Seviye ve puan bakiyesi ("Mevcut Seviye / Elmas / 102.180 Puan")
  var bodyText = txt(document.body);
  var lvl = bodyText.match(/Mevcut Seviye\s*\n\s*([^\n]{1,30})\s*\n\s*([\d.]+)\s*Puan/);
  var level = lvl ? lvl[1].trim() : null;
  var balance = lvl ? Number(lvl[2].replace(/\./g, '')) : null;

  // 0) Gelişim Merkezi "7 günlük seri" kartları: is-claimable olan gün ÜCRETSİZ puan verir (harcama yok)
  var today = new Date();
  var ymd = today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate();
  var dailyCards = Array.prototype.slice.call(document.querySelectorAll('[data-testid="daily-reward-card-wrapper"], .daily-reward-card-wrapper')).map(function (el) {
    var day = txt(el.querySelector('.daily-reward-card-day')) || txt(el).split('\n')[0];
    var pts = txt(el.querySelector('.daily-reward-card-reward-point'));
    var c = String(el.className || '');
    var state = /is-claimed/.test(c) ? 'claimed' : /is-claimable/.test(c) ? 'free' : 'unavailable';
    var e = {
      key: 'ty-daily-' + ymd + '-' + norm(day).replace(/\s+/g, ''), source: 'trendyol-daily', title: 'Günlük seri · ' + day + (pts ? ' · ' + pts : ''), text: txt(el),
      buttonText: state === 'free' ? 'Puanı topla' : '', buttonDisabled: state !== 'free', isClaimButton: state === 'free',
      presetCls: state, presetReason: state === 'claimed' ? 'Alınmış' : state === 'free' ? 'Ücretsiz günlük seri puanı (harcama yok)' : 'Henüz açılmadı',
    };
    if (cfg && cfg._withElements) e._el = el.querySelector('button, bl-button, [role="button"]') || el;
    return e;
  });

  // 1) Trendyol Ödül Mağazası'nın bilinen yapısı (Ekim 2026'da incelendi): data-testid="level-reward-card"
  var tyCards = Array.prototype.slice.call(document.querySelectorAll('[data-testid="level-reward-card"]'));
  if (tyCards.length || dailyCards.length) {
    var list = dailyCards.slice();
    var seen = {};
    tyCards.forEach(function (c) {
      var type = txt(c.querySelector('.reward-type'));
      var value = txt(c.querySelector('.reward-value'));
      var disc = txt(c.querySelector('[data-testid="reward-discount-ratio-info"]')).replace(/\n/g, ' ');
      var dates = txt(c.querySelector('[data-testid="reward-usable-dates-info"]'));
      var title = (type + ' ' + value).trim() || txt(c).split('\n')[0];
      var costText = txt(c.querySelector('.discounted-level-point-cost')) || txt(c.querySelector('.reward-point'));
      var m = costText.match(/([\d.]+)\s*Puan/i);
      var cost = m ? Number(m[1].replace(/\./g, '')) : null;
      var soldOut = !!c.querySelector('[data-testid="sold-out-ribbon"]');
      var disabledCard = /(^|\s)disabled(\s|$)/.test(c.className || '');
      var actions = c.querySelector('.reward-actions');
      var btns = actions ? Array.prototype.slice.call(actions.querySelectorAll('button, a, [role="button"], bl-button')) : [];
      var btn = btns.filter(function (b) { return !(b.disabled || b.getAttribute('disabled') != null || b.getAttribute('aria-disabled') === 'true'); })[0] || null;
      var key = hash(norm(title) + '|' + norm(dates));
      if (seen[key] != null) { list[seen[key]].ambiguous = true; return; }
      seen[key] = list.length;
      var entry = {
        key: key, source: 'trendyol', title: title.slice(0, 160), text: [title, disc, dates, costText].filter(Boolean).join('\n').slice(0, 900),
        cost: cost, soldOut: soldOut, cardDisabled: disabledCard, buttonText: btn ? txt(btn) : (btns[0] ? txt(btns[0]) : ''),
        buttonDisabled: !btn, isClaimButton: !!btn && !soldOut,
      };
      if (cfg && cfg._withElements) entry._el = btn;
      list.push(entry);
    });
    return { ok: true, url: href, loginRequired: false, cards: list, progressLines: level ? ['Seviye: ' + level, 'Puan bakiyesi: ' + balance] : [], level: level, balance: balance, title: document.title, layout: 'trendyol-level-rewards' };
  }

  // 2) Genel yöntem (bilinmeyen sayfa yapıları için)
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"]'));
  var cards = [];
  var seenKeys = {};
  buttons.forEach(function (btn) {
    var bt = norm(txt(btn));
    if (!bt || bt.length > 40) return;
    var isClaim = claimTexts.some(function (c) { return bt === c; });
    var isDone = /^(alındı|kullanıldı|talep edildi|kazanıldı|tanımlandı)$/.test(bt);
    if (!isClaim && !isDone) return;
    // Butonu kapsayan, 20–900 karakter arası, butondan başka metin de içeren en yakın ata
    // Birden fazla talep butonu içeren ata "kart" değil, kart listesidir -> orada dur.
    var node = btn.parentElement, card = null;
    for (var depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      var t = txt(node);
      if (t.length > 900) break;
      var claimBtnCount = Array.prototype.filter.call(node.querySelectorAll('button, a, [role="button"]'), function (b) {
        var x = norm(txt(b));
        return claimTexts.indexOf(x) !== -1 || /^(alındı|kullanıldı|talep edildi|kazanıldı|tanımlandı)$/.test(x);
      }).length;
      if (claimBtnCount > 1) break;
      if (t.length >= 20 && norm(t) !== bt) { card = node; break; }
    }
    if (!card) return;
    var cardText = txt(card);
    var lines = cardText.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && norm(l) !== bt; });
    var title = lines[0] || cardText.slice(0, 60);
    var key = hash(norm(title) + '|' + norm(lines.slice(1, 3).join(' ')).replace(/\d+\s*(gün|saat|dakika|dk|sn)/g, ''));
    if (seenKeys[key] != null) { cards[seenKeys[key]].ambiguous = true; return; }
    seenKeys[key] = cards.length;
    var disabled = !!(btn.disabled || btn.getAttribute('aria-disabled') === 'true' || /disabled/i.test(btn.className || ''));
    var entry = { key: key, title: title.slice(0, 160), text: cardText.slice(0, 900), buttonText: txt(btn), buttonDisabled: disabled, isClaimButton: isClaim };
    if (cfg && cfg._withElements) entry._el = btn;
    cards.push(entry);
  });
  var progressLines = [];
  var all = txt(document.body).split('\n');
  for (var i = 0; i < all.length && progressLines.length < 20; i++) {
    var l = all[i].trim();
    if (l.length > 2 && l.length < 160 && /(seviye|level|gelişim|puan|hedef|tamamla|ilerleme|rozet)/i.test(l) && progressLines.indexOf(l) === -1) progressLines.push(l);
  }
  return { ok: true, url: href, loginRequired: false, cards: cards, progressLines: progressLines, level: level, balance: balance, title: document.title, buttonCount: buttons.length, layout: 'generic' };
}

/** Sayfada anahtarı eşleşen kartın butonuna tıklar. Kart/buton bulunamazsa tıklamaz. */
function clickRewardInPage(cfg) {
  var res = extractRewardPage(cfg);
  if (res.loginRequired) return { clicked: false, reason: 'Oturum kapalı' };
  var target = res.cards.filter(function (c) { return c.key === cfg.key; })[0];
  if (!target) return { clicked: false, reason: 'Ödül kartı sayfada bulunamadı' };
  if (!target.isClaimButton || target.buttonDisabled) return { clicked: false, reason: 'Talep butonu aktif değil' };
  if (target.ambiguous) return { clicked: false, reason: 'Aynı başlıklı birden fazla kart var, güvenlik için tıklanmadı' };
  // Aynı anahtara sahip kartın butonu (kart bulma algoritması okuma ile birebir aynıdır)
  var withEls = extractRewardPage(Object.assign({}, cfg, { _withElements: true }));
  var matches = withEls.cards.filter(function (c) { return c.key === cfg.key && c.isClaimButton && !c.buttonDisabled; });
  if (matches.length !== 1) return { clicked: false, reason: matches.length ? 'Birden fazla eşleşen buton var, güvenlik için tıklanmadı' : 'Buton bulunamadı' };
  matches[0]._el.click();
  return { clicked: true, title: target.title };
}

/**
 * Tıklamadan sonra açılan onay penceresinde (dialog/modal) yapılandırılmış onay metnine sahip TEK butonu tıklar.
 * Pencere yoksa veya eşleşme tek değilse hiçbir şey yapmaz.
 */
function confirmDialogInPage(cfg) {
  var texts = (cfg.confirmTexts || []).map(function (t) { return String(t).toLocaleLowerCase('tr-TR').trim(); });
  var dialogs = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], bl-dialog[open], .modal.show, .modal[open]'));
  if (!dialogs.length) return { dialog: false };
  var cands = [];
  dialogs.forEach(function (d) {
    Array.prototype.slice.call(d.querySelectorAll('button, [role="button"], bl-button')).forEach(function (b) {
      var t = String((b.innerText != null ? b.innerText : b.textContent) || '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
      if (texts.indexOf(t) !== -1 && !(b.disabled || b.getAttribute('disabled') != null)) cands.push(b);
    });
  });
  var dialogText = String(dialogs[0].innerText || '').slice(0, 400);
  if (cands.length !== 1) return { dialog: true, clicked: false, reason: cands.length ? 'Onay penceresinde birden fazla eşleşen buton' : 'Onay penceresinde tanınan buton yok', dialogText: dialogText };
  cands[0].click();
  return { dialog: true, clicked: true, dialogText: dialogText };
}

/** Sayfaya enjekte edilecek betikleri üretir (yapılandırma JSON olarak gömülür). */
function buildExtractScript(cfg) {
  return '(' + extractRewardPage.toString() + ')(' + JSON.stringify(cfg || {}) + ')';
}
function buildClickScript(cfg) {
  return '(function(){ var extractRewardPage = ' + extractRewardPage.toString() + '; return (' + clickRewardInPage.toString() + ')(' + JSON.stringify(cfg || {}) + '); })()';
}

function buildConfirmScript(cfg) {
  return '(' + confirmDialogInPage.toString() + ')(' + JSON.stringify(cfg || {}) + ')';
}

module.exports = { extractRewardPage, clickRewardInPage, confirmDialogInPage, buildExtractScript, buildClickScript, buildConfirmScript };
