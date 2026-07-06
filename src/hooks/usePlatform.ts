import { useState } from 'react';
import { getPlatform, type Platform } from '@/lib/platform';

export function usePlatform(): Platform {
  const [currentPlatform] = useState<Platform>(() => getPlatform());
  return currentPlatform;
}
