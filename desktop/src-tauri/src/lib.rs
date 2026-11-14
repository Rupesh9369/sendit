use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use qrcode::types::Color;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State as TState};
use tauri_plugin_opener::OpenerExt;

const PORT: u16 = 53320;

#[derive(Clone, Serialize, Deserialize)]
struct Item {
    id: String,
    kind: String,         // text | link | image | video | file
    body: String,         // text, URL, or file name
    file: Option<String>, // stored file name inside the files folder
    #[serde(default)]
    mime: String,
    origin: String,       // "pc" = sent to phone, "phone" = received from phone
    delivered: bool,      // pc items: phone has them
    deleted: bool,
    created_at: u64,
    #[serde(default)]
    folder_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Folder {
    id: String,
    name: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Db {
    token: String,
    #[serde(default)]
    items: Vec<Item>,
    #[serde(default)]
    folders: Vec<Folder>,
}

struct Hub {
    db: Mutex<Db>,
    dir: PathBuf,
    last_seen: Mutex<Option<Instant>>,
    ip: String,
}

type Shared = Arc<Hub>;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn text_kind(t: &str) -> &'static str {
    if (t.starts_with("http://") || t.starts_with("https://")) && !t.contains(char::is_whitespace) {
        "link"
    } else {
        "text"
    }
}

// Kind and mime type from a file extension.
fn kind_for(ext: &str) -> (&'static str, &'static str) {
    match ext.to_ascii_lowercase().as_str() {
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "heic" => ("image", "image/heic"),
        "mp4" => ("video", "video/mp4"),
        "mov" => ("video", "video/quicktime"),
        "webm" => ("video", "video/webm"),
        "mkv" => ("video", "video/x-matroska"),
        "3gp" => ("video", "video/3gpp"),
        "pdf" => ("file", "application/pdf"),
        "txt" => ("file", "text/plain"),
        _ => ("file", "application/octet-stream"),
    }
}

fn save(hub: &Hub) {
    let db = hub.db.lock().unwrap();
    if let Ok(s) = serde_json::to_string(&*db) {
        let _ = std::fs::write(hub.dir.join("db.json"), s);
    }
}

fn load(dir: &PathBuf) -> Db {
    let mut db: Db = std::fs::read_to_string(dir.join("db.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if db.token.is_empty() {
        db.token = new_id();
    }
    // Items deleted in an earlier run are gone for good now.
    let (gone, keep): (Vec<Item>, Vec<Item>) = db.items.into_iter().partition(|i| i.deleted);
    for i in gone {
        if let Some(f) = i.file {
            let _ = std::fs::remove_file(dir.join("files").join(f));
        }
    }
    db.items = keep;
    db
}

fn authed(hub: &Hub, h: &HeaderMap) -> bool {
    let token = hub.db.lock().unwrap().token.clone();
    let ok = h.get("x-sendit-token").and_then(|v| v.to_str().ok()) == Some(token.as_str());
    if ok {
        *hub.last_seen.lock().unwrap() = Some(Instant::now());
    }
    ok
}

fn item_path(hub: &Hub, id: &str) -> Result<PathBuf, String> {
    let db = hub.db.lock().unwrap();
    let item = db.items.iter().find(|i| i.id == id).ok_or("Not found")?;
    let file = item.file.clone().ok_or("No file for this item")?;
    Ok(hub.dir.join("files").join(file))
}

// ---- HTTP API used by the phone (same Wi-Fi only) ----

#[derive(Deserialize)]
struct TextIn {
    text: String,
}

async fn ping() -> &'static str {
    "sendit"
}

async fn post_text(
    State(hub): State<Shared>,
    h: HeaderMap,
    Json(b): Json<TextIn>,
) -> Result<Json<Item>, StatusCode> {
    if !authed(&hub, &h) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let t = b.text.trim().to_string();
    if t.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let item = Item {
        id: new_id(),
        kind: text_kind(&t).into(),
        body: t,
        file: None,
        mime: String::new(),
        origin: "phone".into(),
        delivered: true,
        deleted: false,
        created_at: now(),
        folder_id: None,
    };
    hub.db.lock().unwrap().items.push(item.clone());
    save(&hub);
    Ok(Json(item))
}

async fn post_upload(
    State(hub): State<Shared>,
    h: HeaderMap,
    body: Bytes,
) -> Result<Json<Item>, StatusCode> {
    if !authed(&hub, &h) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let name: String = h
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("file")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let mime = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let ext = std::path::Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_string();
    let id = new_id();
    let file = format!("{id}.{ext}");
    tokio::fs::write(hub.dir.join("files").join(&file), &body)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let kind = if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("video/") {
        "video"
    } else {
        "file"
    };
    let item = Item {
        id,
        kind: kind.into(),
        body: name,
        file: Some(file),
        mime,
        origin: "phone".into(),
        delivered: true,
        deleted: false,
        created_at: now(),
        folder_id: None,
    };
    hub.db.lock().unwrap().items.push(item.clone());
    save(&hub);
    Ok(Json(item))
}

async fn get_outbox(State(hub): State<Shared>, h: HeaderMap) -> Result<Json<Vec<Item>>, StatusCode> {
    if !authed(&hub, &h) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let db = hub.db.lock().unwrap();
    Ok(Json(
        db.items
            .iter()
            .filter(|i| i.origin == "pc" && !i.delivered && !i.deleted)
            .cloned()
            .collect(),
    ))
}

async fn get_file(
    State(hub): State<Shared>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, StatusCode> {
    if !authed(&hub, &h) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let (path, mime) = {
        let db = hub.db.lock().unwrap();
        let item = db.items.iter().find(|i| i.id == id).ok_or(StatusCode::NOT_FOUND)?;
        let file = item.file.clone().ok_or(StatusCode::NOT_FOUND)?;
        (hub.dir.join("files").join(file), item.mime.clone())
    };
    let bytes = tokio::fs::read(path).await.map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(([(header::CONTENT_TYPE, mime)], bytes).into_response())
}

async fn post_ack(State(hub): State<Shared>, h: HeaderMap, Path(id): Path<String>) -> StatusCode {
    if !authed(&hub, &h) {
        return StatusCode::UNAUTHORIZED;
    }
    let found = {
        let mut db = hub.db.lock().unwrap();
        match db.items.iter_mut().find(|i| i.id == id) {
            Some(i) => {
                i.delivered = true;
                true
            }
            None => false,
        }
    };
    if !found {
        return StatusCode::NOT_FOUND;
    }
    save(&hub);
    StatusCode::OK
}

async fn require_token(
    State(hub): State<Shared>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if req.uri().path() == "/api/ping" || authed(&hub, req.headers()) {
        return next.run(req).await;
    }
    StatusCode::UNAUTHORIZED.into_response()
}

async fn serve(hub: Shared) {
    let router = Router::new()
        .route("/api/ping", get(ping))
        .route("/api/text", post(post_text))
        .route("/api/upload", post(post_upload))
        .route("/api/outbox", get(get_outbox))
        .route("/api/file/{id}", get(get_file))
        .route("/api/ack/{id}", post(post_ack))
        // Reject unauthenticated requests before any request body is read.
        .layer(axum::middleware::from_fn_with_state(hub.clone(), require_token))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024 * 1024))
        .with_state(hub);
    match tokio::net::TcpListener::bind(("0.0.0.0", PORT)).await {
        Ok(listener) => {
            let _ = axum::serve(listener, router).await;
        }
        Err(e) => eprintln!("sendit: cannot listen on port {PORT}: {e}"),
    }
}

