import { readFile } from 'node:fs/promises';

export async function readUpdaterPubkeyFromTauriConfig() {
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
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

export async function readUpdaterPubkeyKeyId() {
  const pubkey = await readUpdaterPubkeyFromTauriConfig();
  return extractKeyIdFromDecodedMinisignPublicKey(decodeWrappedBase64(pubkey));
}
