// Compatibility shim: exposes the same `window.api` contract used by the
// Electron preload, backed by Tauri commands when running under Tauri.
(function attachTauriApi(global) {
    const tauri = global.__TAURI__;
    if (!tauri || global.api) {
        return;
    }

    const { invoke } = tauri.core;
    const { listen } = tauri.event;
    const { getCurrentWebview } = tauri.webview || {};

    global.api = {
        minimize: () => invoke('window_minimize'),
        close: () => invoke('window_close'),

        selectVideo: () => invoke('select_video'),
        selectOutputFolder: () => invoke('select_output_folder'),
        getSubtitleTracks: (videoPath) => invoke('get_subtitle_tracks', { videoPath }),
        extractSubtitle: (videoPath, subtitleIndex, outputDir) =>
            invoke('extract_subtitle', { videoPath, subtitleIndex, outputDir }),
        getFileAssociationPath: () => invoke('file_association_path'),
        getPathForFile: () => null,
        checkFfmpeg: () => invoke('check_ffmpeg'),
        openUrl: (url) => invoke('open_url', { url }),

        startExport: (options) => invoke('start_export', { options }),
        cancelExport: () => invoke('cancel_export'),
        openPath: (folderPath) => invoke('open_path', { folderPath }),

        getInitialSettings: () => invoke('get_initial_settings'),
        saveSettings: (settings) => invoke('save_settings_command', { settings }),

        onExportProgress: (callback) => {
            const unlistenPromise = listen('export-progress', (event) => callback(event.payload));
            return () => {
                unlistenPromise.then((unlisten) => unlisten());
            };
        },

        onFileAssociationOpen: () => () => {}
    };

    // Slightly smaller than the Electron build; scale the webview to match.
    if (getCurrentWebview) {
        getCurrentWebview().setZoom(0.92).catch(() => {});
    }

    // Frameless window: replicate Electron's draggable title bar.
    const titleBar = document.querySelector('.title-bar');
    if (titleBar && tauri.window?.getCurrentWindow) {
        const appWindow = tauri.window.getCurrentWindow();
        titleBar.addEventListener('mousedown', (event) => {
            if (event.button !== 0 || event.target.closest('.title-bar__controls')) {
                return;
            }
            appWindow.startDragging();
        });
    }

    // Tauri owns native drag & drop (paths are not exposed to the DOM).
    // Forward the first dropped path to the renderer through a DOM event.
    if (getCurrentWebview) {
        getCurrentWebview().onDragDropEvent((event) => {
            if (event.payload?.type !== 'drop') {
                return;
            }
            const paths = event.payload.paths || [];
            if (paths.length > 0) {
                global.dispatchEvent(
                    new CustomEvent('framechopper:video-dropped', { detail: paths[0] })
                );
            }
        });
    }
})(window);
