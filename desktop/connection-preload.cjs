const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('neoConnection',Object.freeze({info:()=>ipcRenderer.invoke('neo:connection-info'),connect:input=>ipcRenderer.invoke('neo:connect',input),chooseCa:()=>ipcRenderer.invoke('neo:choose-ca')}));
