import {describe,it,expect} from 'vitest';
import {approvalContentionSources,matchesApprovalContentionArgs} from './native-approval-contention-plan';
const token='8f85437a-9051-49ca-807f-f84682356dcb';
describe('approval-preserving native contention plan',()=>{
 it('keeps the two effects isolated and the owner hold bounded',()=>{const source=approvalContentionSources(token);expect(source.owner).toContain('Start-Sleep -Seconds 10');expect(source.owner).toContain(`contention-owner-${token}.txt`);expect(source.contender).toContain(`contention-contender-${token}.txt`);expect(source.contender).not.toContain('START');});
 it('rejects an unowned token',()=>{expect(()=>approvalContentionSources('../escape')).toThrow('Owned contention token');});
 it('requires each exact source and timeout before approval',()=>{const source=approvalContentionSources(token);expect(matchesApprovalContentionArgs({command:source.owner,background:false,timeoutMs:30000},source.owner,true)).toBe(true);expect(matchesApprovalContentionArgs({command:source.contender,timeoutMs:5000},source.contender,false)).toBe(true);expect(matchesApprovalContentionArgs({command:source.owner,timeoutMs:5000},source.contender,false)).toBe(false);});
 it.each([{background:true},{timeoutMs:30000},{command:'changed'},{cwd:'other'},{shell:'direct'}])('refuses altered contender approval arguments: %j',change=>{const source=approvalContentionSources(token);expect(matchesApprovalContentionArgs({command:source.contender,background:false,timeoutMs:5000,...change},source.contender,false)).toBe(false);});
});
