const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('siftDesktop',Object.freeze({
  prepareDrag:id=>ipcRenderer.invoke('sift:prepare-drag',id),
  startDrag:(id,index)=>ipcRenderer.send('sift:start-drag',id,index)
}));