// ---- Commands used by the desktop UI ----

#[derive(Serialize)]
struct Status {
    ip: String,
    port: u16,
    pairing: String,
    qr: String,
    phone_connected: bool,
}

fn qr_svg(data: &str) -> String {
    let code = match qrcode::QrCode::new(data) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let w = code.width();
    let mut path = String::new();
    for (i, c) in code.to_colors().iter().enumerate() {
        if matches!(c, Color::Dark) {
            path.push_str(&format!("M{} {}h1v1h-1z", i % w, i / w));
        }
    }
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}"><rect width="{s}" height="{s}" fill="#fff"/><path transform="translate(4 4)" fill="#111" d="{path}"/></svg>"##,
        s = w + 8
    )
}

#[tauri::command]
fn status(hub: TState<'_, Shared>) -> Status {
    let token = hub.db.lock().unwrap().token.clone();
    let phone_connected = hub
        .last_seen
        .lock()
        .unwrap()
        .map(|t| t.elapsed().as_secs() < 8)
        .unwrap_or(false);
    let pairing = format!("http://{}:{}#{}", hub.ip, PORT, token);
    Status {
        ip: hub.ip.clone(),
        port: PORT,
        qr: qr_svg(&pairing),
        pairing,
        phone_connected,
    }
}

#[tauri::command]
fn list_items(hub: TState<'_, Shared>) -> Vec<Item> {
    let db = hub.db.lock().unwrap();
    let mut v: Vec<Item> = db.items.iter().filter(|i| !i.deleted).cloned().collect();
    v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    v
}

