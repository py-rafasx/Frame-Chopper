const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Video extensions accepted by the app (lowercase, with dot).
// Matches the file associations registered in package.json.
const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg',
    '.mpeg', '.3gp', '.3g2', '.ogv', '.ts', '.vob', '.rm', '.rmvb', '.f4v'
]);

/**
 * Returns true when the file path looks like a supported video file.
 */
function isVideoPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
}

/**
 * Resolves ffmpeg executable: bundled binary first, then PATH.
 */
function resolveFfmpegPath() {
    const bundledName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const bundled = path.join(
        app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
        'resources',
        'ffmpeg',
        bundledName
    );

    if (fs.existsSync(bundled)) {
        return bundled;
    }

    const common = [];
    if (process.platform === 'win32') {
        if (process.env.LOCALAPPDATA) {
            common.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', bundledName));
        }
        if (process.env.USERPROFILE) {
            common.push(path.join(process.env.USERPROFILE, 'scoop', 'shims', bundledName));
        }
        common.push(path.join('C:\\ProgramData\\chocolatey\\bin', bundledName));
        common.push(path.join('C:\\ffmpeg\\bin', bundledName));
    } else {
        common.push(path.join('/opt/homebrew/bin', bundledName));
        common.push(path.join('/usr/local/bin', bundledName));
        common.push(path.join('/usr/bin', bundledName));
    }

    const installed = common.find((candidate) => fs.existsSync(candidate));
    if (installed) {
        return installed;
    }

    // Fall back to ffmpeg on system PATH
    return bundledName;
}

/**
 * Resolves ffprobe next to ffmpeg or on PATH.
 */
function resolveFfprobePath(ffmpegPath) {
    if (ffmpegPath.includes(path.sep)) {
        const probe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
        if (fs.existsSync(probe)) {
            return probe;
        }
    }
    return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

module.exports = {
    VIDEO_EXTENSIONS,
    isVideoPath,
    resolveFfmpegPath,
    resolveFfprobePath
};
