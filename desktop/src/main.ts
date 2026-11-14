import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type Item = {
  id: string;
  kind: "text" | "link" | "image" | "video" | "file";
  body: string;
  file: string | null;
  mime: string;
  origin: "pc" | "phone";
  delivered: boolean;
  deleted: boolean;
  created_at: number;
  folder_id: string | null;
};
type Folder = { id: string; name: string };
type Status = { ip: string; port: number; pairing: string; qr: string; phone_connected: boolean };
type Preview = { title: string | null; image: string | null };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const board = $<HTMLElement>("#board");
const empty = $<HTMLElement>("#empty");
const heading = $<HTMLElement>("#heading");
const toast = $<HTMLElement>("#toast");
const toastText = $<HTMLElement>("#toast-text");
const foldersEl = $<HTMLElement>("#folders");
const pairCard = $<HTMLElement>("#pair-card");
const pairLabel = $<HTMLElement>("#pair-label");
const dot = $<HTMLElement>("#dot");
const qrBox = $<HTMLElement>("#qr");

// "all" | "unsorted" | folder id
let view = "all";
let items: Item[] = [];
let folders: Folder[] = [];
let lastJson = "";
let lastQr = "";
let pending: { item: Item; timer: number } | null = null;
const cache = new Map<string, string>();
const previews = new Map<string, Preview | null>();

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function sizeLabel(name: string) {
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "FILE";
  return ext;
}

async function refresh(force = false) {
  const [its, fds] = await Promise.all([invoke<Item[]>("list_items"), invoke<Folder[]>("list_folders")]);
  const json = JSON.stringify([its, fds]);
  if (!force && json === lastJson) return;
  lastJson = json;
  items = its;
  folders = fds;
  renderFolders();
  render();
}

function visibleItems() {
  return items.filter((i) => {
    if (view === "all") return true;
    if (view === "unsorted") return !i.folder_id;
    return i.folder_id === view;
  });
}

function renderFolders() {
  const counts = (fn: (i: Item) => boolean) => items.filter(fn).length;
  const rows: [string, string, number][] = [
    ["all", "All items", items.length],
    ["unsorted", "Unsorted", counts((i) => !i.folder_id)],
    ...folders.map((f): [string, string, number] => [f.id, f.name, counts((i) => i.folder_id === f.id)]),
  ];
  foldersEl.replaceChildren(
    ...rows.map(([id, name, n]) => {
      const b = h("button", "folder" + (view === id ? " active" : ""));
      b.type = "button";
      b.append(h("span", "folder-name", name), h("span", "folder-count", String(n)));
      if (id !== "all" && id !== "unsorted") {
        b.ondblclick = () => renameFolder(id, name);
      }
      b.onclick = () => {
        view = id;
        renderFolders();
        render();
      };
      return b;
    }),
  );
}

function render() {
  const vis = visibleItems();
  const title =
    view === "all" ? "All items" : view === "unsorted" ? "Unsorted" : folders.find((f) => f.id === view)?.name ?? "";
  heading.textContent = `${title} · ${vis.length}`;
  board.replaceChildren(...vis.map(card));
  empty.hidden = vis.length > 0;
}

function card(item: Item) {
  const el = h("article", `card ${item.origin}`);

  const top = h("div", "card-top");
  top.append(
    h("span", `badge ${item.origin}`, item.origin === "pc" ? "To phone" : "From phone"),
    h("span", "state", item.origin === "pc" ? (item.delivered ? "Delivered" : "Waiting") : "On PC"),
    h("span", "time", fmtTime(item.created_at)),
  );
  el.append(top);

  if (item.kind === "image" && item.file) {
    const img = h("img", "preview") as HTMLImageElement;
    img.alt = item.body;
    loadImage(item).then((src) => (img.src = src));
    el.append(img);
    el.append(h("p", "caption", item.body));
  } else if (item.kind === "video" || item.kind === "file") {
    const tile = h("div", "file-tile");
    tile.append(h("span", "file-ext", item.kind === "video" ? "VIDEO" : sizeLabel(item.body)));
    tile.append(h("span", "file-name", item.body));
    el.append(tile);
  } else if (item.kind === "link") {
    el.append(linkBlock(item));
  } else {
    el.append(h("p", "text", item.body));
  }

  el.append(actions(item));
  return el;
}

function linkBlock(item: Item) {
  const wrap = h("div", "link");
  const cached = previews.get(item.body);
  const row = h("div", "link-meta");
  const title = h("p", "link-title", item.body);
  const host = h("p", "link-host", new URL(item.body).host);
  row.append(title, host);
  wrap.append(row);
  const apply = (p: Preview | null) => {
    if (p?.title) title.textContent = p.title;
    if (p?.image) {
      const img = h("img", "preview") as HTMLImageElement;
      img.src = p.image;
      img.alt = p.title ?? item.body;
      wrap.prepend(img);
    }
  };
  if (cached !== undefined) {
    apply(cached);
  } else {
    previews.set(item.body, null);
    invoke<Preview>("link_preview", { url: item.body })
      .then((p) => {
        previews.set(item.body, p);
        apply(p);
      })
      .catch(() => {});
  }
  return wrap;
}

