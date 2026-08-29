import { invokeDetectAgentProviderCapability } from '@/lib/tauri';
import type { AiProviderConfig, AiProviderProfile } from '@/types/ai';
import type { AgentProviderCapabilityEvidence } from '@/types/agent';

type CapabilityDetector = (
  provider: AiProviderConfig,
) => Promise<AgentProviderCapabilityEvidence>;

interface CapabilityCacheEntry {
  readonly promise: Promise<AgentProviderCapabilityEvidence>;
  expiresAt: number;
}

const UNKNOWN_CAPABILITY_CACHE_MS = 30_000;
const KNOWN_CAPABILITY_CACHE_MS = 5 * 60_000;

// Provider profiles are replaced rather than mutated by aiSettingsStore. A
// WeakMap therefore gives one cache/single-flight entry to an exact provider
// configuration without retaining removed profiles or copying API keys into a
// string cache key.
let capabilityCache = new WeakMap<AiProviderProfile, CapabilityCacheEntry>();

export function detectAgentProviderCapabilityCached(
  profile: AiProviderProfile,
  provider: AiProviderConfig,
  detector: CapabilityDetector = invokeDetectAgentProviderCapability,
): Promise<AgentProviderCapabilityEvidence> {
  const now = Date.now();
  const cached = capabilityCache.get(profile);
  if (cached && cached.expiresAt > now) return cached.promise;

  const entry: CapabilityCacheEntry = {
    promise: Promise.resolve().then(() => detector(provider)),
    expiresAt: Number.POSITIVE_INFINITY,
  };
  capabilityCache.set(profile, entry);
  void entry.promise.then((evidence) => {
    if (capabilityCache.get(profile) !== entry) return;
    entry.expiresAt = Date.now() + (evidence.support === 'unknown'
      ? UNKNOWN_CAPABILITY_CACHE_MS
      : KNOWN_CAPABILITY_CACHE_MS);
  }, () => {
    if (capabilityCache.get(profile) === entry) capabilityCache.delete(profile);
  });
  return entry.promise;
}

export function resetAgentProviderCapabilityCacheForTests(): void {
  capabilityCache = new WeakMap<AiProviderProfile, CapabilityCacheEntry>();
}
