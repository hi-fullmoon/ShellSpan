import catalog from '../../../src-tauri/skills/catalog.json';
import type { SkillUserList } from '@/types/agent-skill';

/** Metadata only: instructions stay in the native binary and are loaded at invocation. */
export const builtinSkills = catalog;
export const builtinSkillPreview: SkillUserList = {
  sessionId: '', status: 'fresh', revision: null, diagnostics: [],
  entries: catalog.map(skill => ({
    name: skill.name, description: skill.description,
    relativePath: `builtin/${skill.name}.md`, resourceBase: 'builtin',
    modelInvocable: true, userInvocable: true, fileHash: '', instructionHash: '', extensions: {},
  })),
};
