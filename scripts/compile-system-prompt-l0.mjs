#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const templatePath = resolve(root, 'assets/system-prompts/system-prompt-l0.md');
const agentsPath = resolve(root, 'packages/api/src/config/agents.yaml');

function usage() {
  console.error('Usage: node scripts/compile-system-prompt-l0.mjs --agent <agent-id>');
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const agentId = arg('--agent');
if (!agentId) usage();

const template = readFileSync(templatePath, 'utf8');
const roster = load(readFileSync(agentsPath, 'utf8')).agents;
const agent = roster.find((item) => item.id === agentId);
if (!agent) {
  console.error(`Unknown agent: ${agentId}`);
  process.exit(1);
}

const identity = [
  `You are ${agent.displayName} (${agent.name}).`,
  `Role: ${agent.roleDescription}`,
  `Personality: ${agent.personality}`,
  `Identity constant: @${agent.id} model=${agent.defaultModel}`,
].join('\n');

const rows = roster
  .filter((item) => item.id !== agent.id)
  .map((item) => `| ${item.displayName} | ${item.mentionPatterns?.[0] ?? `@${item.id}`} | ${(item.strengths ?? []).join(', ')} | ${(item.restrictions ?? []).join(', ') || '-'} |`);

const teammates =
  rows.length === 0
    ? '(No other agents.)'
    : ['| Agent | Mention | Strengths | Restrictions |', '|---|---|---|---|', ...rows].join('\n');

process.stdout.write(
  template
    .replaceAll('{{IDENTITY_BLOCK}}', identity)
    .replaceAll('{{TEAMMATE_ROSTER}}', teammates)
    .replaceAll('{{INVOCATION_CONTEXT}}', ''),
);
