'use strict';
// Görünüm ve kişiselleştirme — bilgisayar ve telefon aynı tema motorunu kullanır.
// Renkler merkezi CSS değişkenleriyle uygulanır; her alan ayrı değiştirilebilir. Metin renkleri ve
// türetilmiş tonlar (üzerine gelme, çizgi, durum zeminleri) seçilen renge göre OTOMATİK hesaplanır,
// böylece okunaksız açık-üstüne-açık metin oluşmaz. Varsayılan tasarım: #3D3F45 / #F5F3EE / #FFFFFF / #E7E5E0.

const FIELDS = [
  { key: 'accent', label: 'Ana vurgu rengi', hint: 'İlerleme çubukları, seçimler, odak halkası' },
  { key: 'nav', label: 'Yan menü ve navigasyon', hint: 'Bilgisayar: yan menü · Telefon: alt sekme çubuğu' },
  { key: 'topbar', label: 'Üst çubuk', hint: 'Bilgisayar: üst arama çubuğu · Telefon: sayfa başlığı' },
  { key: 'canvas', label: 'Ana sayfa arka planı' },
  { key: 'panel', label: 'Kart ve panel arka planı', hint: 'Tablolar, kartlar, pencereler' },
  { key: 'primaryBtn', label: 'Birincil buton' },
  { key: 'secondaryBtn', label: 'İkincil buton' },
  { key: 'activeNav', label: 'Aktif menü ve seçili filtre' },
  { key: 'link', label: 'Bağlantı ve ikon vurgusu' },
  { key: 'line', label: 'Kenarlık ve ayırıcı' },
  { key: 'control', label: 'Seçim alanı ve sekme zemini', hint: 'Sekme grupları, ilerleme çubuğu zemini' },
  { key: 'chart1', label: 'Grafik serisi 1', group: 'chart' },
  { key: 'chart2', label: 'Grafik serisi 2', group: 'chart' },
  { key: 'chart3', label: 'Grafik serisi 3', group: 'chart' },
  { key: 'ok', label: 'Başarı (yeşil)', group: 'status' },
  { key: 'warn', label: 'Uyarı (turuncu)', group: 'status' },
  { key: 'bad', label: 'Hata (kırmızı)', group: 'status' },
];
const KEYS = FIELDS.map((f) => f.key);
const HEX = /^#[0-9a-fA-F]{6}$/;

// Varsayılan (Charcoal & Ivory) — mevcut CSS değerleriyle birebir aynı
const COMMON = {
  light: { accent: '#3D3F45', topbar: '#3D3F45', canvas: '#F5F3EE', panel: '#FFFFFF', primaryBtn: '#3D3F45', secondaryBtn: '#FFFFFF', link: '#242529', line: '#E7E5E0', control: '#E7E5E0', chart1: '#3D3F45', chart2: '#CFCCC4', chart3: '#8E9096', ok: '#1F8A4C', warn: '#D97A06', bad: '#D92D20' },
  dark: { accent: '#E6E4DF', topbar: '#1E1F23', canvas: '#26272C', panel: '#2E2F35', primaryBtn: '#E6E4DF', secondaryBtn: '#2E2F35', link: '#ECEAE5', line: '#3A3B42', control: '#3A3B42', chart1: '#E6E4DF', chart2: '#55575F', chart3: '#8E9096', ok: '#3ECF8E', warn: '#F0B04C', bad: '#F0616B' },
};
const BASE = {
  desktop: { light: { ...COMMON.light, nav: '#3D3F45', activeNav: '#F5F3EE' }, dark: { ...COMMON.dark, nav: '#1E1F23', activeNav: '#34363C' } },
  mobile: { light: { ...COMMON.light, nav: '#FFFFFF', activeNav: '#E7E5E0', chart2: '#C4C1B9', chart3: '#8A8C92' }, dark: { ...COMMON.dark, nav: '#2E2F35', activeNav: '#3A3B42', chart2: '#5A5B63', chart3: '#7C7E85' } },
};

