import { ipcMain } from 'electron';
import { resetRegistry } from './settings/registry';
import { stateStore } from './stateStore';
import { currentLocale, setLocale } from '../../shared/i18n';
/** Frozen until restart, so existing screens and newly opened dialogs agree. */
export function configureLocale(): void {
  setLocale(stateStore.get('uiLanguage'));
  resetRegistry();
  ipcMain.on('kkss:locale', event => { event.returnValue = currentLocale(); });
}
