import { ipcMain } from 'electron';
import { resetRegistry } from './settings/registry';
import { stateStore } from './stateStore';
import { currentLocale, setLocale } from '../../shared/i18n';
import { setRuntimeLocale } from '../../../mesh/src/parser/i18n/runtime';
/** Frozen until restart, so existing screens and newly opened dialogs agree. */
export function configureLocale(): void {
  setLocale(stateStore.get('uiLanguage'));
  // mesh 5.22's host-side prompts translate through its own runtime table;
  // mesh's extension.ts does the same with vscode.env.language at activate().
  setRuntimeLocale(currentLocale());
  resetRegistry();
  ipcMain.on('kkss:locale', event => { event.returnValue = currentLocale(); });
}
