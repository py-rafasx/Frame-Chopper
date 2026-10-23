const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolveFfmpegPath } = require('./paths');
const { getSubtitleCodec } = require('./subtitles');

// Active ffmpeg child process (only one export at a time)
let activeProcess = null;
let activeCanceled = false;

// Throttle IPC progress updates to reduce overhead
let lastProgressEmit = 0;
const PROGRESS_THROTTLE = 500; // ms

// Keep only the last N characters of stderr for error reporting
const STDERR_LIMIT = 4096;

/**
 * Builds the output filename pattern for ffmpeg (e.g. frame_%04d.jpg).
 */
function buildOutputPattern(outputDir, baseName, zeropad, format) {
    const safeName = (baseName || '').replace(/[<>:"/\\|?*]/g, '_');
    const pattern = `${safeName}${zeropad}.${format}`;
    return path.join(outputDir, pattern);
}

/**
 * Maps UI quality (1–31) to ffmpeg -q:v (2 = best, 31 = worst).
 */
function mapQuality(quality) {
    const q = Math.round(parseFloat(String(quality).replace(',', '.')) || 2);
    if (Number.isNaN(q)) {
        return 2;
    }
    return Math.min(31, Math.max(2, q));
}

/**
 * Escapes a path for use inside an ffmpeg subtitles filter argument.
 */
function escapeSubtitlePath(p) {
    return p
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;')
        .replace(/'/g, "\\'");
}

/**
 * Runs ffmpeg to extract frames. Sends progress events via callback.
 */
async function startExport(options, onProgress) {
    if (activeProcess) {
        throw new Error('An export is already running.');
    }

    const ffmpegPath = resolveFfmpegPath();
    const outputPattern = buildOutputPattern(
        options.outputDir,
        options.filename,
        options.zeropad,
        options.format
    );

    await fs.promises.mkdir(options.outputDir, { recursive: true });

    const fpsValue = parseFloat(String(options.fps).replace(',', '.')) || 2;
    const fps = Math.max(1, Math.min(60, fpsValue));
    
    // Build ffmpeg arguments optimized for extraction speed. Hardware
    // decoding is intentionally not used: frames must be copied back to
    // system memory for JPEG/PNG encoding, which is slower than software
    // decoding in practice. Neither `-vsync` nor `-fps_mode` is used so the
    // command works with both old and new FFmpeg releases.
    const args = [
        '-nostdin',
        '-threads', '0',                                // Use all available CPU cores
        '-thread_type', 'frame',                        // Parallelize frame processing (better multi-core usage)
        '-i', options.videoPath,                        // Input video file
        '-an',                                          // Disable audio stream (not needed for frame extraction)
    ];

    // Build video filter with optional subtitle burn-in
    let videoFilter = `fps=${fps}`;
    if (options.subtitleIndex != null && options.subtitleIndex >= 0) {
        const subPath = escapeSubtitlePath(options.videoPath);
        videoFilter = `fps=${fps},subtitles='${subPath}':si=${options.subtitleIndex}`;
    } else {
        // Only disable subtitles if not doing burn-in
        args.push('-sn');
    }

    args.push('-vf', videoFilter);                      // FPS filter to extract frames at specified rate

    if (options.format === 'png') {
        args.push(
            '-c:v', 'png',
            '-compression_level', '1'                   // Faster PNG encoding; still lossless
        );
    } else {
        args.push(
            '-c:v', 'mjpeg',                            // Use MJPEG codec explicitly (faster JPEG encoding)
            '-pix_fmt', 'yuvj420p',                     // Pixel format optimized for JPEG (faster conversion)
            '-q:v', String(mapQuality(options.quality))
        );
    }

    args.push(
        '-f', 'image2',                                 // Force image2 format (explicit output format)
        '-y',                                           // Overwrite output files without asking
        outputPattern                                   // Output frames path
    );

    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        console.log('\n=== FFmpeg Export Start ===');
        console.log(`Input: ${options.videoPath}`);
        console.log(`Output Dir: ${options.outputDir}`);
        console.log(`FPS: ${fps}, Format: ${options.format}, Quality: ${options.format === 'jpg' ? mapQuality(options.quality) : 'N/A'}`);
        console.log(`FFmpeg Command: ${resolveFfmpegPath()} ${args.join(' ')}`);
        console.log('===========================\n');

        const child = spawn(ffmpegPath, args, { windowsHide: true });
        activeProcess = child;

        let stderrTail = '';

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderrTail += text;
            if (stderrTail.length > STDERR_LIMIT * 2) {
                stderrTail = stderrTail.slice(-STDERR_LIMIT);
            }
            const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
            if (timeMatch && onProgress) {
                const now = Date.now();
                if (now - lastProgressEmit > PROGRESS_THROTTLE) {
                    onProgress({ type: 'time', value: timeMatch[0].replace('time=', '') });
                    lastProgressEmit = now;
                }
            }
        });

        child.on('error', (err) => {
            activeProcess = null;
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`✗ FFmpeg error after ${duration}s: ${err.message}\n`);
            if (err.code === 'ENOENT') {
                reject(
                    new Error(
                        'ffmpeg not found. Install ffmpeg and add it to PATH, or place it in resources/ffmpeg/.'
                    )
                );
            } else {
                reject(err);
            }
        });

        child.on('close', (code) => {
            if (activeProcess === child) {
                activeProcess = null;
            }
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            if (activeCanceled) {
                const err = new Error('Export canceled.');
                err.cancelled = true;
                reject(err);
            } else if (code === 0) {
                console.log(`✓ Export completed in ${duration}s\n`);
                resolve({ outputDir: options.outputDir, pattern: outputPattern });
            } else {
                const tail = stderrTail.trim().split('\n').slice(-5).join('\n');
                console.log(`✗ FFmpeg exited with code ${code} after ${duration}s\n`);
                if (tail) {
                    console.log(`Last ffmpeg output:\n${tail}\n`);
                }
                const error = new Error(`ffmpeg exited with code ${code}`);
                if (tail) {
                    error.detail = tail;
                }
                reject(error);
            }
        });
    });
}