#[tauri::command]
fn list_folders(hub: TState<'_, Shared>) -> Vec<Folder> {
    hub.db.lock().unwrap().folders.clone()
}

#[tauri::command]
fn create_folder(hub: TState<'_, Shared>, name: String) -> Result<Folder, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Folder name is empty".into());
    }
    let folder = Folder { id: new_id(), name };
    hub.db.lock().unwrap().folders.push(folder.clone());
    save(&hub);
    Ok(folder)
}

#[tauri::command]
fn rename_folder(hub: TState<'_, Shared>, id: String, name: String) -> Result<(), String> {
    {
        let mut db = hub.db.lock().unwrap();
        let f = db.folders.iter_mut().find(|f| f.id == id).ok_or("Folder not found")?;
        f.name = name.trim().to_string();
    }
    save(&hub);
    Ok(())
}

#[tauri::command]
fn delete_folder(hub: TState<'_, Shared>, id: String) -> Result<(), String> {
    {
        let mut db = hub.db.lock().unwrap();
        db.folders.retain(|f| f.id != id);
        for i in db.items.iter_mut() {
            if i.folder_id.as_deref() == Some(id.as_str()) {
                i.folder_id = None;
            }
        }
    }
    save(&hub);
    Ok(())
}

#[tauri::command]
fn move_item(hub: TState<'_, Shared>, id: String, folder_id: Option<String>) -> Result<(), String> {
    {
        let mut db = hub.db.lock().unwrap();
        let item = db.items.iter_mut().find(|i| i.id == id).ok_or("Item not found")?;
        item.folder_id = folder_id;
    }
    save(&hub);
    Ok(())
}

#[tauri::command]
fn send_text(hub: TState<'_, Shared>, text: String) -> Result<Item, String> {
    let t = text.trim().to_string();
    if t.is_empty() {
        return Err("Empty text".into());
    }
    let item = Item {
        id: new_id(),
        kind: text_kind(&t).into(),
        body: t,
        file: None,
        mime: String::new(),
        origin: "pc".into(),
        delivered: false,
        deleted: false,
        created_at: now(),
        folder_id: None,
    };
    hub.db.lock().unwrap().items.push(item.clone());
    save(&hub);
    Ok(item)
}

#[tauri::command]
fn send_file(hub: TState<'_, Shared>, path: String) -> Result<Item, String> {
    let src = std::path::Path::new(&path);
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("bin").to_string();
    let (kind, mime) = kind_for(&ext);
    let id = new_id();
    let file = format!("{id}.{ext}");
    std::fs::copy(src, hub.dir.join("files").join(&file)).map_err(|e| e.to_string())?;
    let item = Item {
        id,
        kind: kind.into(),
        body: name,
        file: Some(file),
        mime: mime.into(),
        origin: "pc".into(),
        delivered: false,
        deleted: false,
        created_at: now(),
        folder_id: None,
    };
    hub.db.lock().unwrap().items.push(item.clone());
    save(&hub);
    Ok(item)
}

