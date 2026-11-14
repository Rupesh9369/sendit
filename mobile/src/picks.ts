import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { File, Paths } from 'expo-file-system';
import { Item, newId } from './store';

// Copy into app storage so the file survives the picker's temporary cache.
async function copyIn(srcUri: string, name: string): Promise<string> {
  const ext = name.includes('.') ? name.split('.').pop()! : 'bin';
  const dest = new File(Paths.document, `${newId()}.${ext}`);
  await new File(srcUri).copy(dest);
  return dest.uri;
}

function queued(kind: Item['kind'], name: string, uri: string, mime: string): Item {
  return { id: newId(), kind, body: name, uri, mime, origin: 'phone', status: 'pending', createdAt: Date.now() };
}

export async function pickPhotos(): Promise<Item[]> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    quality: 1,
  });
  if (res.canceled) return [];
  const out: Item[] = [];
  for (const a of res.assets) {
    const name = a.fileName ?? `photo-${Date.now()}.jpg`;
    const mime = a.mimeType ?? 'image/jpeg';
    out.push(queued(mime.startsWith('image/') ? 'image' : 'file', name, await copyIn(a.uri, name), mime));
  }
  return out;
}

export async function pickFiles(): Promise<Item[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return [];
  const out: Item[] = [];
  for (const a of res.assets) {
    const mime = a.mimeType ?? 'application/octet-stream';
    out.push(queued(mime.startsWith('image/') ? 'image' : 'file', a.name, await copyIn(a.uri, a.name), mime));
  }
  return out;
}
