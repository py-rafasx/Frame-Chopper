// ---------------------------------------------------------------------------
// Supported video types (browser MIME + extension fallback)
// ---------------------------------------------------------------------------
const SUPPORTED_VIDEO_FORMATS = [
    'video/mp4',
    'video/mkv',
    'video/x-matroska',
    'video/avi',
    'video/x-msvideo',
    'video/quicktime',
    'video/x-ms-wmv',
    'video/webm',
    'video/ogg',
    'video/3gpp',
    'video/3gpp2'
];

const SUPPORTED_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.3g2', '.ogv', '.ts', '.vob', '.rm', '.rmvb', '.f4v'];

const isElectron = typeof window.api !== 'undefined';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const dropzone = document.querySelector('.media-dropzone');
const uploadIcon = document.querySelector('.media-dropzone__upload-icon');
const videoNameEl = document.querySelector('.media-dropzone__video-name');
const exportProgress = document.getElementById('export-progress');
const uploadIconImg = uploadIcon.appendChild(document.createElement('img'));

const btnMinimize = document.querySelector('[aria-label="Minimize window"]');
const btnClose = document.querySelector('[aria-label="Close window"]');
const folderInput = document.getElementById('folder-input');
const folderPathPreview = document.getElementById('folder-path-preview');
const folderPickerBtn = document.getElementById('folder-picker-btn');
const fpsInput = document.getElementById('fps-input');
const qualityInput = document.getElementById('quality-input');
const qualityNa = document.getElementById('quality-na');
const subtitleSelect = document.getElementById('subtitle-select');
const filenameInput = document.getElementById('filename-input');
const zeropadSelect = document.getElementById('zeropad-select');
const formatSelect = document.getElementById('format-select');
const generateBtn = document.querySelector('.action-bar__generate');

let selectedVideo = null;
let exportUnsubscribe = null;
let isExporting = false;
let wasCanceled = false;

// Restored when switching back from PNG to JPG
let savedQualityValue = null;

// ---------------------------------------------------------------------------
// Path helpers (output folder lives next to the video file)
// ---------------------------------------------------------------------------
function parentDir(fullPath) {
    const trimmed = fullPath.replace(/[/\\]+$/, '');
    const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return slash > 0 ? trimmed.slice(0, slash) : trimmed;
}

function joinDir(base, name) {
    const sep = base.includes('\\') ? '\\' : '/';
    const safeName = name.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
    return base.replace(/[/\\]+$/, '') + sep + safeName;
}

function getVideoParentDir() {
    if (!selectedVideo?.path) {
        return '';
    }
    return parentDir(selectedVideo.path);
}

function getFolderDisplayName(fullPath) {
    if (!fullPath) {
        return '';
    }
    const trimmed = fullPath.replace(/[/\\]+$/, '');
    const parts = trimmed.split(/[/\\]/);
    return parts[parts.length - 1] || trimmed;
}

/** True when a subtitle track is selected for export */
function isSubtitleExport() {
    const value = subtitleSelect.value;
    return value !== '' && !Number.isNaN(Number.parseInt(value, 10));
}

/** Updates destination path preview (includes subtitle/ subfolder when applicable) */
function updateFolderPathDisplay() {
    const path = resolveOutputDir() || getVideoParentDir() || '';

    if (folderPathPreview) {
        folderPathPreview.textContent = path;
    }

    folderInput.title = path;
}

/**
 * Fills folder name from episode number in the video file name (01–100).
 */
function applyEpisodeFolderFromVideo() {
    if (!selectedVideo) {
        return;
    }

    const episode = extractEpisodeFolderName(selectedVideo.name);
    folderInput.value = episode || '';
    updateFolderPathDisplay();
}

/**
 * Output directory is always created beside the selected video file.
 */
function resolveOutputDir() {
    const name = folderInput.value.trim();
    if (!name) {
        return '';
    }

    const base = getVideoParentDir();
    if (!base) {
        return name;
    }

    return joinDir(base, name);
}

