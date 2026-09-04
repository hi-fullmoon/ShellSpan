import contract from './vision-contract.json';
import { resolveProviderProfile } from './provider-contract';
import type { AiProviderConfig } from '@/types/ai';
export const IMAGE_LIMITS = contract;
export function visionCapability(provider: AiProviderConfig) {
  return contract.routes.find(route => route.profile === resolveProviderProfile(provider)
    && route.kind === provider.kind && route.models.includes(provider.model.trim().toLowerCase()));
}
export function requireVision(provider: AiProviderConfig): void {
  if (!visionCapability(provider)) throw new Error('IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this provider, protocol, and model');
}
