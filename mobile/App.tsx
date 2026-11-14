import { StatusBar } from 'expo-status-bar';
import { ComponentRef, useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useShareIntent } from 'expo-share-intent';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  Folder,
  Item,
  loadFolders,
  loadItems,
  newId,
  saveFolders,
  saveItems,
  textKind,
} from './src/store';
import { Pairing, loadPairing, parsePairing, savePairing } from './src/pairing';
import { findPc, ping, pullOutbox, uploadPending } from './src/sync';
import { pickFiles, pickPhotos } from './src/picks';
import { LinkInfo, linkInfo } from './src/preview';

const C = {
  bg: '#F5F6FA',
  card: '#FFFFFF',
  text: '#0F172A',
  muted: '#64748B',
  line: '#E6E9F2',
  accent: '#6366F1',
  accentSoft: '#EEF0FF',
  ok: '#059669',
  okSoft: '#E7F8F1',
  warn: '#B45309',
  warnSoft: '#FEF3C7',
  bad: '#E11D48',
  badSoft: '#FFE4EA',
};

const RESCAN_MS = 15000;

type FolderView = 'all' | 'unsorted' | string;

// Keeps newer local edits; takes status updates from a sync that started earlier.
function merge(current: Item[], synced: Item[]): Item[] {
  const fresh = synced.filter((s) => !current.some((c) => c.id === s.id));
  return [...fresh, ...current.map((c) => synced.find((s) => s.id === c.id) ?? c)];
}

function statusOf(item: Item): { label: string; fg: string; bg: string } {
  if (item.origin === 'pc') return { label: 'From PC', fg: C.ok, bg: C.okSoft };
  if (item.status === 'sent') return { label: 'On PC', fg: C.ok, bg: C.okSoft };
  if (item.status === 'failed') return { label: 'Retrying', fg: C.bad, bg: C.badSoft };
  return { label: 'Sending', fg: C.warn, bg: C.warnSoft };
}

