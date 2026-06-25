"use strict";
/**
 * preload_quick.ts — Preload de la fenêtre de validation rapide (Ctrl+Alt+D).
 * Expose un pont minimal : réception du document à déposer, envoi, progression, annulation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('quickApi', {
    onInit: (cb) => electron_1.ipcRenderer.on('quick-deposit-init', (_e, doc) => cb(doc)),
    onProgress: (cb) => electron_1.ipcRenderer.on('deposit-progress', (_e, info) => cb(info)),
    send: (opts) => electron_1.ipcRenderer.invoke('quick-deposit-send', opts),
    cancel: () => electron_1.ipcRenderer.send('quick-deposit-cancel'),
});
//# sourceMappingURL=preload_quick.js.map