function actions(item: Item) {
  const bar = h("div", "actions");
  if (item.kind === "text" || item.kind === "link") {
    const copy = h("button", "btn-ghost small", "Copy");
    copy.onclick = async () => {
      await navigator.clipboard.writeText(item.body);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    };
    bar.append(copy);
  }
  if (item.file) {
    const open = h("button", "btn-ghost small", item.kind === "video" ? "Play" : "Open");
    open.onclick = () => invoke("open_item", { id: item.id }).catch((e) => showError(e));
    const save = h("button", "btn-ghost small", "Save");
    save.onclick = async () => {
      try {
        const path = await invoke<string>("save_item", { id: item.id });
        toastNote(`Saved to Downloads: ${path.split(/[\\/]/).pop()}`);
      } catch (e) {
        showError(e);
      }
    };
    bar.append(open, save);
  }

  const move = h("select", "move");
  move.append(new Option("Move to…", "", true, false));
  move.append(new Option("Unsorted", "__none"));
  folders.forEach((f) => move.append(new Option(f.name, f.id)));
  move.onchange = async () => {
    if (!move.value) return;
    const target = move.value === "__none" ? null : move.value;
    await invoke("move_item", { id: item.id, folderId: target });
    refresh(true);
  };
  bar.append(move);

  const del = h("button", "btn-danger small", "Delete");
  del.onclick = () => remove(item);
  bar.append(del);
  return bar;
}

async function loadImage(item: Item): Promise<string> {
  const cached = cache.get(item.id);
  if (cached) return cached;
  const src = await invoke<string>("item_image", { id: item.id });
  cache.set(item.id, src);
  return src;
}

async function remove(item: Item) {
  await invoke("set_deleted", { id: item.id, deleted: true });
  if (pending) clearTimeout(pending.timer);
  const timer = window.setTimeout(hideToast, 5000);
  pending = { item, timer };
  toastText.textContent = "Deleted";
  toast.hidden = false;
  refresh(true);
}

function hideToast() {
  toast.hidden = true;
  pending = null;
}

function toastNote(msg: string) {
  if (pending) clearTimeout(pending.timer);
  pending = null;
  toastText.textContent = msg;
  toast.hidden = false;
  setTimeout(hideToast, 3500);
}

function showError(e: unknown) {
  toastNote(String(e));
}

async function renameFolder(id: string, current: string) {
  const name = window.prompt("Rename folder", current);
  if (!name || !name.trim()) return;
  await invoke("rename_folder", { id, name });
  refresh(true);
}

async function pollStatus() {
  const s = await invoke<Status>("status");
  pairLabel.textContent = s.phone_connected ? "Phone connected" : "Phone not connected";
  dot.classList.toggle("on", s.phone_connected);
  $<HTMLElement>("#pair-link").textContent = s.pairing;
  $<HTMLElement>("#pair-ip").textContent = `This PC: ${s.ip}:${s.port}`;
  if (s.qr !== lastQr) {
    lastQr = s.qr;
    const svg = new DOMParser().parseFromString(s.qr, "image/svg+xml").documentElement;
    qrBox.replaceChildren(document.importNode(svg, true));
  }
}

$<HTMLButtonElement>("#pair-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  pairCard.hidden = !pairCard.hidden;
});
document.addEventListener("click", (e) => {
  if (!pairCard.contains(e.target as Node)) pairCard.hidden = true;
});

$<HTMLButtonElement>("#copy-link").addEventListener("click", async () => {
  await navigator.clipboard.writeText($<HTMLElement>("#pair-link").textContent ?? "");
});

$<HTMLButtonElement>("#new-folder").addEventListener("click", () => {
  const form = $<HTMLFormElement>("#folder-form");
  form.hidden = !form.hidden;
  if (!form.hidden) $<HTMLInputElement>("#folder-name").focus();
});

$<HTMLFormElement>("#folder-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("#folder-name");
  const name = input.value.trim();
  if (!name) return;
  const f = await invoke<Folder>("create_folder", { name });
  input.value = "";
  $<HTMLFormElement>("#folder-form").hidden = true;
  view = f.id;
  refresh(true);
});

$<HTMLFormElement>("#text-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("#text");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await invoke("send_text", { text });
  refresh(true);
});

$<HTMLButtonElement>("#file-btn").addEventListener("click", async () => {
  const path = await open({ multiple: false, directory: false });
  if (typeof path !== "string") return;
  await invoke("send_file", { path });
  refresh(true);
});

$<HTMLButtonElement>("#undo").addEventListener("click", async () => {
  if (!pending) return;
  clearTimeout(pending.timer);
  await invoke("set_deleted", { id: pending.item.id, deleted: false });
  hideToast();
  refresh(true);
});

refresh(true);
pollStatus();
setInterval(() => refresh(), 1500);
setInterval(pollStatus, 2000);
