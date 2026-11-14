import { File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';
import { Item, newId } from './store';
import type { Pairing } from './pairing';

type RemoteItem = {
  id: string;
  kind: Item['kind'];
  body: string;
  mime: string;
  file: string | null;
};

const TIMEOUT_MS = 4000;

function withTimeout(url: string, init: RequestInit = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const auth = (p: Pairing) => ({ 'x-sendit-token': p.token });

export async function ping(p: Pairing): Promise<boolean> {
  try {
    const r = await withTimeout(`${p.base}/api/ping`);
    return r.ok;
  } catch {
    return false;
  }
}

// Upload everything on this phone that is still pending. Returns the updated list.
export async function uploadPending(p: Pairing, items: Item[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const item of items) {
    if (item.origin !== 'phone' || (item.status !== 'pending' && item.status !== 'failed')) {
      out.push(item);
      continue;
    }
    try {
      let r: Response;
      if (item.uri) {
        const blob = await (await fetch(item.uri)).blob();
        const name = item.body.replace(/[^A-Za-z0-9._-]/g, '_');
        r = await fetch(`${p.base}/api/upload`, {
          method: 'POST',
          headers: { ...auth(p), 'x-filename': name, 'content-type': item.mime || 'application/octet-stream' },
          body: blob,
        });
      } else {
        r = await fetch(`${p.base}/api/text`, {
          method: 'POST',
          headers: { ...auth(p), 'content-type': 'application/json' },
          body: JSON.stringify({ text: item.body }),
        });
      }
      out.push({ ...item, status: r.ok ? 'sent' : 'failed' });
    } catch {
      out.push({ ...item, status: 'failed' });
    }
  }
  return out;
}

// Pull what was sent from the PC, save it on this phone, then tell the PC it arrived.
export async function pullOutbox(p: Pairing, items: Item[]): Promise<Item[] | null> {
  let remote: RemoteItem[];
  try {
    const r = await withTimeout(`${p.base}/api/outbox`, { headers: auth(p) });
    if (!r.ok) return null;
    remote = await r.json();
  } catch {
    return null;
  }
  const seen = new Set(items.map((i) => i.remoteId).filter(Boolean));
  const added: Item[] = [];
  for (const rem of remote) {
    if (seen.has(rem.id)) continue;
    let uri: string | undefined;
    if (rem.file) {
      const ext = rem.body.includes('.') ? rem.body.split('.').pop() : 'bin';
      const dest = new File(Paths.document, `${newId()}.${ext}`);
      const res = await fetch(`${p.base}/api/file/${rem.id}`, { headers: auth(p) });
      if (!res.ok) continue;
      await dest.write(new Uint8Array(await res.arrayBuffer()));
      uri = dest.uri;
    }
    added.push({
      id: newId(),
      kind: rem.kind,
      body: rem.body,
      uri,
      mime: rem.mime,
      origin: 'pc',
      status: 'received',
      remoteId: rem.id,
      createdAt: Date.now(),
    });
    await withTimeout(`${p.base}/api/ack/${rem.id}`, { method: 'POST', headers: auth(p) }).catch(() => {});
  }
  return added.length ? [...added, ...items] : items;
}

const PORT = 53320;

// After the first pairing, find the PC again on the same Wi-Fi when its address changes.
export async function findPc(p: Pairing): Promise<Pairing | null> {
  const ip = await Network.getIpAddressAsync().catch(() => '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
  const prefix = ip.split('.').slice(0, 3).join('.');
  const last = p.base.replace(/^https?:\/\//, '').split(':')[0];
  const hosts = [last, ...Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`)].filter(
    (h, i, all) => h !== ip && all.indexOf(h) === i,
  );
  const probe = async (host: string): Promise<string | null> => {
    try {
      const r = await withTimeout(`http://${host}:${PORT}/api/ping`, {}, 700);
      return r.ok && (await r.text()) === 'sendit' ? host : null;
    } catch {
      return null;
    }
  };
  for (let i = 0; i < hosts.length; i += 40) {
    const found = (await Promise.all(hosts.slice(i, i + 40).map(probe))).find((h) => !!h);
    if (!found) continue;
    const candidate: Pairing = { base: `http://${found}:${PORT}`, token: p.token };
    const r = await withTimeout(`${candidate.base}/api/outbox`, { headers: auth(candidate) }).catch(() => null);
    if (r?.ok) return candidate;
  }
  return null;
}