function LinkCard({ url }: { url: string }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  useEffect(() => {
    let alive = true;
    linkInfo(url).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [url]);
  return (
    <View style={styles.linkBox}>
      {info?.image ? <Image source={{ uri: info.image }} style={styles.thumb} /> : null}
      <Text style={styles.linkTitle} numberOfLines={2}>
        {info?.title ?? url}
      </Text>
      <Text style={styles.linkHost} numberOfLines={1}>
        {url.replace(/^https?:\/\//, '').split('/')[0]}
      </Text>
    </View>
  );
}

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<FolderView>('all');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [pairMode, setPairMode] = useState<'closed' | 'scan' | 'paste'>('closed');
  const [pasteText, setPasteText] = useState('');
  const [moving, setMoving] = useState<Item | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [viewing, setViewing] = useState<Item | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const noteRef = useRef<ComponentRef<typeof TextInput>>(null);
  const lastScan = useRef(0);
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({ resetOnBackground: false });

  const update = useCallback((next: Item[]) => {
    itemsRef.current = next;
    setItems(next);
    saveItems(next);
  }, []);

  useEffect(() => {
    Promise.all([loadItems(), loadPairing(), loadFolders()]).then(([saved, p, fs]) => {
      itemsRef.current = saved;
      setItems(saved);
      setPairing(p);
      setFolders(fs);
      setLoaded(true);
    });
  }, []);

  // Text selected in another app and sent with "Send to Sendit" (see plugins/withProcessText.js).
  const takePendingText = useCallback(async () => {
    try {
      const f = new File(Paths.document, 'pending_text.txt');
      if (!f.exists) return;
      const text = (await f.text()).trim();
      f.delete();
      if (text) {
        update([{ id: newId(), kind: textKind(text), body: text, origin: 'phone', status: 'pending', createdAt: Date.now() }, ...itemsRef.current]);
      }
    } catch {
      // nothing pending
    }
  }, [update]);

  useEffect(() => {
    if (!loaded) return;
    takePendingText();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') takePendingText();
    });
    return () => sub.remove();
  }, [loaded, takePendingText]);

  const addFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const f: Folder = { id: newId(), name };
    const next = [...folders, f];
    setFolders(next);
    await saveFolders(next);
    setNewFolderName('');
    setNewFolderOpen(false);
    setView(f.id);
  };

  const deleteFolder = (f: Folder) => {
    Alert.alert('Delete folder?', `"${f.name}" will be removed. Its items stay in Unsorted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const next = folders.filter((x) => x.id !== f.id);
          setFolders(next);
          await saveFolders(next);
          update(itemsRef.current.map((i) => (i.folderId === f.id ? { ...i, folderId: null } : i)));
          if (view === f.id) setView('all');
        },
      },
    ]);
  };

  const moveTo = (item: Item, folderId: string | null) => {
    update(itemsRef.current.map((i) => (i.id === item.id ? { ...i, folderId } : i)));
    setMoving(null);
  };

  // Shares from other apps: copy files into app storage, then queue them for the PC.
  useEffect(() => {
    if (!hasShareIntent || !loaded) return;
    (async () => {
      try {
        const added: Item[] = [];
        const text = shareIntent.text?.trim();
        if (text) {
          added.push({ id: newId(), kind: textKind(text), body: text, origin: 'phone', status: 'pending', createdAt: Date.now() });
        }
        for (const f of shareIntent.files ?? []) {
          const id = newId();
          const ext = f.fileName.includes('.') ? f.fileName.split('.').pop()! : 'bin';
          const dest = new File(Paths.document, `${id}.${ext}`);
          await new File(f.path).copy(dest);
          const mime = f.mimeType;
          added.push({
            id,
            kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file',
            body: f.fileName,
            uri: dest.uri,
            mime,
            origin: 'phone',
            status: 'pending',
            createdAt: Date.now(),
          });
        }
        if (added.length) update([...added, ...itemsRef.current]);
      } catch (e) {
        Alert.alert('Could not save shared item', String(e));
      } finally {
        resetShareIntent();
      }
    })();
  }, [hasShareIntent, shareIntent, loaded, resetShareIntent, update]);

  // Sync every 2 seconds while paired. If the PC moved to a new address, look for it on the Wi-Fi.
  useEffect(() => {
    if (!pairing) return;
    let busyNow = false;
    let alive = true;
    let current = pairing;
    const tick = async () => {
      if (busyNow) return;
      busyNow = true;
      try {
        let ok = await ping(current);
        if (!ok && Date.now() - lastScan.current > RESCAN_MS) {
          lastScan.current = Date.now();
          const found = await findPc(current);
          if (found && alive) {
            current = found;
            await savePairing(found);
            setPairing(found);
            ok = true;
          }
        }
        if (!alive) return;
        setConnected(ok);
        if (!ok) return;
        const uploaded = await uploadPending(current, itemsRef.current);
        const pulled = (await pullOutbox(current, uploaded)) ?? uploaded;
        if (!alive) return;
        const cur = itemsRef.current;
        const merged = merge(cur, pulled);
        if (JSON.stringify(merged) !== JSON.stringify(cur)) update(merged);
      } finally {
        busyNow = false;
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pairing, update]);

  const connectWith = async (raw: string) => {
    const p = parsePairing(raw);
    if (!p) {
      Alert.alert('Not a Sendit code', 'Copy the link shown on your PC and try again.');
      return;
    }
    await savePairing(p);
    setPairing(p);
    setPairMode('closed');
    setPasteText('');
  };

  const unpair = async () => {
    await savePairing(null);
    setPairing(null);
    setConnected(false);
  };

  const addNote = () => {
    const t = note.trim();
    if (!t) return;
    const folderId = view === 'all' || view === 'unsorted' ? null : view;
    update([
      { id: newId(), kind: textKind(t), body: t, origin: 'phone', status: 'pending', folderId, createdAt: Date.now() },
      ...itemsRef.current,
    ]);
    setNote('');
  };

  // Picked items go into the queue at once and reach the PC on the next sync.
  const sendPicked = async (picker: () => Promise<Item[]>) => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await picker();
      if (picked.length) update([...picked, ...itemsRef.current]);
    } catch (e) {
      Alert.alert('Could not pick items', String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async (item: Item) => {
    if (!item.uri) return;
    try {
      await Sharing.shareAsync(item.uri, { mimeType: item.mime, dialogTitle: 'Save or open' });
    } catch (e) {
      Alert.alert('Could not open', String(e));
    }
  };

  const remove = (item: Item) => {
    if (item.uri) {
      try {
        new File(item.uri).delete();
      } catch {
        // file may already be gone; still remove the row
      }
    }
    update(itemsRef.current.filter((i) => i.id !== item.id));
  };

  const visible = items.filter((i) => {
    if (view === 'all') return true;
    if (view === 'unsorted') return !i.folderId;
    return i.folderId === view;
  });
  const pendingCount = items.filter((i) => i.origin === 'phone' && i.status !== 'sent').length;
  const isOnline = !!pairing && connected;
  const activeName = view === 'all' ? 'All' : view === 'unsorted' ? 'Unsorted' : folders.find((f) => f.id === view)?.name ?? '';

  if (pairMode === 'scan') {
    return (
      <View style={styles.container}>
        <StatusBar style="dark" />
        {!permission?.granted ? (
          <View style={styles.center}>
            <Text style={styles.h2}>Camera needed</Text>
            <Text style={styles.muted}>Scan the code on your PC to pair.</Text>
            <Pressable style={styles.primary} onPress={requestPermission}>
              <Text style={styles.primaryText}>Allow camera</Text>
            </Pressable>
            <Pressable onPress={() => setPairMode('paste')}>
              <Text style={styles.link}>Paste the link instead</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.center}>
            <CameraView
              style={styles.camera}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => connectWith(data)}
            />
            <Pressable onPress={() => setPairMode('closed')} style={styles.cancel}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  if (pairMode === 'paste') {
    return (
      <View style={styles.container}>
        <StatusBar style="dark" />
        <View style={styles.center}>
          <Text style={styles.h2}>Connect to your PC</Text>
          <Text style={styles.muted}>Copy the link shown in the Sendit window on your PC.</Text>
          <TextInput
            style={styles.input}
            value={pasteText}
            onChangeText={setPasteText}
            placeholder="http://192.168.x.x:53320#..."
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.primary} onPress={() => connectWith(pasteText)}>
            <Text style={styles.primaryText}>Connect</Text>
          </Pressable>
          <Pressable onPress={() => setPairMode('closed')}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />

      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Sendit</Text>
          <Text style={styles.subtitle}>
            {!pairing ? 'Not connected' : pendingCount > 0 ? `${pendingCount} sending…` : 'All sent'}
          </Text>
        </View>
        <Pressable
          onPress={() => (pairing ? unpair() : setPairMode('scan'))}
          hitSlop={8}
          style={[styles.pill, isOnline && styles.pillOn]}
        >
          <View style={[styles.dot, { backgroundColor: isOnline ? C.ok : C.muted }]} />
          <Text style={[styles.pillText, isOnline && { color: C.ok }]}>
            {!pairing ? 'Pair PC' : isOnline ? 'PC connected' : 'PC offline'}
          </Text>
        </Pressable>
      </View>

      {!pairing ? (
        <Pressable onPress={() => setPairMode('scan')} style={styles.hint}>
          <Text style={styles.hintText}>
            {'Pair once with the code on your PC. After that, Sendit reconnects automatically on the same Wi-Fi.'}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.actions}>
        <Pressable style={[styles.action, busy && styles.dim]} onPress={() => sendPicked(pickPhotos)}>
          <Text style={styles.actionTitle}>Photos</Text>
          <Text style={styles.actionSub}>Photos & videos</Text>
        </Pressable>
        <Pressable style={[styles.action, busy && styles.dim]} onPress={() => sendPicked(pickFiles)}>
          <Text style={styles.actionTitle}>Files</Text>
          <Text style={styles.actionSub}>Any file</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={() => noteRef.current?.focus()}>
          <Text style={styles.actionTitle}>Text</Text>
          <Text style={styles.actionSub}>Note or link</Text>
        </Pressable>
      </View>

      <View style={styles.composer}>
        <TextInput
          ref={noteRef}
          style={styles.noteInput}
          value={note}
          onChangeText={setNote}
          placeholder="Type or paste text"
          placeholderTextColor={C.muted}
          onSubmitEditing={addNote}
          returnKeyType="send"
        />
        <Pressable style={[styles.sendBtn, !note.trim() && styles.dim]} onPress={addNote} disabled={!note.trim()}>
          <Text style={styles.primaryText}>Send</Text>
        </Pressable>
      </View>

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={[{ id: 'all', name: 'All' }, { id: 'unsorted', name: 'Unsorted' }, ...folders.map((f) => ({ id: f.id, name: f.name }))]}
        keyExtractor={(f) => f.id}
        contentContainerStyle={styles.chips}
        style={styles.chipsWrap}
        ListFooterComponent={
          <Pressable onPress={() => setNewFolderOpen(true)} style={styles.chipAdd}>
            <Text style={styles.chipAddText}>+ Folder</Text>
          </Pressable>
        }
        renderItem={({ item }) => {
          const label = item.name;
          const on = view === item.id;
          return (
            <Pressable
              onPress={() => setView(item.id)}
              onLongPress={() => {
                const f = folders.find((x) => x.id === item.id);
                if (f) deleteFolder(f);
              }}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
            </Pressable>
          );
        }}
      />

      <Text style={styles.count}>
        {activeName} · {visible.length}
      </Text>

      <FlatList
        data={visible}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Text style={styles.emptyText}>
              Share from any app to Sendit, or use Photos, Files and Text above. Everything stays between your phone and PC.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const st = statusOf(item);
          const isLink = item.kind === 'link';
          const isImage = item.kind === 'image' && !!item.uri;
          return (
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <View style={[styles.statusChip, { backgroundColor: st.bg }]}>
                  <Text style={[styles.statusText, { color: st.fg }]}>{st.label}</Text>
                </View>
                <Text style={styles.time}>
                  {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>

              {isImage ? (
                <Pressable onPress={() => setViewing(item)}>
                  <Image source={{ uri: item.uri }} style={styles.image} />
                </Pressable>
              ) : null}
              {isLink ? <LinkCard url={item.body} /> : null}
              {item.kind === 'file' || item.kind === 'video' || (item.kind === 'image' && !item.uri) ? (
                <View style={styles.fileTile}>
                  <Text style={styles.fileExt}>{item.kind === 'video' ? 'VIDEO' : (item.body.split('.').pop() ?? 'FILE').toUpperCase()}</Text>
                  <Text style={styles.fileName} numberOfLines={2}>{item.body}</Text>
                </View>
              ) : null}
              {item.kind === 'text' ? (
                <Text selectable style={styles.body}>{item.body}</Text>
              ) : null}

              <View style={styles.actionRow}>
                {item.uri ? (
                  <Pressable onPress={() => save(item)} hitSlop={6}>
                    <Text style={styles.linkSmall}>{item.kind === 'image' ? 'Save / share' : 'Open / save'}</Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={() => setMoving(item)} hitSlop={6}>
                  <Text style={styles.linkSmall}>Move</Text>
                </Pressable>
                <Pressable onPress={() => remove(item)} hitSlop={6} style={styles.deleteWrap}>
                  <Text style={styles.delete}>Delete</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
      />

      <Modal visible={!!moving} transparent animationType="fade" onRequestClose={() => setMoving(null)}>
        <Pressable style={styles.backdrop} onPress={() => setMoving(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Move to folder</Text>
            {[{ id: null as string | null, name: 'Unsorted' }, ...folders.map((f) => ({ id: f.id as string | null, name: f.name }))].map((f) => (
              <Pressable key={f.id ?? 'none'} style={styles.sheetRow} onPress={() => moving && moveTo(moving, f.id)}>
                <Text style={styles.sheetRowText}>{f.name}</Text>
                {moving?.folderId === f.id || (!moving?.folderId && f.id === null) ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>
            ))}
            <Pressable style={styles.sheetRow} onPress={() => { setMoving(null); setNewFolderOpen(true); }}>
              <Text style={[styles.sheetRowText, { color: C.accent }]}>+ New folder</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={newFolderOpen} transparent animationType="fade" onRequestClose={() => setNewFolderOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setNewFolderOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>New folder</Text>
            <TextInput
              style={styles.input}
              value={newFolderName}
              onChangeText={setNewFolderName}
              placeholder="Folder name"
              placeholderTextColor={C.muted}
              autoFocus
              onSubmitEditing={addFolder}
            />
            <Pressable style={styles.primary} onPress={addFolder}>
              <Text style={styles.primaryText}>Create</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!viewing} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <Pressable style={styles.viewer} onPress={() => setViewing(null)}>
          {viewing?.uri ? <Image source={{ uri: viewing.uri }} style={styles.viewerImage} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
    paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 24) + 12 : 60,
    paddingHorizontal: 16,
  },
  center: { flex: 1, justifyContent: 'center', gap: 12, paddingBottom: 40 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  headerText: { flex: 1 },
  title: { fontSize: 28, fontWeight: '800', color: C.text, letterSpacing: -0.6 },
  subtitle: { fontSize: 13, color: C.muted, marginTop: 2 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pillOn: { backgroundColor: C.okSoft },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700', color: C.muted },
  link: { color: C.accent, fontWeight: '700' },
  linkSmall: { color: C.accent, fontWeight: '700', fontSize: 13 },
  hint: { backgroundColor: C.accentSoft, borderRadius: 14, padding: 12, marginBottom: 12 },
  hintText: { color: '#3730A3', fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  action: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: C.line,
  },
  dim: { opacity: 0.5 },
  actionTitle: { fontSize: 15, fontWeight: '800', color: C.text },
  actionSub: { fontSize: 12, color: C.muted, marginTop: 3 },
  composer: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  noteInput: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: C.line,
    fontSize: 15,
    color: C.text,
  },
  sendBtn: { backgroundColor: C.accent, borderRadius: 14, paddingHorizontal: 18, justifyContent: 'center' },
  primary: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  input: {
    backgroundColor: C.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: C.line,
    fontSize: 15,
    color: C.text,
  },
  h2: { fontSize: 20, fontWeight: '800', color: C.text },
  muted: { color: C.muted, fontSize: 14 },
  camera: { width: '100%', height: 380, borderRadius: 16, overflow: 'hidden' },
  cancel: { alignItems: 'center', paddingTop: 12 },
  chipsWrap: { flexGrow: 0, marginBottom: 6 },
  chips: { gap: 8, alignItems: 'center', paddingVertical: 4 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#E8EAF2' },
  chipOn: { backgroundColor: C.text },
  chipText: { fontSize: 13, fontWeight: '700', color: '#374151' },
  chipTextOn: { color: '#fff' },
  chipAdd: { paddingHorizontal: 12, paddingVertical: 8 },
  chipAddText: { fontSize: 13, fontWeight: '700', color: C.accent },
  count: { fontSize: 12, fontWeight: '700', color: C.muted, marginVertical: 8 },
  list: { gap: 12, paddingBottom: 40 },
  card: {
    backgroundColor: C.card,
    borderRadius: 18,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: C.line,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusChip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { fontSize: 12, fontWeight: '800' },
  time: { fontSize: 12, color: C.muted },
  body: { fontSize: 15, color: C.text, lineHeight: 21, paddingHorizontal: 2 },
  image: { width: '100%', height: 220, borderRadius: 12, backgroundColor: '#EEF1F5' },
  linkBox: { gap: 6 },
  thumb: { width: '100%', height: 180, borderRadius: 12, backgroundColor: '#EEF1F5' },
  linkTitle: { fontSize: 15, fontWeight: '700', color: C.text },
  linkHost: { fontSize: 12, color: C.muted },
  fileTile: { backgroundColor: C.accentSoft, borderRadius: 12, padding: 14, gap: 4 },
  fileExt: { fontSize: 11, fontWeight: '800', color: C.accent, letterSpacing: 0.6 },
  fileName: { fontSize: 15, fontWeight: '700', color: C.text },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  deleteWrap: { marginLeft: 'auto' },
  delete: { color: C.bad, fontWeight: '700', fontSize: 13 },
  empty: { alignItems: 'center', marginTop: 40, paddingHorizontal: 24, gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: C.text },
  emptyText: { textAlign: 'center', color: C.muted, lineHeight: 20 },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, gap: 4 },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: C.text, marginBottom: 6 },
  sheetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 13 },
  sheetRowText: { fontSize: 15, color: C.text, fontWeight: '600' },
  check: { color: C.accent, fontWeight: '800' },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
});
