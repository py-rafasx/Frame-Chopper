use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Window};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const VIDEO_EXTENSIONS: [&str; 18] = [
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "3g2", "ogv",
    "ts", "vob", "rm", "rmvb", "f4v",
];

const ALLOWED_SETTINGS_KEYS: [&str; 6] = [
    "lastOutputDir",
    "fps",
    "quality",
    "filename",
    "zeropad",
    "format",
];

const BITMAP_SUBTITLE_CODECS: [&str; 4] =
    ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"];

const PROGRESS_THROTTLE: Duration = Duration::from_millis(500);
const STDERR_LIMIT: usize = 4096;

#[derive(Default)]
struct ExportState {
    child: Mutex<Option<Child>>,
    canceled: AtomicBool,
}

#[derive(Serialize, Clone)]
struct SubtitleStream {
    index: usize,
    codec: String,
    label: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportOptions {
    video_path: String,
    output_dir: String,
    fps: Option<f64>,
    quality: Option<f64>,
    format: Option<String>,
    filename: Option<String>,
    zeropad: Option<String>,
    subtitle_index: Option<i64>,
}

#[allow(unused_mut)]
fn new_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(ext))
        })
        .unwrap_or(false)
}

fn bundled_binary(app: &AppHandle, name: &str) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("ffmpeg")
            .join(name);
        if dev.exists() {
            return Some(dev);
        }
    }

    let packaged = app.path().resource_dir().ok()?.join("ffmpeg").join(name);
    packaged.exists().then_some(packaged)
}

fn binary_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn common_binary_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }

    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links"),
            );
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            dirs.push(PathBuf::from(profile).join("scoop").join("shims"));
        }
        dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
        dirs.push(PathBuf::from(r"C:\ffmpeg\bin"));
    }

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }

    #[cfg(target_os = "linux")]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }

    dirs
}

fn resolve_binary(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let file_name = binary_name(name);
    if let Some(path) = bundled_binary(app, &file_name) {
        return Some(path);
    }

    common_binary_dirs()
        .into_iter()
        .map(|dir| dir.join(&file_name))
        .find(|path| path.is_file())
}

fn ffmpeg_binary(app: &AppHandle) -> String {
    resolve_binary(app, "ffmpeg")
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| binary_name("ffmpeg"))
}

fn ffprobe_binary(app: &AppHandle) -> String {
    if let Some(path) = resolve_binary(app, "ffprobe") {
        return path.to_string_lossy().into_owned();
    }

    if let Some(ffmpeg) = resolve_binary(app, "ffmpeg") {
        let sibling = ffmpeg.with_file_name(binary_name("ffprobe"));
        if sibling.is_file() {
            return sibling.to_string_lossy().into_owned();
        }
    }

    binary_name("ffprobe")
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FfmpegStatus {
    available: bool,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    platform: String,
    ffmpeg_error: Option<String>,
    ffprobe_error: Option<String>,
}

fn binary_works(path: &Path) -> Result<(), String> {
    let program = path.to_string_lossy();
    let output = new_command(&program)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|err| err.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "exited with code {}",
            output.status.code().unwrap_or(-1)
        ))
    }
}

