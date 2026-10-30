import { defineConfig } from 'vitest/config';
import frontend from './vitest.config';

/** Explicit gate for React checks which consume a compiled native test binary. */
export default defineConfig({
  ...frontend,
  test: {
    ...frontend.test,
    include: ['src/components/ai/__tests__/subagent-budget.native.test.tsx'],
    exclude: frontend.test?.exclude?.filter(pattern => pattern !== '**/*.native.test.{ts,tsx}'),
    maxWorkers: 1,
  },
});
