const { contextBridge, ipcRenderer } = require('electron');
let uncapped = false;
ipcRenderer.invoke('tf:getUncapped').then(v => { uncapped = v; });
contextBridge.exposeInMainWorld('tfDesktop', {
  get uncapped() { return uncapped; },
  setUncapped: v => ipcRenderer.invoke('tf:setUncapped', v),
  saveSettings: () => {},
});
