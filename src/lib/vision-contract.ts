import contract from './vision-contract.json';
import { providerCapabilities, modelResolution } from './provider-contract';
import type { AiProviderConfig } from '@/types/ai';
export const IMAGE_LIMITS = contract;
export function visionCapability(provider: AiProviderConfig) {
  return providerCapabilities(provider).vision;
}
export function requireVision(provider: AiProviderConfig): void {
  const state = modelResolution(provider);
  if (state.status !== 'ready') throw new Error(state.status === 'error' ? state.error : 'MODEL_RESOLUTION_PENDING');
  if (!visionCapability(provider)) throw new Error('IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this model');
}
