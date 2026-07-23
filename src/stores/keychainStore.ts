import { create } from 'zustand';
import type { KeychainKey } from '@/types';
import {
  invokeStoreKeyCredential,
  invokeListKeyCredentials,
  invokeRetrieveKeyCredential,
  invokeDeleteKeyCredential,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const logger = createLogger('keychainStore');

function detectKeyType(privateKey: string): string {
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
  return 'unknown';
}

export interface KeyCredentialSummary {
  id: string;
  label: string;
  keyType: string;
}

interface KeychainState {
  keys: KeyCredentialSummary[];
  initialized: boolean;
  hydrate: () => Promise<void>;
  addKey: (
    key: Omit<KeychainKey, 'id' | 'createdAt' | 'updatedAt'>,
  ) => Promise<KeychainKey>;
  updateKey: (
    id: string,
    updates: Partial<Omit<KeychainKey, 'id' | 'createdAt' | 'updatedAt'>>,
  ) => Promise<void>;
  removeKey: (id: string) => Promise<void>;
  getKey: (id: string) => Promise<KeychainKey | undefined>;
}

export const useKeychainStore = create<KeychainState>()((set, get) => ({
  keys: [],
  initialized: false,

  hydrate: async () => {
    try {
      const summaries = await invokeListKeyCredentials();
      set({ keys: summaries, initialized: true });
      logger.info(`loaded ${summaries.length} key credentials from keychain`);
    } catch (error) {
      logger.error('failed to load key credentials from keychain', error);
      set({ keys: [], initialized: true });
    }
  },

  addKey: async (key) => {
    const id = generateId();
    const now = Date.now();
    const keyType = detectKeyType(key.privateKey);
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
      privateKey: newKey.privateKey,
      publicKey: newKey.publicKey,
      certificate: newKey.certificate,
    });
    set((state) => ({
      keys: [...state.keys, { id: newKey.id, label: newKey.label, keyType }],
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

    const keyType = updated.privateKey !== undefined
      ? detectKeyType(updated.privateKey)
      : current.keyType;

    await invokeStoreKeyCredential({
      id: updated.id,
      label: updated.label,
      privateKey: updated.privateKey,
      publicKey: updated.publicKey,
      certificate: updated.certificate,
    });

    set((state) => ({
      keys: state.keys.map((k) =>
        k.id === id ? { id: updated.id, label: updated.label, keyType } : k,
      ),
    }));
  },

  removeKey: async (id) => {
    await invokeDeleteKeyCredential(id);
    set((state) => ({
      keys: state.keys.filter((k) => k.id !== id),
    }));
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
