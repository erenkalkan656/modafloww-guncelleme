'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Arayüze yalnızca bu dar API açılır; Node.js veya dosya sistemi erişimi verilmez.
contextBridge.exposeInMainWorld('tsp', {
  // Ham yanıt ({ ok, data, error }): hata kodu ve ayrıntısı köprüden kaybolmadan arayüze ulaşır
  invoke: (method, args) => ipcRenderer.invoke('api', method, args),
  call: async (method, args) => {
    const res = await ipcRenderer.invoke('api', method, args);
    if (!res || !res.ok) {
      const err = new Error((res && res.error && res.error.message) || 'Bilinmeyen hata');
      err.code = res && res.error && res.error.code;
      err.data = (res && res.error && res.error.data) || null;
      throw err;
    }
    return res.data;
  },
  on: (cb) => {
    const h = (_e, msg) => cb(msg);
    ipcRenderer.on('event', h);
    return () => ipcRenderer.removeListener('event', h);
  },
});
