// M11 skill content reader.
// Source: clowder-architecture-design.md §5.5 (SkillManifestLoader.loadSkillContent).
//
// Reads a single skill's markdown body by id. Skill markdown is a prompt
// fragment loaded on demand (via MCP tool / CLAUDE.md instruction), NOT code.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillsDir as defaultSkillsDir } from '@clowder/skills';

/**
 * Valid skill id pattern: lowercase kebab-case. Constraining the id keeps it
 * a single filename component (no separators / traversal) before it is joined
 * onto {@link defaultSkillsDir}.
 */
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MARKDOWN_EXTENSION = '.md';

/**
 * Load the markdown body of a skill by id.
 *
 * @param skillId Skill id (kebab-case), e.g. `'tdd'`. Must match the filename
 *   `<skillId>.md` under the skills directory.
 * @param skillsDir Directory holding skill markdown files. Defaults to the
 *   @clowder/skills package's exported {@link defaultSkillsDir}.
 * @throws if the id is malformed or the file cannot be read.
 */
export function loadSkillContent(skillId: string, skillsDir: string = defaultSkillsDir): string {
  if (!SKILL_ID_PATTERN.test(skillId)) {
    throw new Error(`Invalid skill id: ${JSON.stringify(skillId)}`);
  }
  const filePath = join(skillsDir, `${skillId}${MARKDOWN_EXTENSION}`);
  return readFileSync(filePath, 'utf-8');
}
