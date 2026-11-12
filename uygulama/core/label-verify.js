'use strict';
/**
 * Kargo etiketi ↔ sipariş doğrulaması.
 *
 * Trendyol sticker etiketinde sipariş numarası (11 hane) ve kargo takip numarası (16 hane) düz metin olarak yazar
 * (ör. "11798812037" ve "7330038784357802"). Etiket bir siparişe ancak metninde o siparişin numarası ya da kargo
 * numarası TAM SAYI olarak geçiyorsa ve başka hiçbir siparişin numarası geçmiyorsa bağlanır.
 * Sıraya / konuma göre tahmin YAPILMAZ: eşleşme kanıtlanamazsa etiket kullanılmaz.
 */

/** Metindeki 6+ haneli sayılar (tam sayı olarak; "117970323587" içinde "11797032358" aranmaz). */
function digitTokens(text) {
  return new Set(String(text || '').match(/\d{6,}/g) || []);
}

const isId = (x) => /^\d{6,}$/.test(String(x || ''));

/** Bir siparişin etikette görünebilecek kimlikleri: sipariş no + kargo takip no(lar)ı. */
function idsOf(orderNumber, extra) {
  return [...new Set([String(orderNumber), ...(extra || []).map(String)])].filter(isId);
}

/**
 * Tek etiketin doğru siparişe ait olduğunu doğrular.
 * @param {object} a
 * @param {string} a.text         etiketin görünen metni
 * @param {string} a.orderNumber  beklenen sipariş
 * @param {string[]} [a.ids]      beklenen siparişin kargo takip no(lar)ı
 * @param {Iterable<string>} [a.others] BAŞKA siparişlerin kimlikleri (sipariş no + kargo no)
 * @returns {{ok:true, by:'order'|'tracking'|'both'} | {ok:false, reason:'missing'|'foreign', message:string}}
 */
function verifyLabel({ text, orderNumber, ids = [], others = [] }) {
  const t = digitTokens(text);
  const own = idsOf(orderNumber, ids);
  const hits = own.filter((x) => t.has(x));
  if (!hits.length) return { ok: false, reason: 'missing', message: `Etikette ${orderNumber} siparişinin numarası ya da kargo numarası yok` };
  for (const x of others) {
    const s = String(x);
    if (isId(s) && !own.includes(s) && t.has(s)) return { ok: false, reason: 'foreign', message: `Etikette başka bir siparişin numarası var (${s})` };
  }
  const byOrder = hits.includes(String(orderNumber));
  return { ok: true, by: byOrder ? (hits.length > 1 ? 'both' : 'order') : 'tracking' };
}

/**
 * Toplu belgeden ayrılan etiketleri siparişlere bağlar.
 * Her parça tam olarak BİR seçili siparişe, her seçili sipariş tam olarak BİR parçaya denk gelmeli; aksi hâlde ok:false.
 * @param {{text:string}[]} parts
 * @param {string[]} picked                 toplu yazdırmada seçilen siparişler
 * @param {Record<string,string[]>} idsByNo  sipariş → kargo takip no(lar)ı
 * @param {Iterable<string>} [others]        listedeki/bilinen diğer siparişlerin kimlikleri
 */
function assignParts(parts, picked, idsByNo = {}, others = []) {
  const owner = new Map(); // kimlik → sipariş (iki siparişte geçen kimlik belirsizdir, kullanılmaz)
  const clash = new Set();
  for (const no of picked) {
    for (const id of idsOf(no, idsByNo[no])) {
      if (owner.has(id) && owner.get(id) !== String(no)) clash.add(id);
      owner.set(id, String(no));
    }
  }
  for (const id of clash) owner.delete(id);
  if (!Array.isArray(parts) || parts.length !== picked.length) return { ok: false, reason: 'count', message: `Toplu belgede ${parts ? parts.length : 0} etiket var, ${picked.length} bekleniyordu` };
  const map = [];
  for (const p of parts) {
    const nos = new Set([...digitTokens(p.text)].filter((x) => owner.has(x)).map((x) => owner.get(x)));
    if (nos.size !== 1) return { ok: false, reason: nos.size ? 'ambiguous' : 'missing', message: nos.size ? 'Bir etikette birden çok sipariş numarası var' : 'Bir etikette sipariş/kargo numarası bulunamadı' };
    const no = [...nos][0];
    const v = verifyLabel({ text: p.text, orderNumber: no, ids: idsByNo[no], others: [...others, ...[...owner.keys()].filter((id) => owner.get(id) !== no)] });
    if (!v.ok) return { ok: false, reason: v.reason, message: v.message };
    map.push(no);
  }
  if (new Set(map).size !== map.length || !picked.every((n) => map.includes(String(n)))) return { ok: false, reason: 'mismatch', message: 'Etiketler seçilen siparişlerle birebir eşleşmedi' };
  return { ok: true, map };
}

module.exports = { digitTokens, idsOf, verifyLabel, assignParts };
