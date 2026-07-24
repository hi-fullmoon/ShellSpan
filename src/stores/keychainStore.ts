import { create } from 'zustand';
import type { KeychainKey, KeychainKeyKind } from '@/types';
import {
  invokeStoreKeyCredential,
  invokeListKeyCredentials,
  invokeRetrieveKeyCredential,
  invokeDeleteKeyCredential,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const logger = createLogger('keychainStore');

export function detectKeyType(privateKey: string): string {
  const normalized = privateKey.toLowerCase();
  if (normalized.includes('-----begin rsa private key-----') || normalized.includes('ssh-rsa')) {
    return 'rsa';
  }
  if (normalized.includes('-----begin ec private key-----') || normalized.includes('ecdsa-sha2')) {
    return 'ecdsa';
  }
  if (normalized.includes('ssh-ed25519')) {
    return 'ed25519';
  }
  if (normalized.includes('-----begin dsa private key-----') || normalized.includes('ssh-dss')) {
    return 'dsa';
  }
  if (normalized.includes('-----begin openssh private key-----')) {
    const base64Body = extractPemBase64Body(privateKey);
    const openSshType = parseOpenSshKeyType(base64Body);
    if (openSshType) {
      if (openSshType.startsWith('ssh-ed25519')) return 'ed25519';
      if (openSshType.startsWith('ssh-rsa')) return 'rsa';
      if (openSshType.startsWith('ecdsa-sha2')) return 'ecdsa';
      if (openSshType.startsWith('ssh-dss')) return 'dsa';
    }
  }
  if (normalized.includes('-----begin private key-----')) {
    const base64Body = extractPemBase64Body(privateKey);
    try {
      const decoded = atob(base64Body);
      const bytes = new Uint8Array(
        Array.from(decoded).map((char) => char.charCodeAt(0)),
      );
      // id-ecPublicKey OID: 1.2.840.10045.2.1
      if (containsByteSequence(bytes, [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01])) {
        return 'ecdsa';
      }
    } catch {
      // ignore invalid base64
    }
  }
  return 'unknown';
}

function extractPemBase64Body(pem: string): string {
  return pem
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !line.startsWith('-----BEGIN') && !line.startsWith('-----END'),
    )
    .join('');
}

function parseOpenSshKeyType(base64Body: string): string | undefined {
  try {
    const decoded = atob(base64Body);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      bytes[i] = decoded.charCodeAt(i);
    }

    const magic = 'openssh-key-v1\0';
    if (bytes.length < magic.length) return undefined;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic.charCodeAt(i)) return undefined;
    }

    let offset = magic.length;
    const readUint32 = (): number => {
      const value =
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3];
      offset += 4;
      return value >>> 0;
    };
    const readString = (): string => {
      const len = readUint32();
      const value = new TextDecoder().decode(bytes.subarray(offset, offset + len));
      offset += len;
      return value;
    };

    readString(); // ciphername
    readString(); // kdfname
    readString(); // kdfoptions
    const numKeys = readUint32();
    if (numKeys !== 1) return undefined;
    const pubKeyLen = readUint32();
    const pubKeyEnd = offset + pubKeyLen;
    if (pubKeyEnd > bytes.length) return undefined;
    const algoLen = readUint32();
    if (offset + algoLen > pubKeyEnd) return undefined;
    return new TextDecoder().decode(bytes.subarray(offset, offset + algoLen));
  } catch {
    return undefined;
  }
}

function containsByteSequence(bytes: Uint8Array, sequence: number[]): boolean {
  if (sequence.length === 0 || bytes.length < sequence.length) {
    return false;
  }
  for (let i = 0; i <= bytes.length - sequence.length; i++) {
    let match = true;
    for (let j = 0; j < sequence.length; j++) {
      if (bytes[i + j] !== sequence[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return true;
    }
  }
  return false;
}

export interface KeychainKeySummary {
  id: string;
  label: string;
  keyType: string;
  kind: KeychainKeyKind;
}

interface KeychainState {
  keys: KeychainKeySummary[];
  initialized: boolean;
  hydrate: () => Promise<void>;
  addKey: (
    key: Omit<KeychainKey, 'id' | 'createdAt' | 'updatedAt'>,
  ) => Promise<KeychainKey>;
  updateKey: (
    id: string,
    updates: Partial<Omit<KeychainKey, 'id' | 'createdAt' | 'updatedAt'>>,
  ) => Promise<void>;
  removeKey: (id: string) => Promise<string[]>;
  getKey: (id: string) => Promise<KeychainKey | undefined>;
}

function resolveKeyType(key: Omit<KeychainKey, 'id' | 'createdAt' | 'updatedAt'>): string {
  if (key.kind === 'password') {
    return 'ecdsa';
  }
  return key.privateKey ? detectKeyType(key.privateKey) : (key.keyType ?? 'unknown');
}

export const useKeychainStore = create<KeychainState>()((set, get) => ({
  keys: [],
  initialized: false,

  hydrate: async () => {
    try {
      const keySummaries = await invokeListKeyCredentials();
      const keys = keySummaries.map((summary) =>
        summary.kind === 'password' ? { ...summary, keyType: 'ecdsa' } : summary,
      );
      set({
        keys,
        initialized: true,
      });
      logger.info(`loaded ${keys.length} key credentials`);
    } catch (error) {
      logger.error('failed to load key credentials', error);
      set({ keys: [], initialized: true });
    }
  },

  addKey: async (key) => {
    const id = generateId();
    const now = Date.now();
    const keyType = resolveKeyType(key);
    const newKey: KeychainKey = {
      ...key,
      id,
      keyType,
      createdAt: now,
      updatedAt: now,
    };
    await invokeStoreKeyCredential({
      id: newKey.id,
      label: newKey.label,
      kind: newKey.kind,
      privateKey: newKey.privateKey,
      publicKey: newKey.publicKey,
      keyType,
    });
    set((state) => ({
      keys: [...state.keys, { id: newKey.id, label: newKey.label, keyType, kind: newKey.kind }],
    }));
    return newKey;
  },

  updateKey: async (id, updates) => {
    const current = get().keys.find((k) => k.id === id);
    if (!current) return;

    const existing = await invokeRetrieveKeyCredential(id);
    if (!existing) {
      throw new Error(`key credential ${id} not found`);
    }

    const updated: KeychainKey = {
      ...existing,
      ...updates,
      id,
      updatedAt: Date.now(),
    };

    const keyType = resolveKeyType(updated);

    await invokeStoreKeyCredential({
      id: updated.id,
      label: updated.label,
      kind: updated.kind,
      privateKey: updated.privateKey,
      publicKey: updated.publicKey,
      keyType,
    });

    set((state) => ({
      keys: state.keys.map((k) =>
        k.id === id ? { id: updated.id, label: updated.label, keyType, kind: updated.kind } : k,
      ),
    }));
  },

  removeKey: async (id) => {
    const affectedProfileIds = await invokeDeleteKeyCredential(id);
    set((state) => ({
      keys: state.keys.filter((k) => k.id !== id),
    }));
    return affectedProfileIds;
  },

  getKey: async (id) => {
    try {
      return await invokeRetrieveKeyCredential(id);
    } catch (error) {
      logger.error(`failed to retrieve key credential ${id}`, error);
      return undefined;
    }
  },
}));
