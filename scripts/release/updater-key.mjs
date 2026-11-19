import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function readUpdaterPubkeyFromTauriConfig(
  configPath = resolve(import.meta.dirname, '../../src-tauri/tauri.conf.json'),
) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return config.plugins?.updater?.pubkey ?? '';
}

function decodeWrappedBase64(text) {
  return Buffer.from(text, 'base64').toString('utf8');
}

function extractKeyIdFromDecodedMinisignPublicKey(decodedKey) {
  const firstLine = decodedKey.trim().split('\n')[0] ?? '';
  const match = firstLine.match(/public key:\s*([A-F0-9]+)/i);
  return match?.[1]?.toUpperCase() ?? '';
}

export async function readUpdaterPubkeyKeyId(configPath) {
  const pubkey = await readUpdaterPubkeyFromTauriConfig(configPath);
  return extractKeyIdFromDecodedMinisignPublicKey(decodeWrappedBase64(pubkey));
}
