'use strict';

/**
 * Türkçe Excel ile uyumlu CSV üretir:
 * - UTF-8 BOM (Türkçe karakterler bozulmaz)
 * - Ayraç noktalı virgül (;)
 * - Sayılarda ondalık ayırıcı virgül
 */
function cell(v, type) {
  if (v == null) return '';
  if (type === 'money' || type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return (type === 'money' ? n.toFixed(2) : String(n)).replace('.', ',');
  }
  if (type === 'date') {
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    if (isNaN(d)) return String(v);
    return d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  }
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Formül enjeksiyonunu önle
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCSV(rows, columns) {
  const head = columns.map((c) => cell(c.label)).join(';');
  const body = rows.map((r) => columns.map((c) => cell(typeof c.get === 'function' ? c.get(r) : r[c.key], c.type)).join(';'));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

module.exports = { toCSV };
