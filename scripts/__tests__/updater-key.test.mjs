import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUpdaterPubkeyFromTauriConfig, readUpdaterPubkeyKeyId } from '../updater-key.mjs';

const CURRENT_UPDATER_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYzNTc1OUI0MjA2OTRGMUIKUldRYlQya2d0RmxYOC9yQnk3dmxnZGc1YWlOaUQzaW9wb1BTbytvWVpYaGwrZkZuekgwdm5Bb3YK';
const TAURI_CONFIG_PATH = path.resolve(process.cwd(), 'src-tauri/tauri.conf.json');

describe('updater key config', () => {
  it('uses the current updater public key in tauri config', async () => {
    await expect(readUpdaterPubkeyFromTauriConfig(TAURI_CONFIG_PATH)).resolves.toBe(
      CURRENT_UPDATER_PUBKEY,
    );
  });

  it('points to updater key id F35759B420694F1B', async () => {
    await expect(readUpdaterPubkeyKeyId(TAURI_CONFIG_PATH)).resolves.toBe('F35759B420694F1B');
  });
});