#[tauri::command]
fn check_ffmpeg(app: AppHandle) -> FfmpegStatus {
    let ffmpeg = resolve_binary(&app, "ffmpeg");
    let ffprobe = resolve_binary(&app, "ffprobe").or_else(|| {
        ffmpeg.as_ref().and_then(|ffmpeg| {
            let sibling = ffmpeg.with_file_name(binary_name("ffprobe"));
            sibling.is_file().then_some(sibling)
        })
    });

    let (ffmpeg_ok, ffmpeg_error) = match ffmpeg.as_deref() {
        Some(path) => match binary_works(path) {
            Ok(()) => (true, None),
            Err(error) => (false, Some(error)),
        },
        None => (
            false,
            Some("ffmpeg was not found on PATH or in common install locations.".to_string()),
        ),
    };

    let (ffprobe_ok, ffprobe_error) = match ffprobe.as_deref() {
        Some(path) => match binary_works(path) {
            Ok(()) => (true, None),
            Err(error) => (false, Some(error)),
        },
        None => (
            false,
            Some("ffprobe was not found on PATH or in common install locations.".to_string()),
        ),
    };

    FfmpegStatus {
        available: ffmpeg_ok && ffprobe_ok,
        ffmpeg_path: ffmpeg.map(|path| path.to_string_lossy().into_owned()),
        ffprobe_path: ffprobe.map(|path| path.to_string_lossy().into_owned()),
        platform: std::env::consts::OS.to_string(),
        ffmpeg_error,
        ffprobe_error,
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Value {
    let Ok(path) = settings_path(app) else {
        return json!({});
    };

    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn save_settings(app: &AppHandle, partial: &Value) -> Result<(), String> {
    let mut current = load_settings(app);
    if !current.is_object() {
        current = json!({});
    }

    if let (Some(target), Some(source)) = (current.as_object_mut(), partial.as_object()) {
        for key in ALLOWED_SETTINGS_KEYS {
            if let Some(value) = source.get(key) {
                target.insert(key.to_string(), value.clone());
            }
        }
    }

    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let tmp = path.with_extension("json.tmp");
    let contents = serde_json::to_string_pretty(&current).map_err(|err| err.to_string())?;
    fs::write(&tmp, contents).map_err(|err| err.to_string())?;
    fs::rename(&tmp, &path).map_err(|err| err.to_string())?;
    Ok(())
}

fn subtitle_streams(app: &AppHandle, video_path: &str) -> Result<Vec<SubtitleStream>, String> {
    let output = new_command(&ffprobe_binary(app))
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-select_streams",
            "s",
            video_path,
        ])
        .output()
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                "ffprobe not found. Install ffmpeg/ffprobe and add it to PATH, or place it in resources/ffmpeg/.".to_string()
            } else {
                err.to_string()
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lines: Vec<&str> = stderr.lines().rev().take(3).collect();
        let tail = lines.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(if tail.is_empty() {
            "Failed to read subtitle tracks".to_string()
        } else {
            format!("Failed to read subtitle tracks: {tail}")
        });
    }

    let data: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Could not parse subtitle track information.".to_string())?;
    let streams = data
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(streams
        .iter()
        .enumerate()
        .map(|(index, stream)| {
            let language = stream
                .pointer("/tags/language")
                .and_then(Value::as_str)
                .unwrap_or("und");
            let title = stream
                .pointer("/tags/title")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("Track {}", index + 1));
            let codec = stream
                .get("codec_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            SubtitleStream {
                index,
                codec,
                label: format!("{title} ({language})"),
            }
        })
        .collect())
}

fn subtitle_extension(codec: &str) -> &'static str {
    if BITMAP_SUBTITLE_CODECS.contains(&codec) {
        if codec == "dvd_subtitle" {
            "sub"
        } else {
            "sup"
        }
    } else {
        "srt"
    }
}

fn build_output_pattern(output_dir: &str, base_name: &str, zeropad: &str, format: &str) -> PathBuf {
    let safe_name: String = base_name
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    Path::new(output_dir).join(format!("{safe_name}{zeropad}.{format}"))
}

fn map_quality(quality: Option<f64>) -> i64 {
    let value = quality.unwrap_or(2.0);
    if !value.is_finite() {
        return 2;
    }
    (value.round() as i64).clamp(2, 31)
}

fn normalize_fps(fps: Option<f64>) -> f64 {
    let value = fps.unwrap_or(2.0);
    if !value.is_finite() {
        return 2.0;
    }
    value.clamp(1.0, 60.0)
}

fn escape_subtitle_path(path: &str) -> String {
    path.replace('\\', "/")
        .replace(':', "\\:")
        .replace(',', "\\,")
        .replace(';', "\\;")
        .replace('\'', "\\'")
}

fn build_ffmpeg_args(
    options: &ExportOptions,
    output_pattern: &Path,
    fps: f64,
    format: &str,
    quality: i64,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hwaccel".into(),
        "auto".into(),
        "-threads".into(),
        "0".into(),
        "-thread_type".into(),
        "frame".into(),
        "-i".into(),
        options.video_path.clone(),
        "-an".into(),
        "-vsync".into(),
        "0".into(),
    ];

    let video_filter = match options.subtitle_index {
        Some(index) if index >= 0 => format!(
            "fps={fps},subtitles='{}':si={index}",
            escape_subtitle_path(&options.video_path)
        ),
        _ => {
            args.push("-sn".into());
            format!("fps={fps}")
        }
    };

    args.extend([
        "-vf".into(),
        video_filter,
        "-c:v".into(),
        "mjpeg".into(),
        "-pix_fmt".into(),
        "yuvj420p".into(),
    ]);

    if format == "jpg" {
        args.extend(["-q:v".into(), quality.to_string()]);
    }

    args.extend([
        "-f".into(),
        "image2".into(),
        "-y".into(),
        output_pattern.to_string_lossy().into_owned(),
    ]);

    args
}

