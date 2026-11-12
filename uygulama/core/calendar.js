'use strict';
// Türkiye takvimi: kargo iş günleri ve Trendyol ödeme günleri için. Türkiye yaz/kış saati uygulamaz (UTC+3).
const IST = 3 * 3600 * 1000;
const DAY = 86400000;
const HOLIDAYS = new Set([
  // Sabit resmi tatiller (AA-GG)
  '01-01', '04-23', '05-01', '05-19', '07-15', '08-30', '10-29',
  // Dini bayramlar (YYYY-AA-GG)
  '2026-03-20', '2026-03-21', '2026-03-22', '2026-05-27', '2026-05-28', '2026-05-29', '2026-05-30',
  '2027-03-09', '2027-03-10', '2027-03-11', '2027-05-16', '2027-05-17', '2027-05-18', '2027-05-19',
]);
/** Zaman damgasının İstanbul'daki takvim günü (YYYY-AA-GG). */
const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
/** İstanbul gününün başlangıcı (ms). */
const istDayStart = (ms) => Date.parse(istDate(ms) + 'T00:00:00Z') - IST;
const weekday = (ymd) => new Date(ymd + 'T00:00:00Z').getUTCDay();
const isHoliday = (ymd) => HOLIDAYS.has(ymd.slice(5)) || HOLIDAYS.has(ymd);
/** Kargo iş günü: Pazar ve resmi tatiller hariç. */
const isWorkday = (ymd) => weekday(ymd) !== 0 && !isHoliday(ymd);
/** fromDay'den sonra toDay dahil kaç kargo iş günü var. */
function workdaysBetween(fromDay, toDay) {
  let n = 0;
  let d = Date.parse(fromDay + 'T00:00:00Z');
  const end = Date.parse(toDay + 'T00:00:00Z');
  for (let i = 0; d < end && i < 60; i++) { d += DAY; if (isWorkday(new Date(d).toISOString().slice(0, 10))) n++; }
  return n;
}
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const ymdToMs = (ymd) => Date.parse(ymd + 'T00:00:00Z') - IST;
/** Tatile denk gelen ödeme günü bir sonraki hafta içi iş gününe kayar (ör. 29 Ekim Perşembe → 30 Ekim Cuma). */
function shiftHoliday(ymd) {
  let d = ymd;
  for (let i = 0; i < 10 && (isHoliday(d) || weekday(d) === 0 || weekday(d) === 6); i++) d = addDays(d, 1);
  return d;
}
const PAY_DAYS = [1, 4]; // Türkiye ödemeleri: pazartesi ve perşembe
/** ms'den ÖNCEKİ veya aynı gündeki ilk Pzt/Per (YYYY-AA-GG, tatil kaydırması uygulanmadan). */
function payDayOnOrBefore(ms) { let d = istDate(ms); for (let i = 0; i < 7 && !PAY_DAYS.includes(weekday(d)); i++) d = addDays(d, -1); return d; }
/** ms'den SONRAKİ veya aynı gündeki ilk Pzt/Per. */
function payDayOnOrAfter(ms) { let d = istDate(ms); for (let i = 0; i < 7 && !PAY_DAYS.includes(weekday(d)); i++) d = addDays(d, 1); return d; }
/** Ayın 4. pazartesisi (Avrupa ödeme günü). */
function fourthMonday(y, m) { const first = new Date(Date.UTC(y, m, 1)); const add = (8 - first.getUTCDay()) % 7; return new Date(Date.UTC(y, m, 1 + add + 21)).toISOString().slice(0, 10); }
function euPayDayOnOrAfter(ms) {
  const ymd = istDate(ms);
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)) - 1;
  let t = fourthMonday(y, m);
  if (t < ymd) t = fourthMonday(m === 11 ? y + 1 : y, (m + 1) % 12);
  return t;
}

module.exports = { IST, DAY, HOLIDAYS, istDate, istDayStart, isHoliday, isWorkday, workdaysBetween, addDays, ymdToMs, shiftHoliday, payDayOnOrBefore, payDayOnOrAfter, euPayDayOnOrAfter, fourthMonday };
