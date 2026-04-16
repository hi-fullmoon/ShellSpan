import { describe, expect, it } from 'vitest';
import { readUpdaterPubkeyFromTauriConfig, readUpdaterPubkeyKeyId } from '../updater-key.mjs';

const CURRENT_UPDATER_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYzNTc1OUI0MjA2OTRGMUIKUldRYlQya2d0RmxYOC9yQnk3dmxnZGc1YWlOaUQzaW9wb1BTbytvWVpYaGwrZkZuekgwdm5Bb3YK';

describe('updater key config', () => {
  it('uses the current updater public key in tauri config', async () => {
    await expect(readUpdaterPubkeyFromTauriConfig()).resolves.toBe(CURRENT_UPDATER_PUBKEY);
  });

  it('points to updater key id F35759B420694F1B', async () => {
    await expect(readUpdaterPubkeyKeyId()).resolves.toBe('F35759B420694F1B');
  });
});
