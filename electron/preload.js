const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Safe API exposed to the renderer (no direct Node access)
contextBridge.exposeInMainWorld('api', {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),

    selectVideo: () => ipcRenderer.invoke('video:select'),
    selectOutputFolder: () => ipcRenderer.invoke('folder:select'),
    getSubtitleTracks: (videoPath) => ipcRenderer.invoke('video:subtitles', videoPath),
    extractSubtitle: (videoPath, subtitleIndex, outputDir) => ipcRenderer.invoke('subtitle:extract', videoPath, subtitleIndex, outputDir),
    getFileAssociationPath: () => ipcRenderer.invoke('file-association'),
    // Expose a safe wrapper around webUtils.getPathForFile for renderer use
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch (err) {
            return null;
        }
    },
    checkFfmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
    openUrl: (url) => ipcRenderer.invoke('shell:openExternal', url),

    startExport: (options) => ipcRenderer.invoke('export:start', options),
    cancelExport: () => ipcRenderer.invoke('export:cancel'),
    openPath: (folderPath) => ipcRenderer.invoke('shell:openPath', folderPath),

    getInitialSettings: () => ipcRenderer.invoke('settings:load'),
    saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

    onExportProgress: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('export:progress', listener);
        return () => ipcRenderer.removeListener('export:progress', listener);
    },

    onFileAssociationOpen: (callback) => {
        const listener = (_event, filePath) => callback(filePath);
        ipcRenderer.on('file-association-open', listener);
        return () => ipcRenderer.removeListener('file-association-open', listener);
    }
});