const PRESETS = [
  { id: 'charcoal', name: 'Charcoal & Ivory', desc: 'Varsayılan: koyu gri ve kırık beyaz', light: {}, dark: {} },
  { id: 'mozaik', name: 'Mozaik Turuncu', desc: 'Açıkta kum zemin, koyuda gece; Trendyol turuncusu',
    light: { accent: '#F27A1A', nav: '#FFFDF9', topbar: '#F2EDE4', canvas: '#F2EDE4', panel: '#FFFDF9', primaryBtn: '#F27A1A', secondaryBtn: '#FFFDF9', activeNav: '#F27A1A', link: '#A84600', line: '#D8CFBF', control: '#EAE2D4', chart1: '#F27A1A', chart2: '#EDBE98', chart3: '#9A948C' },
    dark: { accent: '#F27A1A', nav: '#1B1E25', topbar: '#0A0B0E', canvas: '#0A0B0E', panel: '#16181E', primaryBtn: '#F27A1A', secondaryBtn: '#22252E', activeNav: '#F27A1A', link: '#FF9A4D', line: '#3B404C', control: '#2B2F39', chart1: '#F27A1A', chart2: '#3A3E48', chart3: '#8E9099' } },
  { id: 'mavi', name: 'Gece Mavisi', desc: 'Koyu lacivert zemin ve mavi vurgu',
    light: { accent: '#2459C4', nav: '#FFFFFF', topbar: '#EDF1F8', canvas: '#EDF1F8', panel: '#FFFFFF', primaryBtn: '#2459C4', secondaryBtn: '#FFFFFF', activeNav: '#2459C4', link: '#1E55BF', line: '#CFD8E8', control: '#DFE6F2', chart1: '#2459C4', chart2: '#A9C3F2', chart3: '#8591A6' },
    dark: { accent: '#5B9BFF', nav: '#131D30', topbar: '#070B14', canvas: '#070B14', panel: '#101827', primaryBtn: '#5B9BFF', secondaryBtn: '#182338', activeNav: '#5B9BFF', link: '#A9CBFF', line: '#2F3E5C', control: '#1B2740', chart1: '#5B9BFF', chart2: '#2A3B5E', chart3: '#8291AD' } },
  { id: 'zumrut', name: 'Zümrüt', desc: 'Koyu yeşil zemin ve zümrüt vurgu',
    light: { accent: '#0D7049', nav: '#FFFFFF', topbar: '#EDF4F0', canvas: '#EDF4F0', panel: '#FFFFFF', primaryBtn: '#0D7049', secondaryBtn: '#FFFFFF', activeNav: '#0D7049', link: '#0C6A47', line: '#CCDDD3', control: '#DCE9E1', chart1: '#0D7049', chart2: '#A5D6BF', chart3: '#84958B' },
    dark: { accent: '#34D399', nav: '#12211A', topbar: '#06100C', canvas: '#06100C', panel: '#0F1B16', primaryBtn: '#34D399', secondaryBtn: '#16261E', activeNav: '#34D399', link: '#9BEBC6', line: '#2D4A3D', control: '#18291F', chart1: '#34D399', chart2: '#234436', chart3: '#7E968A' } },
  { id: 'mor', name: 'Mor Gece', desc: 'Koyu mor zemin ve lila vurgu',
    light: { accent: '#6D4AE0', nav: '#FFFFFF', topbar: '#F1EEF9', canvas: '#F1EEF9', panel: '#FFFFFF', primaryBtn: '#6D4AE0', secondaryBtn: '#FFFFFF', activeNav: '#6D4AE0', link: '#5535C2', line: '#D7D0EA', control: '#E4DEF3', chart1: '#6D4AE0', chart2: '#C3B5F3', chart3: '#8D86A6' },
    dark: { accent: '#A78BFA', nav: '#1B1832', topbar: '#0C0A14', canvas: '#0C0A14', panel: '#17142A', primaryBtn: '#A78BFA', secondaryBtn: '#201C3A', activeNav: '#A78BFA', link: '#D2C4FF', line: '#3A3460', control: '#231E3D', chart1: '#A78BFA', chart2: '#3A3166', chart3: '#8B84AD' } },
  { id: 'midnight', name: 'Midnight Blue', desc: 'Lacivert ve açık gri',
    light: { accent: '#1E3A8A', nav: '#0F1E3D', topbar: '#0F1E3D', canvas: '#EEF1F6', panel: '#FFFFFF', primaryBtn: '#1E3A8A', secondaryBtn: '#FFFFFF', activeNav: '#E3E9F5', link: '#1E3A8A', line: '#DDE3EC', control: '#E3E8F0', chart1: '#1E3A8A', chart2: '#A9BADB', chart3: '#5B7BB5' },
    dark: { accent: '#8FB0F0', nav: '#0B1426', topbar: '#0B1426', canvas: '#111A2C', panel: '#18233A', primaryBtn: '#8FB0F0', secondaryBtn: '#18233A', activeNav: '#22314F', link: '#A9C1F5', line: '#26344F', control: '#26344F', chart1: '#8FB0F0', chart2: '#3E5480', chart3: '#6C8BC7' } },
  { id: 'graphite', name: 'Graphite & Purple', desc: 'Antrasit ve mor vurgu',
    light: { accent: '#5B3FD9', nav: '#2B2D33', topbar: '#2B2D33', canvas: '#F4F3F7', panel: '#FFFFFF', primaryBtn: '#5B3FD9', secondaryBtn: '#FFFFFF', activeNav: '#ECE8FB', link: '#5B3FD9', line: '#E4E2EA', control: '#E7E5EE', chart1: '#5B3FD9', chart2: '#C4BAF2', chart3: '#8A80B8' },
    dark: { accent: '#A694FF', nav: '#18191D', topbar: '#18191D', canvas: '#202126', panel: '#292A30', primaryBtn: '#A694FF', secondaryBtn: '#292A30', activeNav: '#34304A', link: '#B7A9FF', line: '#36373F', control: '#36373F', chart1: '#A694FF', chart2: '#4B4470', chart3: '#7A6FB8' } },
  { id: 'slate', name: 'Slate & Teal', desc: 'Gri ve turkuaz vurgu',
    light: { accent: '#0F766E', nav: '#334155', topbar: '#334155', canvas: '#F1F5F9', panel: '#FFFFFF', primaryBtn: '#0F766E', secondaryBtn: '#FFFFFF', activeNav: '#E2E8F0', link: '#0F766E', line: '#E2E8F0', control: '#E2E8F0', chart1: '#0F766E', chart2: '#A7D8D2', chart3: '#64748B' },
    dark: { accent: '#2DD4BF', nav: '#0F172A', topbar: '#0F172A', canvas: '#172033', panel: '#1E293B', primaryBtn: '#2DD4BF', secondaryBtn: '#1E293B', activeNav: '#273449', link: '#5EEAD4', line: '#2B3A52', control: '#2B3A52', chart1: '#2DD4BF', chart2: '#285E5A', chart3: '#64748B' } },
  { id: 'forest', name: 'Forest', desc: 'Koyu yeşil ve kırık beyaz',
    light: { accent: '#2F6B45', nav: '#1F3D2B', topbar: '#1F3D2B', canvas: '#F5F3EE', panel: '#FFFFFF', primaryBtn: '#2F6B45', secondaryBtn: '#FFFFFF', activeNav: '#F5F3EE', link: '#2F6B45', line: '#E4E2DA', control: '#E7E5DE', chart1: '#2F6B45', chart2: '#B5D2BE', chart3: '#7C8F80' },
    dark: { accent: '#8FCB9F', nav: '#14231A', topbar: '#14231A', canvas: '#1B261F', panel: '#223027', primaryBtn: '#8FCB9F', secondaryBtn: '#223027', activeNav: '#2B3D31', link: '#A6D8B3', line: '#2F4135', control: '#2F4135', chart1: '#8FCB9F', chart2: '#3C5A45', chart3: '#6F8574' } },
  { id: 'mono', name: 'Monochrome', desc: 'Siyah, beyaz ve gri tonları',
    light: { accent: '#111111', nav: '#111111', topbar: '#111111', canvas: '#F4F4F4', panel: '#FFFFFF', primaryBtn: '#111111', secondaryBtn: '#FFFFFF', activeNav: '#F4F4F4', link: '#111111', line: '#E3E3E3', control: '#E6E6E6', chart1: '#111111', chart2: '#C4C4C4', chart3: '#7A7A7A' },
    dark: { accent: '#F2F2F2', nav: '#000000', topbar: '#000000', canvas: '#121212', panel: '#1C1C1C', primaryBtn: '#F2F2F2', secondaryBtn: '#1C1C1C', activeNav: '#2A2A2A', link: '#FFFFFF', line: '#2E2E2E', control: '#2E2E2E', chart1: '#F2F2F2', chart2: '#4A4A4A', chart3: '#8A8A8A' } },
];
// Telefonda alt sekme çubuğu açık kalsın diye hazır temalarda varsayılan "nav" yalnızca masaüstü yan menüsüne uygulanır
const MOBILE_PRESET_NAV = { light: (p) => p.panel || '#FFFFFF', dark: (p) => p.panel };

