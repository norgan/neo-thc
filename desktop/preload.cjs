const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('neoDesktop',Object.freeze({connection:()=>ipcRenderer.invoke('neo:open-connection'),companion:()=>ipcRenderer.invoke('neo:open-companion')}));
