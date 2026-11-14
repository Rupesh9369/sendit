import AsyncStorage from '@react-native-async-storage/async-storage';

export type Pairing = { base: string; token: string };

const KEY = 'sendit-pairing';

// Format shown on the PC: http://192.168.x.x:53320#token
export function parsePairing(input: string): Pairing | null {
  const m = input.trim().match(/^(https?:\/\/[^#\s]+)#([A-Za-z0-9]+)$/);
  return m ? { base: m[1], token: m[2] } : null;
}

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const s = await AsyncStorage.getItem(KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export async function savePairing(p: Pairing | null) {
  if (p) await AsyncStorage.setItem(KEY, JSON.stringify(p));
  else await AsyncStorage.removeItem(KEY);
}
