import { describe, expect, it } from 'vitest';
import { loadAgentConfigs } from '@choco/api/config/agent-config-loader';

describe('default agent roster branding', () => {
  it('uses original model names without cat nicknames or cat mention aliases', () => {
    const agents = loadAgentConfigs();
    const primaryAgents = agents.filter((agent) => agent.id !== 'claude-opus-relay');

    expect(primaryAgents.map((agent) => agent.name)).toEqual(['Claude', 'Codex', 'Gemini']);
    expect(primaryAgents.map((agent) => agent.displayName)).toEqual(['Claude', 'Codex', 'Gemini']);
    expect(primaryAgents.map((agent) => agent.mentionPatterns)).toEqual([['@claude'], ['@codex'], ['@gemini']]);

    const relay = agents.find((agent) => agent.id === 'claude-opus-relay');
    expect(relay).toMatchObject({
      name: 'Claude 备用',
      displayName: 'Claude (备用)',
      mentionPatterns: ['@备用', '@relay'],
    });

    const serialized = JSON.stringify(agents);
    expect(serialized).not.toMatch(/猫|布偶|橘猫|暹罗|Ragdoll|Maine Coon|Siamese/);
  });
});