fn parse_ffmpeg_time(text: &str) -> Option<String> {
    let start = text.find("time=")? + "time=".len();
    let rest = &text[start..];
    let end = rest
        .find(|ch: char| ch.is_whitespace() || ch == '\r' || ch == '\n')
        .unwrap_or(rest.len());
    let token = &rest[..end];
    let parts: Vec<&str> = token.split(':').collect();
    if parts.len() != 3 {
        return None;
    }

    let valid = parts[0].len() == 2
        && parts[0].chars().all(|ch| ch.is_ascii_digit())
        && parts[1].len() == 2
        && parts[1].chars().all(|ch| ch.is_ascii_digit())
        && parts[2].contains('.');
    valid.then(|| token.to_string())
}

fn wait_for_child(app: AppHandle) -> (bool, Option<i32>) {
    loop {
        {
            let state = app.state::<ExportState>();
            let mut guard = match state.child.lock() {
                Ok(guard) => guard,
                Err(_) => return (false, None),
            };

            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        guard.take();
                        return (status.success(), status.code());
                    }
                    Ok(None) => {}
                    Err(_) => {
                        guard.take();
                        return (false, None);
                    }
                },
                None => return (false, None),
            }
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|err| err.to_string())
}

#[tauri::command]
fn window_close(window: Window) -> Result<(), String> {
    window.close().map_err(|err| err.to_string())
}

#[tauri::command]
async fn select_video(app: AppHandle) -> Result<Value, String> {
    let mut builder = app
        .dialog()
        .file()
        .add_filter("Video", &VIDEO_EXTENSIONS);
    if let Some(window) = app.get_webview_window("main") {
        builder = builder.set_parent(&window);
    }
    let picked = builder.blocking_pick_file();

    let Some(file_path) = picked else {
        return Ok(Value::Null);
    };

    let path = file_path.into_path().map_err(|err| err.to_string())?;
    if !is_video_path(&path) {
        return Ok(json!({ "error": "Invalid video file." }));
    }

    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(json!({ "path": path.to_string_lossy(), "name": name }))
}

#[tauri::command]
async fn select_output_folder(app: AppHandle) -> Result<Option<String>, String> {
    let settings = load_settings(&app);
    let mut builder = app.dialog().file();

    if let Some(directory) = settings
        .get("lastOutputDir")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        builder = builder.set_directory(directory);
    }

    if let Some(window) = app.get_webview_window("main") {
        builder = builder.set_parent(&window);
    }

    let picked = builder.blocking_pick_folder();

    let Some(folder) = picked else {
        return Ok(None);
    };

    let path = folder.into_path().map_err(|err| err.to_string())?;
    let folder = path.to_string_lossy().into_owned();
    save_settings(&app, &json!({ "lastOutputDir": folder }))?;
    Ok(Some(folder))
}

