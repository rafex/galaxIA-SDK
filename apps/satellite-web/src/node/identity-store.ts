/**
 * Identidad Ed25519 del nodo móvil, persistida en IndexedDB. Una sola llave
 * da el PeerId libp2p, la firma GossipSub y el `did:key`. IndexedDB no protege
 * la llave de un XSS: la CSP del contenedor lo mitiga.
 */
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>;

const DB = "galaxia-satellite";
const STORE = "identity";
const KEY = "ed25519";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB no disponible"));
  });
}

async function read(): Promise<Uint8Array | undefined> {
  const db = await open();
  return await new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(request.result as Uint8Array | undefined);
    request.onerror = () => reject(request.error ?? new Error("lectura fallida"));
  });
}

async function write(bytes: Uint8Array | undefined): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    if (bytes) tx.objectStore(STORE).put(bytes, KEY);
    else tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("escritura fallida"));
  });
}

/** La identidad guardada; si no hay (o IndexedDB falla) crea una nueva. */
export async function loadOrCreateIdentity(): Promise<PrivateKey> {
  try {
    const stored = await read();
    if (stored) return privateKeyFromProtobuf(stored);
  } catch {
    // Sigue con una identidad nueva (efímera si IndexedDB no funciona).
  }
  const key = await generateKeyPair("Ed25519");
  try {
    await write(privateKeyToProtobuf(key));
  } catch {
    // Modo privado: la identidad dura lo que dure la pestaña.
  }
  return key;
}

export async function resetIdentity(): Promise<void> {
  await write(undefined);
}
