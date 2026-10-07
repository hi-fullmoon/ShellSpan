import { t } from '@/locales';
import type { AiCreateSessionInput } from './session-adapter';

/** Root intent does not depend on approval mode. Rust validates and canonicalizes it. */
export function freezeCreationProjectRoot(input: AiCreateSessionInput, root: string | null): AiCreateSessionInput {
  const target = input.request.target;
  const restricted = input.request.sandboxPolicy !== undefined && input.request.sandboxPolicy !== 'host';
  if (!target) return input;
  if (!root) {
    if (restricted) throw new Error(`sandboxWorkspaceMissing: ${t('agent.sandbox.rootRequired')}`);
    return input;
  }
  return { ...input, request: { ...input.request, target: target.kind === 'local'
    ? { ...target, cwd: root } : { ...target, rootPath: root } } };
}
