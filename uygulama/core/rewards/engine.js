'use strict';

/**
 * Ödül kartlarını sınıflandırır ve otomatik talep kararlarını verir. Saf mantık — test edilebilir.
 *
 * Sınıflar:
 *  claimed      : Alınmış / kullanılmış
 *  unavailable  : Kilitli, şartı sağlanmamış, süresi dolmuş, buton pasif
 *  costly       : Puan, jeton, para vb. harcama gerektiriyor  -> asla otomatik alınmaz
 *  conditional  : Ek şart/koşul içeriyor                       -> asla otomatik alınmaz
 *  free         : Harcama/şart ifadesi yok ve talep butonu aktif
 *  points       : Trendyol Ödül Mağazası'nda PUANLA alınan ödül (ör. kupon). Yalnızca kullanıcının açıkça
 *                 tanımladığı kurala (en fazla X puan, en az Y puan bakiye kalsın) uyarsa otomatik alınabilir.
 */
const RX = {
  claimed: /(alındı|kullanıldı|talep edildi|kazanıldı|tanımlandı|aktif edildi|hesabınıza eklendi)/i,
  unavailable: /(kilitli|yetersiz|süresi doldu|süresi bitti|tükendi|uygun değil|stokta yok|henüz açılmadı|yakında)/i,
  cost: /(\d[\d.,]*\s*(puan|jeton|coin|kredi|altın|elmas|yıldız)\b)|((puan|jeton|kredi|coin)\w*\s*(harca|kullan|karşılığ|düş))|(\d[\d.,]*\s*(₺|tl)\b)|(ücretli)/i,
  conditional: /(şart|koşul|gerekli|gerekir|minimum|en az|tamamlamanız|tamamladığınızda|başvuru)/i,
  freeMarker: /(ücretsiz|bedava|hediye|free)/i,
};

function classifyTrendyol(card) {
  if (card.ambiguous) return { cls: 'unavailable', reason: 'Aynı ödülden birden fazla kart (otomatik işlem yapılmaz)' };
  if (RX.claimed.test(String(card.buttonText || '').toLocaleLowerCase('tr-TR'))) return { cls: 'claimed', reason: 'Alınmış' };
  if (card.soldOut) return { cls: 'unavailable', reason: 'Tükendi (ödüller her hafta yenilenir)' };
  if (!card.isClaimButton) return { cls: 'unavailable', reason: card.cardDisabled ? 'Kart pasif' : 'Alma butonu yok' };
  if (Number(card.cost) > 0) return { cls: 'points', reason: `${Number(card.cost).toLocaleString('tr-TR')} puan karşılığında` };
  return { cls: 'free', reason: 'Puan maliyeti yok', explicitFree: true };
}

function classify(card) {
  if (card.presetCls) return { cls: card.presetCls, reason: card.presetReason || '', explicitFree: card.presetCls === 'free' };
  if (card.source === 'trendyol') return classifyTrendyol(card);
  const text = String(card.text || '');
  const t = text.toLocaleLowerCase('tr-TR');
  if (RX.claimed.test(t) && !card.isClaimButton) return { cls: 'claimed', reason: 'Alınmış görünüyor' };
  if (RX.claimed.test(String(card.buttonText || '').toLocaleLowerCase('tr-TR'))) return { cls: 'claimed', reason: 'Buton: ' + card.buttonText };
  if (card.buttonDisabled) return { cls: 'unavailable', reason: 'Talep butonu pasif' };
  if (card.ambiguous) return { cls: 'unavailable', reason: 'Aynı başlıklı birden fazla kart (otomatik işlem yapılmaz)' };
  if (RX.unavailable.test(t)) return { cls: 'unavailable', reason: 'Uygun değil / kilitli ifadesi var' };
  if (RX.cost.test(t)) return { cls: 'costly', reason: 'Puan, jeton veya ücret harcaması içeriyor' };
  if (RX.conditional.test(t)) return { cls: 'conditional', reason: 'Ek şart/koşul ifadesi var' };
  if (!card.isClaimButton) return { cls: 'unavailable', reason: 'Talep butonu yok' };
  return { cls: 'free', reason: RX.freeMarker.test(t) ? '"Ücretsiz" ibaresi var' : 'Harcama/şart ifadesi bulunamadı', explicitFree: RX.freeMarker.test(t) };
}