/**
 * Bitmap subtitle codecs that cannot be losslessly transcoded to plain text.
 */
const BITMAP_SUBTITLE_CODECS = new Set([
    'hdmv_pgs_subtitle',
    'dvd_subtitle',
    'dvb_subtitle',
    'xsub'
]);

function subtitleExtension(codec) {
    return BITMAP_SUBTITLE_CODECS.has(codec) ? (codec === 'dvd_subtitle' ? 'sub' : 'sup') : 'srt';
}

function subtitleCodecArgs(codec) {
    return BITMAP_SUBTITLE_CODECS.has(codec) ? ['-c:s', 'copy'] : ['-c:s', 'srt'];
}

/**
 * Extracts subtitle track to a separate file using ffmpeg.
 */
async function extractSubtitle(videoPath, subtitleIndex, outputDir) {
    if (!Number.isInteger(subtitleIndex) || subtitleIndex < 0) {
        throw new Error('Invalid subtitle index.');
    }

    const codec = await getSubtitleCodec(videoPath, subtitleIndex);
    if (codec == null) {
        throw new Error(`Subtitle track ${subtitleIndex} not found in the video.`);
    }

    const ffmpegPath = resolveFfmpegPath();
    const subtitleDir = path.join(outputDir, 'subtitle');
    await fs.promises.mkdir(subtitleDir, { recursive: true });

    const args = [
        '-y',
        '-i', videoPath,
        '-map', `0:s:${subtitleIndex}`,
        ...subtitleCodecArgs(codec),
        path.join(subtitleDir, `subtitle.${subtitleExtension(codec)}`)
    ];

    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, { windowsHide: true });

        child.on('error', (err) => {
            if (err.code === 'ENOENT') {
                reject(
                    new Error(
                        'ffmpeg not found. Install ffmpeg and add it to PATH, or place it in resources/ffmpeg/.'
                    )
                );
            } else {
                reject(err);
            }
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ subtitleDir });
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });
    });
}

/**
 * Kills the running ffmpeg process, if any.
 */
function cancelExport() {
    if (activeProcess) {
        console.log('⊗ Export cancelled by user\n');
        activeCanceled = true;
        activeProcess.kill('SIGTERM');
        return true;
    }
    return false;
}

module.exports = { startExport, cancelExport, extractSubtitle };