#[tauri::command]
fn item_image(hub: TState<'_, Shared>, id: String) -> Result<String, String> {
    let mime = {
        let db = hub.db.lock().unwrap();
        db.items.iter().find(|i| i.id == id).map(|i| i.mime.clone()).ok_or("Not found")?
    };
    let path = item_path(&hub, &id)?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// Files from the phone must not be launched as programs.
const BLOCKED_EXT: &[&str] = &[
    "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jar", "lnk", "reg", "dll", "sh", "app", "apk",
];

#[tauri::command]
fn open_item(app: tauri::AppHandle, hub: TState<'_, Shared>, id: String) -> Result<(), String> {
    let path = item_path(&hub, &id)?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if BLOCKED_EXT.contains(&ext.as_str()) {
        return Err("This file type can't be opened for safety. Use Save instead.".into());
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_item(app: tauri::AppHandle, hub: TState<'_, Shared>, id: String) -> Result<String, String> {
    let src = item_path(&hub, &id)?;
    let name = {
        let db = hub.db.lock().unwrap();
        db.items.iter().find(|i| i.id == id).map(|i| i.body.clone()).unwrap_or_else(|| "file".into())
    };
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let dest = unique_path(dir.join(&name));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

fn unique_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file").to_string();
    let ext = p.extension().and_then(|s| s.to_str()).map(|s| format!(".{s}")).unwrap_or_default();
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|c| !c.exists())
        .unwrap_or(p)
}

#[tauri::command]
fn set_deleted(hub: TState<'_, Shared>, id: String, deleted: bool) -> Result<(), String> {
    let found = {
        let mut db = hub.db.lock().unwrap();
        match db.items.iter_mut().find(|i| i.id == id) {
            Some(i) => {
                i.deleted = deleted;
                true
            }
            None => false,
        }
    };
    if !found {
        return Err("Item not found".into());
    }
    save(&hub);
    Ok(())
}

// Title and preview image of a web link, read from its Open Graph tags.
#[derive(Serialize)]
struct Preview {
    title: Option<String>,
    image: Option<String>,
}

fn og(html: &str, prop: &str) -> Option<String> {
    let needle = format!("\"{prop}\"");
    for seg in html.split('<') {
        if !seg.starts_with("meta") {
            continue;
        }
        let tag = seg.split('>').next().unwrap_or("");
        if tag.contains(&needle) {
            if let Some(c) = attr(tag, "content") {
                return Some(decode_entities(&c));
            }
        }
    }
    None
}

// Turns HTML entities like &amp; and &#x1f92f; into characters.
fn decode_entities(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        match rest.find(';').filter(|&e| e <= 10) {
            Some(end) => {
                let entity = &rest[1..end];
                let decoded = match entity {
                    "amp" => Some('&'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    e if e.starts_with("#x") || e.starts_with("#X") => {
                        u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32)
                    }
                    e if e.starts_with('#') => e[1..].parse::<u32>().ok().and_then(char::from_u32),
                    _ => None,
                };
                match decoded {
                    Some(c) => {
                        out.push(c);
                        rest = &rest[end + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &rest[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = tag.find(&key)? + key.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

// Addresses a link preview must never reach: this PC, the local network, and link-local ranges.
fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast())
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(v4));
            }
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80)
        }
    }
}

#[tauri::command]
async fn link_preview(url: String) -> Result<Preview, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Not a valid link".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Not a web link".into());
    }
    let host = parsed.host_str().ok_or("Link has no host")?.to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| e.to_string())?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err("Link points to a private address".into());
    }
    // Link sites serve their preview tags to link-preview bots, so identify as one.
    // Redirects are not followed, so a public link cannot bounce the request to a private address.
    let client = reqwest::Client::builder()
        .user_agent("facebookexternalhit/1.1")
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let html = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    Ok(Preview {
        title: og(&html, "og:title"),
        image: og(&html, "og:image"),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(dir.join("files"))?;
            let db = load(&dir);
            let _ = save_db(&dir, &db);
            let ip = local_ip_address::local_ip()
                .map(|i| i.to_string())
                .unwrap_or_else(|_| "127.0.0.1".into());
            let hub: Shared = Arc::new(Hub {
                db: Mutex::new(db),
                dir,
                last_seen: Mutex::new(None),
                ip,
            });
            app.manage(hub.clone());
            tauri::async_runtime::spawn(serve(hub));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            list_items,
            list_folders,
            create_folder,
            rename_folder,
            delete_folder,
            move_item,
            send_text,
            send_file,
            item_image,
            open_item,
            save_item,
            set_deleted,
            link_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn save_db(dir: &PathBuf, db: &Db) -> std::io::Result<()> {
    std::fs::write(dir.join("db.json"), serde_json::to_string(db).unwrap_or_default())
}
