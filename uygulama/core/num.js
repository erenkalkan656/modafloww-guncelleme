'use strict';
// Node'a bağımlı olmayan sayı yardımcıları (arayüzde de kullanılır)

/** Para hesaplarında kayan nokta hatalarını önlemek için 2 basamağa yuvarlar. */
function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

module.exports = { round2 };
