import type { JumpHostConfig } from '@/types';

type SshEndpoint = Pick<JumpHostConfig, 'host' | 'port' | 'username'>;
type SshRoute = SshEndpoint & { jumpHost?: SshEndpoint };

/** Identifies the target and jump host without retaining credentials. */
export function sshRouteKey({ host, port, username, jumpHost }: SshRoute): string {
  return JSON.stringify([host, port, username, jumpHost?.host ?? '', jumpHost?.port ?? 0, jumpHost?.username ?? '']);
}
