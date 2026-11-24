// Gives the board the app's updater. Sandboxed preloads run as CommonJS, hence require; the main process answers only
// the main window's board page.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
type Bridge = import('../plugin/board/src/types.ts').DesktopBridge;
type Update = import('../plugin/board/src/types.ts').AppUpdate;

const bridge: Bridge = {
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    cancel: () => ipcRenderer.invoke('update:cancel'),
    seen: () => ipcRenderer.invoke('update:seen'),
    subscribe(listener) {
      const handler = (_event: unknown, update: Update) => listener(update);
      ipcRenderer.on('update:changed', handler);
      return () => void ipcRenderer.removeListener('update:changed', handler);
    },
  },
  welcome: {
    pending: () => ipcRenderer.invoke('welcome:pending'),
    done: () => ipcRenderer.invoke('welcome:done'),
  },
};
contextBridge.exposeInMainWorld('crewDesktop', bridge);