// ---------------------------------------------------------------------------
// Quality field — N/A when PNG (lossless; only toggles quality control)
// ---------------------------------------------------------------------------
function syncQualityForFormat() {
    if (!qualityInput || !formatSelect) {
        return;
    }

    const isPng = formatSelect.value === 'png';

    if (isPng) {
        if (!qualityInput.hidden) {
            savedQualityValue = qualityInput.value;
        }
        qualityInput.hidden = true;
        qualityInput.disabled = true;
        if (qualityNa) {
            qualityNa.hidden = false;
        }
        return;
    }

    qualityInput.hidden = false;
    qualityInput.disabled = false;
    if (qualityNa) {
        qualityNa.hidden = true;
    }
    qualityInput.value = savedQualityValue || '2';
    savedQualityValue = null;
}

formatSelect.addEventListener('change', () => {
    syncQualityForFormat();
    saveCurrentSettings();
});
subtitleSelect.addEventListener('change', updateFolderPathDisplay);

// ---------------------------------------------------------------------------
// Empty state icon
// ---------------------------------------------------------------------------
uploadIconImg.src = 'assets/upload.png';
uploadIconImg.alt = 'Upload video';

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = SUPPORTED_VIDEO_FORMATS.join(',');
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

function getDroppedFile(dataTransfer) {
    if (!dataTransfer) {
        return null;
    }

    if (dataTransfer.files && dataTransfer.files.length > 0) {
        return dataTransfer.files[0];
    }

    if (dataTransfer.items && dataTransfer.items.length > 0) {
        const item = dataTransfer.items[0];
        if (item.kind === 'file') {
            return item.getAsFile();
        }
    }

    return null;
}

// `webUtils.getPathForFile` is exposed from the preload script as
// `window.api.getPathForFile(file)` and should be used to obtain
// filesystem paths for dropped files in a context-isolated renderer.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function isVideoFile(file) {
    if (!file) {
        return false;
    }
    const fileType = file.type;
    const fileName = (file.name || '').toLowerCase();

    if (fileType && SUPPORTED_VIDEO_FORMATS.includes(fileType)) {
        return true;
    }

    return SUPPORTED_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

function isVideoPath(filePath) {
    const name = (filePath || '').toLowerCase();
    return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function showError(message) {
    alert(message);
}

// ---------------------------------------------------------------------------
// Video selection
// ---------------------------------------------------------------------------
async function applyVideoSelection(video) {
    if (!video) {
        return;
    }

    selectedVideo = video;
    videoNameEl.textContent = video.name;
    uploadIconImg.src = 'assets/clapboard.png';
    uploadIconImg.alt = 'Video selected';

    applyEpisodeFolderFromVideo();

    if (isElectron && video.path) {
        await loadSubtitleTracks(video.path);
    }
}

function handleBrowserFile(file) {
    if (!file) {
        return;
    }

    if (!isVideoFile(file)) {
        showError('Please select a valid video file (mp4, mkv, avi, mov, wmv, flv, webm, m4v, mpg, mpeg, 3gp, 3g2, ogv, ts, vob, rm, rmvb, f4v).');
        return;
    }

    applyVideoSelection({ name: file.name, path: window.api?.getPathForFile?.(file) || null, file });
}

let boolShownProbeWarning = false;

async function loadSubtitleTracks(videoPath) {
    subtitleSelect.innerHTML = '';
    subtitleSelect.disabled = true;

    const optionNone = document.createElement('option');
    optionNone.value = '';
    optionNone.textContent = 'None';
    subtitleSelect.appendChild(optionNone);

    try {
        const res = await window.api.getSubtitleTracks(videoPath);

        if (!res?.ok) {
            if (!boolShownProbeWarning) {
                boolShownProbeWarning = true;
                showError(
                    res?.error?.includes('ffprobe not found')
                        ? 'ffprobe not found. Install ffmpeg/ffprobe and add it to PATH, or place it in resources/ffmpeg/ to enable subtitle extraction.'
                        : `Could not read subtitles: ${res?.error || 'Unknown error'}`
                );
            }
            return;
        }

        (res.tracks || []).forEach((track) => {
            const opt = document.createElement('option');
            opt.value = String(track.index);
            opt.textContent = track.label;
            subtitleSelect.appendChild(opt);
        });
    } catch {
        // IPC failure — leave the "None" option enabled
    } finally {
        subtitleSelect.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Drop zone
// ---------------------------------------------------------------------------
dropzone.addEventListener('click', async () => {
    if (isExporting) {
        return;
    }

    if (isElectron) {
        const result = await window.api.selectVideo();
        if (!result) {
            return;
        }
        if (result.error) {
            showError(result.error);
            return;
        }
        await applyVideoSelection(result);
        return;
    }

    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    handleBrowserFile(e.target.files[0]);
});

function resetDropzoneStyles() {
    dropzone.style.borderColor = 'var(--color-border)';
    dropzone.style.backgroundColor = 'transparent';
}

dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--color-accent)';
    dropzone.style.backgroundColor = 'var(--color-bg-subtle)';
});

dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    resetDropzoneStyles();
});

dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    resetDropzoneStyles();

    if (isExporting) {
        return;
    }

    const file = getDroppedFile(e.dataTransfer);
    if (!file) {
        return;
    }

    const filePath = window.api?.getPathForFile?.(file) || null;
    if (isElectron && filePath) {
        if (!isVideoPath(filePath)) {
            showError('Please drop a valid video file.');
            return;
        }
        await applyVideoSelection({ path: filePath, name: file.name });
        return;
    }

    handleBrowserFile(file);
});

// ---------------------------------------------------------------------------
// Prevent dropping files anywhere except the media dropzone
// ---------------------------------------------------------------------------
document.addEventListener('dragover', (e) => {
    const el = e.target;
    if (!(el instanceof Element && el.closest('.media-dropzone'))) {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'none';
        }
    }
});

document.addEventListener('drop', (e) => {
    const el = e.target;
    if (!(el instanceof Element && el.closest('.media-dropzone'))) {
        e.preventDefault();
        e.stopPropagation();
    }
});

// Native drag & drop under Tauri: the webview event provides the real path.
window.addEventListener('framechopper:video-dropped', async (event) => {
    if (isExporting) {
        return;
    }

    const filePath = event.detail;
    if (!filePath) {
        return;
    }

    if (!isVideoPath(filePath)) {
        showError('Please drop a valid video file.');
        return;
    }

    await applyVideoSelection({ path: filePath, name: filePath.split(/[/\\]/).pop() });
});

// ---------------------------------------------------------------------------
// Output folder input + picker (name only; path is always next to video)
// ---------------------------------------------------------------------------
// The `input` event already covers typing, pasting and even programmatic changes.
folderInput.addEventListener('input', updateFolderPathDisplay);

async function openOutputFolderPicker() {
    if (!isElectron || !window.api?.selectOutputFolder) {
        showError('Folder picker is only available in the desktop app.');
        return;
    }

    try {
        const folder = await window.api.selectOutputFolder();
        if (folder) {
            folderInput.value = getFolderDisplayName(folder);
            updateFolderPathDisplay();
        }
    } catch (err) {
        showError(err?.message || 'Could not open folder picker.');
    }
}

folderPickerBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openOutputFolderPicker();
});

// ---------------------------------------------------------------------------
// Electron-only: title bar, settings, export
// ---------------------------------------------------------------------------


// Check for file association (if the app was launched by opening a file)
if (isElectron) {
    // Listen for file association events from main process
    window.api.onFileAssociationOpen((filePath) => {
        if (filePath) {
            applyVideoSelection({ path: filePath, name: filePath.split(/[/\\]/).pop() });
        }
    });

    // Also check via IPC for startup case
    window.api.getFileAssociationPath().then((filePath) => {
        if (filePath) {
            applyVideoSelection({ path: filePath, name: filePath.split(/[/\\]/).pop() });
        }
    });

}


if (isElectron) {
    btnMinimize?.addEventListener('click', () => window.api.minimize());
    btnClose?.addEventListener('click', () => window.api.close());

    initElectronDefaults();
    setupExport();

    // Auto-save settings when inputs change
    fpsInput.addEventListener('change', saveCurrentSettings);
    qualityInput.addEventListener('change', saveCurrentSettings);
    filenameInput.addEventListener('change', saveCurrentSettings);
    zeropadSelect.addEventListener('change', saveCurrentSettings);
}

