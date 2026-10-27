const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('neoDesktop',Object.freeze({connection:section=>ipcRenderer.invoke('neo:open-connection',section),companion:()=>ipcRenderer.invoke('neo:open-companion')}));
