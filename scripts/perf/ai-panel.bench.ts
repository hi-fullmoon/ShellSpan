import { bench, describe } from 'vitest';
import { restoreConversation, reviseNodes, reprojectStreaming } from './ai-panel-workloads';

describe('AI panel long-conversation diagnostics', () => {
  bench('project 5,000 messages into 7,500 keyed nodes', restoreConversation,
    { iterations: 5, time: 500, warmupIterations: 1, warmupTime: 100 });
  bench('compute memo revisions for the 7,500-node render window', reviseNodes,
    { iterations: 10, time: 500, warmupIterations: 2, warmupTime: 100 });
  bench('reproject the 7,500-node window across 20 streaming revisions', reprojectStreaming,
    { iterations: 5, time: 500, warmupIterations: 1, warmupTime: 100 });
});
