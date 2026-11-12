'use strict';
const crypto = require('crypto');

/**
 * API anahtarlarını Windows DPAPI (Electron safeStorage) ile şifreler.
 * Şifreli değer yalnızca bu Windows kullanıcı hesabında, bu bilgisayarda çözülebilir;
 * dosya başka bir bilgisayara veya hesaba kopyalanırsa çözülemez.
 *
 * Windows'ta DPAPI kullanılamıyorsa anahtar KAYDEDİLMEZ (zayıf yedek yöntem yok).
 * 'local' biçimi yalnızca eski kayıtları okuyup DPAPI'ye taşımak ve Windows dışı
 * geliştirme/test ortamları için tutulur.
 */
function createSecrets(safeStorage, { platform = process.platform } = {}) {
  const available = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (_) { return false; } };
  const localKey = () => crypto.createHash('sha256').update('tsp|' + require('os').hostname() + '|' + require('os').userInfo().username).digest();
  const api = {
    available,
    /** Bu kayıt güçlü (işletim sistemi) şifrelemesiyle mi korunuyor? */
    isStrong(obj) { return !!(obj && obj.m === 'dpapi'); },
    encrypt(plain) {
      if (plain == null || plain === '') return null;
      if (available()) return { m: 'dpapi', v: safeStorage.encryptString(String(plain)).toString('base64') };
      if (platform === 'win32') {
        const e = new Error('Windows güvenli depolama (DPAPI) şu an kullanılamıyor; anahtar güvenli saklanamayacağı için kaydedilmedi. Bilgisayarı yeniden başlatıp tekrar deneyin.');
        e.code = 'secure_storage_unavailable';
        throw e;
      }
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return { m: 'local', v: Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64') };
    },
    decrypt(obj) {
      if (!obj || !obj.v) return null;
      const buf = Buffer.from(obj.v, 'base64');
      if (obj.m === 'dpapi') return safeStorage.decryptString(buf);
      const d = crypto.createDecipheriv('aes-256-gcm', localKey(), buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
    /** Eski 'local' kaydı DPAPI ile yeniden şifreler; değişmediyse aynı nesneyi döner. */
    upgrade(obj) {
      if (!obj || obj.m === 'dpapi' || !available()) return obj;
      return api.encrypt(api.decrypt(obj));
    },
  };
  return api;
}

/** Metindeki gizli değerleri maskeler (hata mesajı, geçmiş kaydı vb. dışarı çıkmadan önce). */
function redact(text, secretsList) {
  let out = String(text == null ? '' : text);
  for (const s of secretsList || []) {
    if (!s || String(s).length < 6) continue;
    out = out.split(String(s)).join('••••');
  }
  // HTTP Basic / Bearer başlıkları hiçbir koşulda dışarı çıkmaz
  return out.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=_\-.]{8,}/g, '$1 ••••');
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, h };
}
function verifyPin(pin, rec) {
  if (!rec) return true;
  const { h } = hashPin(pin, rec.salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(rec.h, 'hex'));
}

/**
 * Hatalı PIN denemelerinde artan bekleme. Durum ayarlarda saklanır; uygulamayı
 * kapatıp açmak sayacı sıfırlamaz. 5 hatadan sonra 30 sn, sonra her hatada iki katı (en çok 1 saat).
 */
const PIN_FREE_ATTEMPTS = 5;
function pinWaitMs(fails) {
  if (fails < PIN_FREE_ATTEMPTS) return 0;
  return Math.min(30000 * 2 ** (fails - PIN_FREE_ATTEMPTS), 3600000);
}

module.exports = { createSecrets, redact, hashPin, verifyPin, pinWaitMs, PIN_FREE_ATTEMPTS };
