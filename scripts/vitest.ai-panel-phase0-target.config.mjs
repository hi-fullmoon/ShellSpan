import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shellSpanRoot = process.env.SHELLSPAN_PHASE0_ROOT
  ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const referenceRoot = process.env.SHELLSPAN_DEEPSEEK_HARNESS_ROOT
  ?? join(shellSpanRoot, '..', 'deepseek-harness');
const referenceConfig = (await import(
  pathToFileURL(join(referenceRoot, 'vitest.web.config.ts')).href
)).default;

export default {
  ...referenceConfig,
  root: referenceRoot,
  test: {
    ...referenceConfig.test,
    include: [join(shellSpanRoot, 'scripts', 'ai-panel-phase0-target-host.test.mjs')],
    maxWorkers: 1,
    fileParallelism: false,
  },
};
