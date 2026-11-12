'use strict';
/**
 * Satıcı paneli › Müşteri Soruları sayfasında bir soruyu "Sorun Bildir" ile bildiren sayfa betikleri.
 * Bilgisayar (Electron gizli pencere) ve telefon (Android WebView) aynı betikleri çalıştırır.
 *
 * Güvenlik:
 *  - Yalnızca metni eşleşen sorunun satırındaki düğmeye basılır (satırda tek "Sorun Bildir" olmalı).
 *  - Açılan penceredeki soru metni tekrar doğrulanır; uyuşmazsa hiçbir şey göndermeden pencere kapatılır.
 *  - Yalnızca "Sorun Bildirme Nedeni" kutusu doldurulur ve pencerenin kendi "Sorun Bildir" düğmesine basılır.
 * Panel bileşenleri gölge DOM (bl-button, bl-dialog, bl-textarea) kullanabildiği için arama gölge köklerine de iner.
 */
const QUESTIONS_URL = 'https://partner.trendyol.com/questions/products';

function pageAction(args) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr-TR');
  const snippet = norm(args.text).slice(0, 60);
  function walk(root, out) {
    for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }
    return out;
  }
  const parentOf = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  // Görünürlük stil üzerinden: gizli (ekrana bağlı olmayan) sayfada boyutlar 0 olabilir
  const visible = (el) => {
    for (let p = el; p && p.nodeType === 1; p = parentOf(p)) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (/^BL-DIALOG$/.test(p.tagName) && !(p.open || p.hasAttribute('open'))) return false;
    }
    return true;
  };
  const deepText = (el) => { const parts = [el.innerText || el.textContent || '']; if (el.shadowRoot) parts.push(el.shadowRoot.textContent || ''); for (const a of ['label', 'caption', 'aria-label', 'placeholder']) if (el.getAttribute && el.getAttribute(a)) parts.push(el.getAttribute(a)); return norm(parts.join(' ')); };
  const isButton = (el, label) => /^(BUTTON|BL-BUTTON|A)$/.test(el.tagName) || (el.getAttribute && el.getAttribute('role') === 'button') ? norm(el.textContent) === norm(label) : false;
  if (/\/(login|giris|auth)/i.test(location.pathname) || document.querySelector('input[type="password"]')) return { login: true };
  const all = walk(document, []);
  // Açık pencere: içinde metin kutusu olan ve "sorun bildir" yazan diyalog
  const dialogs = all.filter((el) => (/^BL-DIALOG$/.test(el.tagName) && (el.open || el.hasAttribute('open'))) || (el.getAttribute && el.getAttribute('role') === 'dialog') || /(^|\s)(modal|dialog)(-content|-container)?(\s|$)/i.test(el.className && el.className.baseVal == null ? el.className : ''))
    .filter((el) => visible(el) && /sorun bildir/.test(deepText(el)) && walk(el, [el]).some((x) => x.tagName === 'TEXTAREA' || x.tagName === 'BL-TEXTAREA'));
  const dialog = dialogs.sort((a, b) => walk(a, []).length - walk(b, []).length)[0] || null;
  const inDialog = (el) => { for (let p = el; p; p = parentOf(p)) if (p === dialog) return true; return false; };

  if (args.action === 'state') {
    return { ready: all.some((el) => isButton(el, 'Sorun Bildir')), dialog: !!dialog };
  }
  if (args.action === 'open') {
    if (dialog) return { dialog: true };
    const buttons = all.filter((el) => isButton(el, 'Sorun Bildir') && visible(el) && !inDialog(el));
    // Her düğme için: soru metnini içeren en küçük kapsayıcı; bu kapsayıcıda başka "Sorun Bildir" olmamalı
    const hits = [];
    for (const b of buttons) {
      let p = parentOf(b);
      for (let depth = 0; p && depth < 14; depth++, p = parentOf(p)) {
        const inside = buttons.filter((x) => { for (let q = x; q; q = parentOf(q)) if (q === p) return true; return false; });
        if (inside.length > 1) break;
        if (deepText(p).includes(snippet)) { hits.push(b); break; }
      }
    }
    if (hits.length !== 1) return { found: false, matches: hits.length, buttons: buttons.length };
    hits[0].scrollIntoView && hits[0].scrollIntoView({ block: 'center' });
    hits[0].click();
    return { clicked: true };
  }
  if (args.action === 'fill') {
    if (!dialog) return { noDialog: true };
    if (!deepText(dialog).includes(snippet)) {
      const cancel = walk(dialog, []).find((el) => isButton(el, 'Vazgeç'));
      if (cancel) cancel.click();
      return { mismatch: true };
    }
    const nodes = walk(dialog, [dialog]);
    const host = nodes.find((x) => x.tagName === 'BL-TEXTAREA');
    const ta = nodes.find((x) => x.tagName === 'TEXTAREA');
    if (!ta && !host) return { noTextarea: true };
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      ta.focus && ta.focus();
      setter.call(ta, args.reason);
      ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    if (host) { try { host.value = args.reason; } catch (_) { /* yoksay */ } host.dispatchEvent(new CustomEvent('bl-input', { detail: args.reason, bubbles: true, composed: true })); }
    const submit = nodes.filter((el) => isButton(el, 'Sorun Bildir')).pop();
    if (!submit) return { noSubmit: true };
    if (submit.disabled || submit.hasAttribute('disabled')) return { disabled: true };
    submit.click();
    return { submitted: true };
  }
  if (args.action === 'check') {
    if (!dialog) return { closed: true };
    const err = walk(dialog, []).map((el) => (el.getAttribute && (el.getAttribute('role') === 'alert' || /error|hata|invalid/i.test(String(el.className || '')))) ? (el.textContent || '').trim() : '').filter(Boolean)[0] || null;
    return { open: true, error: err };
  }
  return { unknown: true };
}

