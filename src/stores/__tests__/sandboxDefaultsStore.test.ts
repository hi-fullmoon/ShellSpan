import { describe, expect, it } from 'vitest';
import { parseSandboxDefaults, sandboxDefaultScope } from '../sandboxDefaultsStore';

describe('Sandbox configuration is not authorization', () => {
  it('retains only policy and directory candidates from stored JSON', () => {
    const data = {version:1,defaults:{'project:"/project"':{policy:'workspace',cacheDirectories:['/tmp/project-cache'],resourceGrants:[{authorizationId:'not-authority'}],expiresAtUnixMs:9999999,capabilityId:'never-restored',apiKey:'never-saved'}}};
    const parsed = parseSandboxDefaults([['agent_sandbox_defaults',JSON.stringify(data)]]);
    expect(parsed).toEqual({'project:"/project"':{policy:'workspace',cacheDirectories:['/tmp/project-cache']}});
    expect(JSON.stringify(parsed)).not.toMatch(/resourceGrants|authorizationId|capabilityId|apiKey|expiresAt/);
  });
  it('rejects damaged JSON instead of silently applying host access', () => {
    expect(() => parseSandboxDefaults([['agent_sandbox_defaults','{']])).toThrow();
    expect(() => parseSandboxDefaults([['agent_sandbox_defaults','{"version":2,"defaults":{}}']])).toThrow();
    expect(parseSandboxDefaults([])).toEqual({});
  });
  it('binds defaults to the exact project or account/connection, not a temporary terminal id', () => {
    const project = {kind:'local' as const,targetId:'local',sessionId:'first',cwd:'/project'};
    expect(sandboxDefaultScope(project)).toBe(sandboxDefaultScope({...project,sessionId:'second'}));
    expect(sandboxDefaultScope(project)).not.toBe(sandboxDefaultScope({...project,cwd:'/other'}));
    const connection = {kind:'remote' as const,targetId:'remote',sessionId:'first',profileId:'profile',host:'host.example',port:22,username:'operator'};
    expect(sandboxDefaultScope(connection)).not.toBe(sandboxDefaultScope({...connection,username:'another-account'}));
    expect(sandboxDefaultScope({...project,cwd:undefined})).toBeNull();
  });
});