/**
 * Otomatik talep edilecek kartları seçer.
 * @param cards sınıflandırılmış kartlar
 * @param opts { autoClaim, requireFreeMarker, history: {[key]: {status}}, maxPerRun }
 */
function decideClaims(cards, opts) {
  if (!opts.autoClaim && !opts.autoPoints) return [];
  const history = opts.history || {};
  const out = [];
  let balance = Number.isFinite(opts.balance) ? opts.balance : null;
  for (const c of cards) {
    if (c.cls === 'points') {
      // Puanla alınan ödül: yalnızca açık kural varsa ve bakiye biliniyorsa
      if (!opts.autoPoints || balance == null) continue;
      const cost = Number(c.cost);
      if (!(cost > 0) || cost > Number(opts.maxPoints || 0)) continue;
      if (balance - cost < Number(opts.minBalance || 0)) continue;
      const h = history[c.key];
      if (h && h.attempts > 0) continue;
      balance -= cost;
      out.push(c.key);
      if (out.length >= (opts.maxPerRun || 1)) break;
      continue;
    }
    if (!opts.autoClaim) continue;
    if (c.cls !== 'free') continue;
    if (opts.requireFreeMarker && !c.explicitFree) continue;
    const h = history[c.key];
    // Daha önce denenmiş (başarılı, başarısız veya belirsiz) bir ödül ASLA tekrar otomatik denenmez.
    if (h && h.attempts > 0) continue;
    out.push(c.key);
    if (out.length >= (opts.maxPerRun || 1)) break;
  }
  return out;
}

/**
 * Talep sonrasında sayfanın yeni haliyle sonucu doğrular.
 * success   : kart artık "alındı" sınıfında veya kart/buton kayboldu
 * failed    : sayfada açık bir hata mesajı var
 * uncertain : kart değişmeden duruyor -> otomasyon durdurulur
 */
function verifyClaim(key, afterPage, before) {
  if (!afterPage || afterPage.loginRequired) return { result: 'uncertain', reason: 'Doğrulama sırasında oturum kapalıydı' };
  // Puanla alınan ödülde en güvenilir kanıt: bakiyenin ödül maliyeti kadar düşmesi
  if (before && Number.isFinite(before.balance) && Number.isFinite(afterPage.balance) && Number(before.cost) > 0) {
    const diff = before.balance - afterPage.balance;
    if (diff === Number(before.cost)) return { result: 'success', reason: `Puan bakiyesi ${Number(before.cost).toLocaleString('tr-TR')} azaldı` };
  }
  const card = (afterPage.cards || []).find((c) => c.key === key);
  if (!card) return { result: 'success', reason: 'Talep butonu/kartı artık görünmüyor' };
  const k = classify(card);
  if (k.cls === 'claimed') return { result: 'success', reason: 'Kart "alındı" durumuna geçti' };
  if (card.source === 'trendyol' && (card.soldOut || !card.isClaimButton) && before && before.wasClaimable) {
    return { result: 'success', reason: 'Alma butonu kalktı (ödül alınmış görünüyor)' };
  }
  if (/(hata|başarısız|yapılamadı|tekrar deneyin)/i.test(card.text || '')) return { result: 'failed', reason: 'Sayfa hata mesajı gösteriyor' };
  return { result: 'uncertain', reason: 'Kart değişmedi; talebin sonucu belirlenemedi' };
}

/** Sayfa yapısı değişikliği / şüpheli durum tespiti. */
function assessPage(page, prevState) {
  if (!page || !page.ok) return { status: 'error', message: 'Sayfa okunamadı' };
  if (page.loginRequired) return { status: 'session_expired', message: 'Satıcı paneli oturumu kapalı. Ödüller sayfasından "Panele giriş yap" ile tekrar giriş yapın.' };
  if ((page.cards || []).length === 0) {
    if (prevState && prevState.lastCardCount > 0) return { status: 'structure_changed', message: 'Önceden bulunan ödül kartları artık bulunamıyor. Sayfa yapısı değişmiş olabilir; otomatik talep durduruldu.' };
    return { status: 'no_cards', message: 'Sayfada talep edilebilir ödül kartı bulunamadı.' };
  }
  return { status: 'ok', message: `${page.cards.length} ödül kartı bulundu.` };
}

module.exports = { classify, decideClaims, verifyClaim, assessPage, RX };