#[tauri::command]
async fn get_subtitle_tracks(app: AppHandle, video_path: String) -> Value {
    match subtitle_streams(&app, &video_path) {
        Ok(streams) => {
            let tracks: Vec<Value> = streams
                .iter()
                .map(|stream| json!({ "index": stream.index, "label": stream.label }))
                .collect();
            json!({ "ok": true, "tracks": tracks })
        }
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
async fn extract_subtitle(
    app: AppHandle,
    video_path: String,
    subtitle_index: i64,
    output_dir: String,
) -> Value {
    if subtitle_index < 0 {
        return json!({ "ok": false, "error": "Invalid subtitle index." });
    }

    let streams = match subtitle_streams(&app, &video_path) {
        Ok(streams) => streams,
        Err(error) => return json!({ "ok": false, "error": error }),
    };

    let Some(stream) = streams
        .iter()
        .find(|stream| stream.index == subtitle_index as usize)
    else {
        return json!({
            "ok": false,
            "error": format!("Subtitle track {subtitle_index} not found in the video.")
        });
    };

    let codec = stream.codec.clone();
    let subtitle_dir = Path::new(&output_dir).join("subtitle");
    if let Err(err) = fs::create_dir_all(&subtitle_dir) {
        return json!({ "ok": false, "error": err.to_string() });
    }

    let output = subtitle_dir.join(format!("subtitle.{}", subtitle_extension(&codec)));
    let mut cmd = new_command(&ffmpeg_binary(&app));
    cmd.arg("-y")
        .arg("-i")
        .arg(&video_path)
        .arg("-map")
        .arg(format!("0:s:{subtitle_index}"));

    if BITMAP_SUBTITLE_CODECS.contains(&codec.as_str()) {
        cmd.args(["-c:s", "copy"]);
    } else {
        cmd.args(["-c:s", "srt"]);
    }

    cmd.arg(&output).stdout(Stdio::null()).stderr(Stdio::null());

    match cmd.status() {
        Ok(status) if status.success() => {
            json!({ "ok": true, "subtitleDir": subtitle_dir.to_string_lossy() })
        }
        Ok(status) => json!({
            "ok": false,
            "error": format!(
                "ffmpeg exited with code {}",
                status.code().unwrap_or(-1)
            )
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => json!({
            "ok": false,
            "error": "ffmpeg not found. Install ffmpeg and add it to PATH, or place it in resources/ffmpeg/."
        }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

#[tauri::command]
async fn start_export(app: AppHandle, options: ExportOptions) -> Value {
    if options.video_path.is_empty() || options.output_dir.is_empty() {
        return json!({ "ok": false, "error": "Video and output folder are required." });
    }

    {
        let state = app.state::<ExportState>();
        let guard = match state.child.lock() {
            Ok(guard) => guard,
            Err(_) => return json!({ "ok": false, "error": "Export state is unavailable." }),
        };
        if guard.is_some() {
            return json!({ "ok": false, "error": "An export is already running." });
        }
    }

    {
        let state = app.state::<ExportState>();
        state.canceled.store(false, Ordering::SeqCst);
    }

    let mut settings = json!({
        "lastOutputDir": options.output_dir.clone(),
        "fps": options.fps,
        "filename": options.filename.clone()
    });
    if let Some(quality) = options.quality {
        settings["quality"] = json!(quality);
    }
    let _ = save_settings(&app, &settings);

    let format = options
        .format
        .as_deref()
        .filter(|value| *value == "jpg" || *value == "png")
        .unwrap_or("jpg")
        .to_string();
    let zeropad = options
        .zeropad
        .clone()
        .unwrap_or_else(|| "%04d".to_string());
    let filename = options.filename.clone().unwrap_or_default();
    let output_pattern = build_output_pattern(&options.output_dir, &filename, &zeropad, &format);

    if let Err(err) = fs::create_dir_all(&options.output_dir) {
        return json!({ "ok": false, "error": err.to_string() });
    }

    let fps = normalize_fps(options.fps);
    let quality = map_quality(options.quality);
    let args = build_ffmpeg_args(&options, &output_pattern, fps, &format, quality);

    let mut cmd = new_command(&ffmpeg_binary(&app));
    cmd.args(&args).stdout(Stdio::null()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return json!({
                "ok": false,
                "error": "ffmpeg not found. Install ffmpeg and add it to PATH, or place it in resources/ffmpeg/."
            })
        }
        Err(err) => return json!({ "ok": false, "error": err.to_string() }),
    };

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let log_thread = child.stderr.take().map(|stderr| {
        let app_for_log = app.clone();
        let tail = stderr_tail.clone();
        std::thread::spawn(move || {
            let mut reader = stderr;
            let mut chunk = [0u8; 4096];
            let mut carry = String::new();
            let mut last_emit: Option<Instant> = None;

            loop {
                let read = match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(_) => break,
                };

                let text = String::from_utf8_lossy(&chunk[..read]);
                {
                    let mut buffer = tail.lock().unwrap();
                    buffer.push_str(&text);
                    if buffer.len() > STDERR_LIMIT * 2 {
                        let drop = buffer.len() - STDERR_LIMIT;
                        buffer.drain(..drop);
                    }
                }

                let mut combined = String::with_capacity(carry.len() + text.len());
                combined.push_str(&carry);
                combined.push_str(&text);

                if let Some(value) = parse_ffmpeg_time(&combined) {
                    let should_emit = last_emit
                        .map(|last| last.elapsed() >= PROGRESS_THROTTLE)
                        .unwrap_or(true);
                    if should_emit {
                        let _ = app_for_log
                            .emit("export-progress", json!({ "type": "time", "value": value }));
                        last_emit = Some(Instant::now());
                    }
                }

                carry = combined
                    .chars()
                    .rev()
                    .take(256)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            }
        })
    });

    {
        let state = app.state::<ExportState>();
        let lock_result = state.child.lock();
        if let Ok(mut guard) = lock_result {
            *guard = Some(child);
        }
    }

    let app_for_wait = app.clone();
    let wait_result =
        tauri::async_runtime::spawn_blocking(move || wait_for_child(app_for_wait)).await;

    let (success, code) = match wait_result {
        Ok(result) => result,
        Err(err) => return json!({ "ok": false, "error": err.to_string() }),
    };

    if let Some(handle) = log_thread {
        let _ = handle.join();
    }

    let canceled = app.state::<ExportState>().canceled.load(Ordering::SeqCst);

    if canceled {
        return json!({ "ok": false, "error": "Export canceled." });
    }

    if success {
        return json!({
            "ok": true,
            "outputDir": options.output_dir,
            "pattern": output_pattern.to_string_lossy()
        });
    }

    let tail = stderr_tail
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let lines: Vec<&str> = tail.lines().rev().take(5).collect();
    let detail = lines.into_iter().rev().collect::<Vec<_>>().join("\n");
    let error = match code {
        Some(code) => format!("ffmpeg exited with code {code}"),
        None => "ffmpeg exited with an unknown code".to_string(),
    };

    if detail.is_empty() {
        json!({ "ok": false, "error": error })
    } else {
        json!({ "ok": false, "error": error, "detail": detail })
    }
}

#[tauri::command]
fn cancel_export(state: State<'_, ExportState>) -> bool {
    let Ok(mut guard) = state.child.lock() else {
        return false;
    };

    match guard.as_mut() {
        Some(child) => {
            state.canceled.store(true, Ordering::SeqCst);
            let _ = child.kill();
            true
        }
        None => false,
    }
}

#[tauri::command]
fn get_initial_settings(app: AppHandle) -> Value {
    let settings = load_settings(&app);
    json!({
        "lastOutputDir": settings.get("lastOutputDir").and_then(Value::as_str).unwrap_or(""),
        "fps": settings.get("fps").cloned().unwrap_or_else(|| json!(2)),
        "quality": settings.get("quality").cloned().unwrap_or_else(|| json!(2)),
        "filename": settings.get("filename").and_then(Value::as_str).unwrap_or(""),
        "zeropad": settings.get("zeropad").and_then(Value::as_str).unwrap_or("%04d"),
        "format": settings.get("format").and_then(Value::as_str).unwrap_or("jpg")
    })
}

#[tauri::command]
fn save_settings_command(app: AppHandle, settings: Value) -> Value {
    match save_settings(&app, &settings) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
fn file_association_path() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.exists() && is_video_path(path))
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) URLs are allowed".to_string());
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| err.to_string())?;
    Ok(String::new())
}

#[tauri::command]
fn open_path(app: AppHandle, folder_path: String) -> Result<String, String> {
    if folder_path.is_empty() {
        return Ok(String::new());
    }

    let path = Path::new(&folder_path);
    if !path.is_dir() {
        return Ok(String::new());
    }

    app.opener()
        .open_path(folder_path, None::<&str>)
        .map_err(|err| err.to_string())?;
    Ok(String::new())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ExportState::default())
        .invoke_handler(tauri::generate_handler![
            window_minimize,
            window_close,
            select_video,
            select_output_folder,
            get_subtitle_tracks,
            extract_subtitle,
            start_export,
            cancel_export,
            get_initial_settings,
            save_settings_command,
            file_association_path,
            check_ffmpeg,
            open_url,
            open_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<ExportState>();
                let lock_result = state.child.lock();
                if let Ok(mut guard) = lock_result {
                    if let Some(child) = guard.as_mut() {
                        state.canceled.store(true, Ordering::SeqCst);
                        let _ = child.kill();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_quality_to_ffmpeg_range() {
        assert_eq!(map_quality(Some(1.0)), 2);
        assert_eq!(map_quality(Some(31.0)), 31);
        assert_eq!(map_quality(Some(40.0)), 31);
        assert_eq!(map_quality(None), 2);
    }

    #[test]
    fn normalizes_fps_to_supported_range() {
        assert_eq!(normalize_fps(Some(0.5)), 1.0);
        assert_eq!(normalize_fps(Some(120.0)), 60.0);
        assert_eq!(normalize_fps(None), 2.0);
        assert!((normalize_fps(Some(29.97)) - 29.97).abs() < f64::EPSILON);
    }

    #[test]
    fn builds_sanitized_output_pattern() {
        let pattern = build_output_pattern("out", "a/b:c*", "%04d", "jpg");
        let text = pattern.to_string_lossy();
        assert!(text.contains("a_b_c_"));
        assert!(text.ends_with("%04d.jpg"));
    }

    #[test]
    fn parses_ffmpeg_progress_time() {
        let line = "frame=  120 fps= 30 q=2.0 size=  1024kB time=00:00:05.12 bitrate=1638.4kbits/s";
        assert_eq!(parse_ffmpeg_time(line).as_deref(), Some("00:00:05.12"));
        assert_eq!(parse_ffmpeg_time("no timestamp here"), None);
    }

    #[test]
    fn detects_supported_video_extensions() {
        assert!(is_video_path(Path::new("movie.MKV")));
        assert!(is_video_path(Path::new("clip.mp4")));
        assert!(!is_video_path(Path::new("notes.txt")));
    }
}
