import { contextBridge, ipcRenderer } from 'electron';
const locale: unknown = ipcRenderer.sendSync('kkss:locale');
contextBridge.exposeInMainWorld('kkssLocale', locale === 'es' ? 'es' : 'en');