/** Sayfada çalıştırılacak JS kaynağı (Electron executeJavaScript / Android evaluateJavascript). */
function buildScript(action, { text = '', reason = '' } = {}) {
  return `(${pageAction.toString()})(${JSON.stringify({ action, text: String(text), reason: String(reason) })})`;
}

/**
 * Tek bir soruyu bildirir. run(script) → sayfada çalıştırıp sonucu döndüren fonksiyon (platforma göre).
 * @returns {{ ok: boolean, login?: boolean, message: string }}
 */
async function reportOne(run, item, reason, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), readyTimeoutMs = 25000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = await run(buildScript('state')).catch(() => ({}));
    if (s && s.login) return { ok: false, login: true, message: 'Satıcı paneline giriş gerekli' };
    if (s && s.ready) break;
    if (Date.now() - t0 > readyTimeoutMs) return { ok: false, message: 'Soru listesi yüklenmedi' };
    await sleep(1500);
  }
  const o = await run(buildScript('open', item)).catch((e) => ({ error: e.message }));
  if (o && o.login) return { ok: false, login: true, message: 'Satıcı paneline giriş gerekli' };
  if (!o || !(o.clicked || o.dialog)) return { ok: false, message: o && o.matches > 1 ? 'Soru metni birden fazla satırla eşleşti; bildirilmedi' : 'Soru listede bulunamadı' };
  let f = null;
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    f = await run(buildScript('fill', { ...item, reason })).catch((e) => ({ error: e.message }));
    if (f && (f.submitted || f.mismatch || f.noTextarea || f.noSubmit)) break;
  }
  if (!f || !f.submitted) return { ok: false, message: f && f.mismatch ? 'Açılan pencere farklı bir soruya aitti; bildirilmedi' : 'Bildirim penceresi doldurulamadı' };
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const c = await run(buildScript('check')).catch(() => ({}));
    if (c && c.closed) return { ok: true, message: "Trendyol'a bildirildi" };
    if (c && c.error) return { ok: false, message: 'Panel hatası: ' + String(c.error).slice(0, 150) };
  }
  return { ok: false, message: 'Bildirim onaylanmadı (pencere kapanmadı)' };
}

module.exports = { QUESTIONS_URL, buildScript, reportOne, pageAction };