async function initElectronDefaults() {
    const settings = await window.api.getInitialSettings();

    fpsInput.value = settings.fps ?? 2;
    qualityInput.value = settings.quality ?? 2;
    filenameInput.value = settings.filename !== undefined ? settings.filename : '';
    zeropadSelect.value = settings.zeropad || '%04d';
    formatSelect.value = settings.format || 'jpg';

    syncQualityForFormat();
}

async function saveCurrentSettings() {
    if (!isElectron || !window.api?.saveSettings) {
        return;
    }

    try {
        const fpsValue = parseFloat(fpsInput.value.replace(',', '.')) || 2;
        const qualityValue = Math.round(parseFloat(qualityInput.value.replace(',', '.')) || 2);
        await window.api.saveSettings({
            fps: Math.max(1, Math.min(60, fpsValue)),
            quality: Math.max(2, Math.min(31, qualityValue)),
            filename: filenameInput.value.trim(),
            zeropad: zeropadSelect.value,
            format: formatSelect.value
        });
    } catch (err) {
        console.error('Failed to save settings:', err);
    }
}

function setupExport() {
    exportUnsubscribe = window.api.onExportProgress((payload) => {
        if (payload?.value) {
            exportProgress.textContent = `Exporting… ${payload.value}`;
        }
    });

    generateBtn.addEventListener('click', async () => {
        // If currently exporting, cancel the export.
        // The UI reset happens once the running ffmpeg process actually exits.
        if (isExporting) {
            wasCanceled = true;
            try {
                await window.api?.cancelExport();
            } catch {
                // Cancel request failed — the running export will still finish.
            }
            return;
        }

        if (!selectedVideo?.path) {
            showError('Select a video file first.');
            return;
        }

        const outputDir = resolveOutputDir();
        if (!outputDir) {
            showError('Enter an output folder name (episode number).');
            return;
        }

        const filename = filenameInput.value.trim();
        const subtitleValue = subtitleSelect.value;
        const subtitleIndex =
            subtitleValue === '' ? null : Number.parseInt(subtitleValue, 10);

        isExporting = true;
        wasCanceled = false;
        generateBtn.disabled = false;
        generateBtn.textContent = 'Cancel';
        generateBtn.classList.add('exporting');
        document.body.classList.add('exporting');
        uploadIconImg.style.display = 'none';
        exportProgress.textContent = 'Exporting…';
        exportProgress.hidden = false;

        const fpsValue = parseFloat(fpsInput.value.replace(',', '.')) || 2;
        const qualityValue =
            Math.round(parseFloat((savedQualityValue || qualityInput.value || 2).toString().replace(',', '.')) || 2);
        const result = await window.api.startExport({
            videoPath: selectedVideo.path,
            outputDir,
            fps: Math.max(1, Math.min(60, fpsValue)),
            quality:
                formatSelect.value === 'jpg' ? Math.max(2, Math.min(31, qualityValue)) : null,
            format: formatSelect.value,
            filename,
            zeropad: zeropadSelect.value,
            subtitleIndex: null // Remove burn-in, extract separately
        });

        // Extract subtitle separately if selected
        if (result?.ok && subtitleIndex != null && !Number.isNaN(subtitleIndex)) {
            exportProgress.textContent = 'Extracting subtitle…';
            const subResult = await window.api.extractSubtitle(
                selectedVideo.path,
                subtitleIndex,
                outputDir
            );
            if (!subResult?.ok) {
                showError(`Subtitle extraction failed: ${subResult?.error || 'Unknown error'}`);
            }
        }

        isExporting = false;
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate';
        generateBtn.classList.remove('exporting');
        document.body.classList.remove('exporting');
        exportProgress.textContent = '';
        exportProgress.hidden = true;
        uploadIconImg.style.display = 'block';

        if (!wasCanceled && !result?.ok) {
            showError(result?.error || 'Export failed.');
        }
    });
}

// Apply quality state on load (default format is jpg)
syncQualityForFormat();
