import {expect,it} from 'vitest';
import {concurrentHistoryDisk,concurrentHistoryMemory,nativeHistoryConcurrentPlan} from './native-history-concurrent-plan';
import {matchesHistoryLifecycleArguments} from './native-history-lifecycle-plan';
const token='ca159f3e-a9cd-40df-a42e-4d5cad9a0427';
it('uses distinct exact approved probes and attributable ordinary exits for two live readers',()=>{
 const plan=nativeHistoryConcurrentPlan(token);expect(new Set(plan.sources).size).toBe(2);expect(new Set(plan.exits).size).toBe(2);
 for(const [reader,source]of plan.sources.entries()){expect(source).toContain('GetHistoryItems()');expect(source).toContain('并发历史');expect(source).toContain(plan.markers[reader]);expect(matchesHistoryLifecycleArguments({command:source},source)).toBe(true);expect(matchesHistoryLifecycleArguments({command:source+'\n'},source)).toBe(false);}
 expect(()=>nativeHistoryConcurrentPlan('../foreign')).toThrow('Owned concurrent');
});
it('requires the incremental reader to import the other completed line after its own write while memory stays bounded',()=>{
 const seeds=['seedA','seedB'],sources=['probeA','probeB'];
 expect(concurrentHistoryMemory(seeds,sources,0,'SaveIncrementally',3)).toEqual(['seedA','seedB','probeA']);
 expect(concurrentHistoryMemory(seeds,sources,1,'SaveIncrementally',3)).toEqual(['seedB','probeB','probeA']);
 expect(concurrentHistoryDisk(seeds,sources,['exitA','exitB'],'SaveIncrementally',3,'bothExited')).toEqual([...seeds,...sources,'exitA','exitB']);
});
it('checks each normal-exit save policy without inventing cross-reader SaveAtExit merging',()=>{
 const seeds=['seedA','seedB'],sources=['probeA','probeB'],exits=['exitA','exitB'];
 expect(concurrentHistoryMemory(seeds,sources,1,'SaveAtExit',71)).toEqual([...seeds,'probeB']);
 expect(concurrentHistoryDisk(seeds,sources,exits,'SaveAtExit',71,'probes')).toEqual(seeds);
 expect(concurrentHistoryDisk(seeds,sources,exits,'SaveAtExit',71,'firstExit')).toEqual([...seeds,'probeA','exitA']);
 expect(concurrentHistoryDisk(seeds,sources,exits,'SaveAtExit',71,'bothExited')).toEqual([...seeds,'probeB','exitB']);
 expect(concurrentHistoryMemory(seeds,sources,1,'SaveNothing',71)).toEqual(['probeB']);
 expect(concurrentHistoryDisk(seeds,sources,exits,'SaveNothing',71,'bothExited')).toEqual([]);
 expect(()=>concurrentHistoryMemory(seeds,sources,1,'unknown',3)).toThrow('Actual history');
});
