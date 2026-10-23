const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { isVideoPath, resolveFfmpegPath, resolveFfprobePath } = require('./paths');
const { loadSettings, saveSettings } = require('./settings');
const { startExport, cancelExport, extractSubtitle } = require('./export-service');
const { getSubtitleTracks } = require('./subtitles');

// Keep a global reference so the window is not garbage-collected
let mainWindow = null;
let pendingFilePath = null;

// Video file filters for native open dialog
const VIDEO_FILTERS = [
    {
        name: 'Video',
        extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', '3g2', 'ogv', 'ts', 'vob', 'rm', 'rmvb', 'f4v']
    }
];

/**
 * Creates the frameless application window and loads the existing UI.
 */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 450,
        height: 520,
        resizable: false,
        frame: false,
        alwaysOnTop: true,
        backgroundColor: '#ffffff',
        icon: path.join(__dirname, '..', 'src', 'renderer', 'assets', 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

    // If there's a pending file from file association, load it
    if (pendingFilePath) {
        mainWindow.webContents.once('did-finish-load', () => {
            mainWindow.webContents.send('file-association-open', pendingFilePath);
            pendingFilePath = null;
        });
    }

    // Open DevTools for debugging
    // mainWindow.webContents.openDevTools();

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}


ipcMain.handle('file-association', async (event) => {
    const args = process.argv;
    // Normalmente o arquivo vem depois do executável
    // Em produção geralmente:
    // [0] = app.exe
    // [1] = caminho do arquivo

    if (args.length >= 2) {
        const videoPath = args[1];
        if (isVideoPath(videoPath) && fs.existsSync(videoPath)) {
            return videoPath;
        }
    }

    return null;
});




// --- Window controls (custom title bar) ---

ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
});

ipcMain.handle('window:close', () => {
    mainWindow?.close();
});

// --- Video selection ---

ipcMain.handle('video:select', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parentWindow ?? mainWindow, {
        properties: ['openFile'],
        filters: VIDEO_FILTERS
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const filePath = result.filePaths[0];
    if (!isVideoPath(filePath)) {
        return { error: 'Invalid video file.' };
    }

    return {
        path: filePath,
        name: path.basename(filePath)
    };
});

// --- Output folder ---

ipcMain.handle('folder:select', async (event) => {
    const settings = loadSettings();
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parentWindow ?? mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: settings.lastOutputDir || app.getPath('documents')
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const folder = result.filePaths[0];
    saveSettings({ lastOutputDir: folder });
    return folder;
});

// --- Subtitle tracks (ffprobe) ---

ipcMain.handle('video:subtitles', async (_event, videoPath) => {
    if (!videoPath) {
        return { ok: true, tracks: [] };
    }
    try {
        const tracks = await getSubtitleTracks(videoPath);
        return { ok: true, tracks };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});



// --- Persisted defaults for the form ---

ipcMain.handle('settings:load', () => {
    const settings = loadSettings();
    return {
        lastOutputDir: settings.lastOutputDir || '',
        fps: settings.fps ?? 2,
        quality: settings.quality ?? 2,
        filename: settings.filename,
        zeropad: settings.zeropad || '%04d',
        format: settings.format || 'jpg'
    };
});

ipcMain.handle('settings:save', (_event, settings) => {
    saveSettings(settings);
    return { ok: true };
});

// --- Frame export via ffmpeg ---

ipcMain.handle('subtitle:extract', async (_event, videoPath, subtitleIndex, outputDir) => {
    if (!videoPath || subtitleIndex == null || !outputDir) {
        throw new Error('Video path, subtitle index, and output directory are required.');
    }

    try {
        const result = await extractSubtitle(videoPath, subtitleIndex, outputDir);
        return { ok: true, ...result };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('export:start', async (_event, options) => {
    if (!options?.videoPath || !options?.outputDir) {
        throw new Error('Video and output folder are required.');
    }

    const toSave = {
        lastOutputDir: options.outputDir,
        fps: options.fps,
        filename: options.filename
    };
    if (options.quality != null) {
        toSave.quality = options.quality;
    }
    saveSettings(toSave);

    const sendProgress = (payload) => {
        mainWindow?.webContents.send('export:progress', payload);
    };

    try {
        const result = await startExport(options, sendProgress);
        return { ok: true, ...result };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('export:cancel', () => {
    cancelExport();
    return true;
});

ipcMain.handle('shell:openPath', async (_event, folderPath) => {
    if (!folderPath) {
        return '';
    }
    // Only allow opening directories, never arbitrary executables
    const stat = fs.statSync(folderPath, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
        return '';
    }
    return shell.openPath(folderPath);
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return '';
    }
    await shell.openExternal(url);
    return '';
});

function binaryWorks(binary) {
    return new Promise((resolve) => {
        execFile(binary, ['-version'], { windowsHide: true, timeout: 5000 }, (error) => {
            resolve(!error);
        });
    });
}

ipcMain.handle('ffmpeg:check', async () => {
    const ffmpegPath = resolveFfmpegPath();
    const ffprobePath = resolveFfprobePath(ffmpegPath);
    const [ffmpegOk, ffprobeOk] = await Promise.all([
        binaryWorks(ffmpegPath),
        binaryWorks(ffprobePath)
    ]);

    return {
        available: ffmpegOk && ffprobeOk,
        ffmpegPath,
        ffprobePath,
        platform:
            process.platform === 'win32'
                ? 'windows'
                : process.platform === 'darwin'
                    ? 'macos'
                    : 'linux',
        ffmpegError: ffmpegOk
            ? null
            : 'ffmpeg was not found on PATH or in common install locations.',
        ffprobeError: ffprobeOk
            ? null
            : 'ffprobe was not found on PATH or in common install locations.'
    };
});

// --- App lifecycle ---

app.whenReady().then(() => {
    // Check for file association on startup (Windows)
    const args = process.argv;
    if (args.length >= 2) {
        const videoPath = args[1];
        if (isVideoPath(videoPath) && fs.existsSync(videoPath)) {
            pendingFilePath = videoPath;
        }
    }

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Handle file association on macOS (when app is already running)
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (isVideoPath(filePath) && fs.existsSync(filePath)) {
        if (mainWindow) {
            mainWindow.webContents.send('file-association-open', filePath);
        } else {
            pendingFilePath = filePath;
        }
    }
});

app.on('before-quit', () => {
    cancelExport();
});


