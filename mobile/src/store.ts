import AsyncStorage from '@react-native-async-storage/async-storage';

export type Item = {
  id: string;
  kind: 'text' | 'link' | 'image' | 'video' | 'file';
  body: string; // text, URL, or file name
  uri?: string; // local file on this phone (images, videos and files)
  mime?: string;
  origin: 'phone' | 'pc'; // phone = shared on this phone, pc = came from the PC
  status: 'pending' | 'sent' | 'failed' | 'received';
  remoteId?: string; // id of the PC item, used to avoid downloading twice
  folderId?: string | null;
  createdAt: number;
};

export type Folder = { id: string; name: string };

const ITEMS_KEY = 'sendit-items';
const FOLDERS_KEY = 'sendit-folders';

export async function loadItems(): Promise<Item[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(ITEMS_KEY)) ?? '[]');
  } catch {
    return [];
  }
}

export function saveItems(items: Item[]) {
  return AsyncStorage.setItem(ITEMS_KEY, JSON.stringify(items));
}

export async function loadFolders(): Promise<Folder[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(FOLDERS_KEY)) ?? '[]');
  } catch {
    return [];
  }
}

export function saveFolders(folders: Folder[]) {
  return AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

export function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function textKind(text: string): 'text' | 'link' {
  return /^https?:\/\/\S+$/.test(text) ? 'link' : 'text';
}