const DEFAULT_APPEARANCE = { mode: 'light', preset: 'charcoal', custom: { light: {}, dark: {} }, saved: [] };

// ---------------------------------------------------------------- Renk hesapları
function rgb(hex) { const h = String(hex).replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function hex([r, g, b]) { return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('').toUpperCase(); }
function lum(h) { const c = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function mix(a, b, t) { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); }
function rgba(h, a) { const [r, g, b] = rgb(h); return `rgba(${r}, ${g}, ${b}, ${a})`; }
function tint(h) { return rgb(h).join(', '); }
const DARK_TEXT = '#242529';
const LIGHT_TEXT = '#F5F3EE';
/** Arka plana en okunaklı metin rengi (koyu gri ya da kırık beyaz; ikisi de yetmezse siyah/beyaz). */
function textOn(bg) {
  const d = contrast(DARK_TEXT, bg), l = contrast(LIGHT_TEXT, bg);
  if (Math.max(d, l) >= 4.5) return d >= l ? DARK_TEXT : LIGHT_TEXT;
  return contrast('#000000', bg) >= contrast('#FFFFFF', bg) ? '#000000' : '#FFFFFF';
}
function hue(h) {
  const [r, g, b] = rgb(h).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return null;
  let x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  x *= 60;
  return x < 0 ? x + 360 : x;
}
/** Bir rengi arka plana karşı en az `min` kontrasta ulaşana kadar koyulaştırır/açar (öneri için). */
function ensureContrast(fg, bg, min = 4.5) {
  if (contrast(fg, bg) >= min) return fg.toUpperCase();
  const toward = lum(bg) > 0.4 ? '#000000' : '#FFFFFF';
  for (let t = 0.05; t <= 1; t += 0.05) { const c = mix(fg, toward, t); if (contrast(c, bg) >= min) return c; }
  return toward;
}
const isHex = (v) => HEX.test(String(v || ''));
const normHex = (v) => { let s = String(v || '').trim(); if (/^[0-9a-fA-F]{6}$/.test(s)) s = '#' + s; if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join(''); return isHex(s) ? s.toUpperCase() : null; };

// ---------------------------------------------------------------- Paletler
function baseOf(platform, mode) { return BASE[platform === 'mobile' ? 'mobile' : 'desktop'][mode === 'dark' ? 'dark' : 'light']; }
function presetOf(id) { return PRESETS.find((p) => p.id === id) || PRESETS[0]; }
/** Seçili hazır tema + kişisel değişikliklerle tam palet (her alanın HEX değeri). */
function resolvePalette(appearance, mode, platform = 'desktop') {
  const a = normalizeAppearance(appearance);
  const m = mode === 'dark' ? 'dark' : 'light';
  const pre = presetOf(a.preset)[m];
  const preset = { ...pre };
  if (platform === 'mobile' && pre.nav && a.preset !== 'charcoal') preset.nav = MOBILE_PRESET_NAV[m]({ ...baseOf(platform, m), ...pre });
  if (platform === 'mobile' && pre.activeNav) preset.activeNav = pre.control || pre.activeNav;
  return { ...baseOf(platform, m), ...preset, ...(a.custom[m] || {}) };
}

/**
 * CSS değişkenleri. Varsayılanla aynı olan alanlar için değişken üretilmez (CSS'teki değer kullanılır),
 * böylece varsayılan tasarım birebir korunur.
 */
function buildVars(palette, mode, platform = 'desktop') {
  const base = baseOf(platform, mode);
  const p = { ...base, ...palette };
  const v = {};
  const changed = (k) => p[k] && base[k] && p[k].toUpperCase() !== base[k].toUpperCase();
  const dark = mode === 'dark';
  if (changed('accent')) {
    const fg = textOn(p.accent);
    Object.assign(v, { '--accent': p.accent, '--accent-hover': mix(p.accent, lum(p.accent) > 0.4 ? '#FFFFFF' : '#000000', 0.18), '--accent-fg': fg, '--accent-fg-2': rgba(fg, contrast(fg, p.accent) < 7 ? 0.88 : 0.74), '--accent-fg-3': rgba(fg, 0.62), '--tint': tint(p.accent) });
  }
  const area = (k, prefix) => {
    if (!changed(k)) return;
    const fg = textOn(p[k]);
    v[`--${prefix}-bg`] = p[k];
    v[`--${prefix}-fg`] = fg;
    v[`--${prefix}-fg-2`] = rgba(fg, 0.66);
    v[`--${prefix}-fg-3`] = rgba(fg, 0.5);
    v[`--${prefix}-tint`] = tint(fg);
    v[`--${prefix}-warn`] = lum(p[k]) > 0.35 ? '#9A4A00' : '#FFC56E';
  };
  area('nav', 'nav');
  area('topbar', 'top');
  const far = contrast(p.panel, p.canvas) > 1.25; // sayfa ve kart zemini belirgin farklı tonda mı
  const canvasText = () => {
    const fg = textOn(p.canvas);
    Object.assign(v, { '--fg-canvas': fg, '--fg-2-canvas': mix(fg, p.canvas, 0.22), '--fg-3-canvas': ensureContrast(mix(fg, p.canvas, 0.36), p.canvas, 4.5), '--fg-4-canvas': mix(fg, p.canvas, 0.5) });
  };
  if (changed('canvas')) {
    v['--canvas'] = p.canvas;
    canvasText();
    v['--inset'] = far ? mix(p.panel, textOn(p.panel), 0.05) : p.canvas;
    if (!changed('panel')) { v['--raise'] = far ? mix(p.panel, textOn(p.panel), 0.025) : mix(p.panel, p.canvas, 0.45); v['--row-hover'] = far ? mix(p.panel, textOn(p.panel), 0.02) : mix(p.panel, p.canvas, 0.3); }
  }
  if (changed('panel')) {
    const fg = textOn(p.panel);
    Object.assign(v, {
      '--panel': p.panel, '--overlay': p.panel, '--card': p.panel,
      '--raise': far ? mix(p.panel, fg, 0.025) : mix(p.panel, p.canvas, 0.45), '--row-hover': far ? mix(p.panel, fg, 0.02) : mix(p.panel, p.canvas, 0.3), '--row-sel-strong': mix(p.panel, fg, 0.07),
      '--inset': far ? mix(p.panel, fg, 0.05) : p.canvas,
      '--field': dark ? mix(p.panel, '#000000', 0.18) : p.panel, '--cell-line': mix(p.panel, p.line, 0.6),
      '--fg': fg, '--fg-2': ensureContrast(mix(fg, p.panel, 0.32), p.panel, 6), '--fg-3': ensureContrast(mix(fg, p.panel, 0.5), p.panel, 4.5), '--fg-4': mix(fg, p.panel, 0.55),
      '--knob': dark ? mix(p.panel, '#FFFFFF', 0.7) : '#FFFFFF',
    });
    canvasText();
  }
  if (changed('primaryBtn')) {
    const fg = textOn(p.primaryBtn);
    Object.assign(v, { '--btn-primary': p.primaryBtn, '--btn-primary-hover': mix(p.primaryBtn, lum(p.primaryBtn) > 0.4 ? '#FFFFFF' : '#000000', 0.15), '--btn-primary-fg': fg });
  }
  if (changed('secondaryBtn')) {
    const fg = textOn(p.secondaryBtn);
    Object.assign(v, { '--btn-bg': p.secondaryBtn, '--btn-fg': fg, '--btn-hover': mix(p.secondaryBtn, fg, 0.06) });
  }
  if (changed('activeNav')) {
    const fg = textOn(p.activeNav);
    Object.assign(v, { '--nav-active-bg': p.activeNav, '--nav-active-fg': fg, '--nav-active-count': rgba(fg, 0.14) });
    // Seçili filtre çipi kart üzerinde durur: kart zemininden ayırt edilemiyorsa vurgu rengi kullanılır
    const selBg = contrast(p.activeNav, p.panel) >= 1.5 ? p.activeNav : p.accent;
    Object.assign(v, { '--sel-bg': selBg, '--sel-fg': textOn(selBg) });
  }
  if (changed('link')) v['--link'] = ensureContrast(p.link, p.panel, 4.5);
  if (changed('line')) {
    const fg = textOn(p.panel);
    Object.assign(v, { '--line': p.line, '--line-2': mix(p.line, fg, 0.08), '--line-3': mix(p.line, fg, 0.2), '--border': p.line });
  }
  if (changed('control')) v['--surface-2'] = p.control;
  if (changed('chart1')) v['--chart-1'] = p.chart1;
  if (changed('chart2')) { v['--chart-2'] = p.chart2; v['--spark'] = p.chart2; }
  if (changed('chart3')) { v['--chart-3'] = p.chart3; v['--spark-hover'] = p.chart3; }
  for (const k of ['ok', 'warn', 'bad']) {
    if (!changed(k)) continue;
    const c = p[k];
    const bg = dark ? mix(p.panel, c, 0.16) : mix('#FFFFFF', c, 0.11);
    v[`--${k}`] = c;
    v[`--${k}-bg`] = bg;
    v[`--${k}-line`] = dark ? mix(p.panel, c, 0.4) : mix('#FFFFFF', c, 0.35);
    v[`--${k}-fg`] = ensureContrast(dark ? mix(c, '#FFFFFF', 0.35) : mix(c, '#000000', 0.2), bg, 4.5);
  }
  return v;
}

/** Okunabilirlik denetimi: seçilen renklerle oluşan metin/zemin çiftleri ve durum renklerinin anlamı. */
function checkPalette(palette, mode, platform = 'desktop') {
  const p = { ...baseOf(platform, mode), ...palette };
  const out = [];
  // İçerik zeminlerinde (kart, sayfa) ikincil metin ve ipuçları da okunmalı: orta tonlar (siyah/beyazla bile < 7:1) hata
  const textPair = (key, label, min = 4.5, content = false) => {
    const bg = p[key];
    const best = Math.max(contrast('#000000', bg), contrast('#FFFFFF', bg));
    const sugg = lum(bg) > 0.18 ? mix(bg, '#FFFFFF', 0.55) : mix(bg, '#000000', 0.5);
    if (content && best < 7) out.push({ key, level: 'error', message: `${label}: orta tonda bir renk; ikincil metinler ve ipuçları okunaksız olur. Daha açık veya daha koyu bir ton seçin.`, suggestion: sugg });
    else if (contrast(textOn(bg), bg) < min) out.push({ key, level: 'error', message: `${label}: üzerindeki metin okunaklı olmaz (kontrast ${contrast(textOn(bg), bg).toFixed(1)}:1).`, suggestion: sugg });
    else if (Math.max(contrast(DARK_TEXT, bg), contrast(LIGHT_TEXT, bg)) < min) out.push({ key, level: 'warn', message: `${label}: okunabilirlik için metin saf siyah/beyaz yapıldı (kontrast ${contrast(textOn(bg), bg).toFixed(1)}:1).`, suggestion: sugg });
  };
  textPair('panel', 'Kart ve panel arka planı', 4.5, true);
  textPair('canvas', 'Ana sayfa arka planı', 4.5, true);
  textPair('nav', 'Yan menü / navigasyon');
  textPair('topbar', 'Üst çubuk');
  textPair('primaryBtn', 'Birincil buton');
  textPair('secondaryBtn', 'İkincil buton');
  textPair('activeNav', 'Aktif menü ve seçili filtre');
  textPair('accent', 'Ana vurgu rengi', 3);
  if (contrast(p.link, p.panel) < 4.5) out.push({ key: 'link', level: 'warn', message: `Bağlantı rengi kart zemininde zor okunur (${contrast(p.link, p.panel).toFixed(1)}:1). Uygulamada otomatik koyulaştırılır.`, suggestion: ensureContrast(p.link, p.panel, 4.5) });
  if (contrast(p.accent, p.panel) < 1.6) out.push({ key: 'accent', level: 'warn', message: 'Vurgu rengi kart zemininden zor ayırt ediliyor (ilerleme çubukları, seçimler).', suggestion: ensureContrast(p.accent, p.panel, 3) });
  if (contrast(textOn(p.panel), p.control) < 4.5) out.push({ key: 'control', level: 'error', message: 'Seçim alanı/sekme zemini kart metniyle okunaksız; kart zeminine yakın bir ton seçin.', suggestion: mix(p.panel, textOn(p.panel), 0.1) });
  if (contrast(p.line, p.panel) < 1.08) out.push({ key: 'line', level: 'warn', message: 'Kenarlıklar kart zemininde neredeyse görünmüyor.', suggestion: mix(p.panel, textOn(p.panel), 0.14) });
  if (contrast(p.panel, p.canvas) < 1.03 && contrast(p.line, p.panel) < 1.15) out.push({ key: 'panel', level: 'warn', message: 'Kartlar arka plandan ayırt edilemiyor; kart veya arka plan rengini ya da kenarlığı değiştirin.' });
  for (const k of ['chart1', 'chart2', 'chart3']) if (contrast(p[k], p.panel) < 1.5) out.push({ key: k, level: 'warn', message: `${FIELDS.find((f) => f.key === k).label} kart zemininde zor görünür.`, suggestion: ensureContrast(p[k], p.panel, 2) });
  if (contrast(p.chart1, p.chart2) < 1.3) out.push({ key: 'chart2', level: 'warn', message: 'Grafik serisi 1 ve 2 birbirine çok yakın.' });
  // Durum renkleri anlamını korumalı: kırmızı hata, yeşil başarı, turuncu uyarı
  const HUES = { ok: [75, 175, 'yeşil'], warn: [18, 55, 'turuncu/sarı'], bad: [-25, 15, 'kırmızı'] };
  for (const k of ['ok', 'warn', 'bad']) {
    const h = hue(p[k]);
    const [a, b, name] = HUES[k];
    const hh = h != null && h > 300 ? h - 360 : h;
    if (h == null || hh < a || hh > b) out.push({ key: k, level: 'warn', message: `${FIELDS.find((f) => f.key === k).label}: ${name} tonunda olmadığı için anlamı karışabilir.`, suggestion: baseOf(platform, mode)[k] });
    if (contrast(p[k], p.panel) < 2) out.push({ key: k, level: 'warn', message: `${FIELDS.find((f) => f.key === k).label} kart zemininde zor görünür.` });
  }
  return out;
}

/** Diskten/sunucudan gelen değeri güvenli hâle getirir (geçersiz HEX ve bilinmeyen alanlar atılır). */
function normalizeAppearance(a) {
  const x = a && typeof a === 'object' ? a : {};
  const cleanMap = (m) => { const o = {}; for (const k of KEYS) { const h = m && normHex(m[k]); if (h) o[k] = h; } return o; };
  return {
    mode: ['light', 'dark', 'system'].includes(x.mode) ? x.mode : DEFAULT_APPEARANCE.mode,
    preset: PRESETS.some((p) => p.id === x.preset) ? x.preset : 'charcoal',
    custom: { light: cleanMap(x.custom && x.custom.light), dark: cleanMap(x.custom && x.custom.dark) },
    saved: (Array.isArray(x.saved) ? x.saved : []).slice(0, 30).map((s) => ({ name: String((s && s.name) || '').trim().slice(0, 40), preset: PRESETS.some((p) => p.id === (s && s.preset)) ? s.preset : 'charcoal', colors: flatClean(s && s.colors) })).filter((s) => s.name),
  };
}
/** Kayıtlı palet renkleri düz bir haritada tutulur: { 'light.accent': '#..', 'dark.panel': '#..' } */
function flatClean(m) { const o = {}; for (const [k, v] of Object.entries(m || {})) { const [mode, key] = String(k).split('.'); const h = normHex(v); if ((mode === 'light' || mode === 'dark') && KEYS.includes(key) && h) o[`${mode}.${key}`] = h; } return o; }
function toSaved(name, appearance) { const a = normalizeAppearance(appearance); const colors = {}; for (const m of ['light', 'dark']) for (const [k, v] of Object.entries(a.custom[m])) colors[`${m}.${k}`] = v; return { name: String(name).trim().slice(0, 40), preset: a.preset, colors }; }
function fromSaved(saved, appearance) { const a = normalizeAppearance(appearance); const custom = { light: {}, dark: {} }; for (const [k, v] of Object.entries(flatClean(saved.colors))) { const [m, key] = k.split('.'); custom[m][key] = v; } return { ...a, preset: saved.preset || 'charcoal', custom }; }

/** Tarayıcıda uygula: önceki değişkenleri temizler, yenilerini kök öğeye yazar. */
function applyToDocument(doc, vars) {
  const root = doc.documentElement;
  const prev = (root.dataset.themeVars || '').split(',').filter(Boolean);
  for (const k of prev) if (!(k in vars)) root.style.removeProperty(k);
  for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
  root.dataset.themeVars = Object.keys(vars).join(',');
}

module.exports = { FIELDS, KEYS, BASE, PRESETS, DEFAULT_APPEARANCE, resolvePalette, buildVars, checkPalette, normalizeAppearance, toSaved, fromSaved, applyToDocument, contrast, textOn, normHex, isHex, ensureContrast, mix, hue };
