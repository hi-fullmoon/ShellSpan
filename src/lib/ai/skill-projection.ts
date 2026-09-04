import type { AgentSessionEvent, AgentSessionMessageSource } from '@/types/agent-session';
import type { LoadedSkill } from '@/types/agent-skill';
export interface SkillContext { readonly id: string; readonly content: string; readonly source: AgentSessionMessageSource; readonly loaded?: LoadedSkill }
export function skillContexts(event: AgentSessionEvent): readonly SkillContext[] {
  const make = (id: string, label: string, content: string, kind: 'skill-catalog' | 'skill-invocation', loaded?: LoadedSkill): SkillContext => ({
    id: `skills:${event.seq}:${id}`, content, source: { kind, label, producerId: 'shellspan.skills.v1', metadata: {} }, ...(loaded ? { loaded } : {}),
  });
  switch (event.type) {
    case 'skill/catalog_published': return [make('catalog', 'Skills', event.data.catalog.content, 'skill-catalog')];
    case 'skill/catalog_observed': return event.data.observation.diagnostics.length ? [make('diagnostics', `Skills · ${event.data.observation.status}`, event.data.observation.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n'), 'skill-catalog')] : [];
    case 'skill/step_prepared': {
      const prepared = event.data.prepared;
      if (prepared.protocolVersion !== 1) return [make('version', 'Skills', 'Unsupported Skills protocol', 'skill-catalog')];
      const items: SkillContext[] = prepared.catalog ? [make('catalog', 'Skills', prepared.catalog.content, 'skill-catalog')] : [];
      for (const outcome of prepared.outcomes) items.push(make(outcome.name, `/${outcome.name}`, outcome.loaded?.instructions ?? outcome.error ?? '', 'skill-invocation', outcome.loaded ?? undefined));
      return items;
    }
    case 'tool/result': {
      if (event.data.name !== 'skill' || event.data.status !== 'completed') return [];
      const loaded = event.data.data as LoadedSkill | undefined;
      return loaded?.provenance?.protocolVersion === 1 && typeof loaded.instructions === 'string'
        ? [make(event.data.callId, `/${loaded.name}`, loaded.instructions, 'skill-invocation', loaded)] : [];
    }
    default: return [];
  }
}
