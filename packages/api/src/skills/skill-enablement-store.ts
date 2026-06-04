// packages/api/src/skills/skill-enablement-store.ts
// Per-skill on/off state, persisted under ~/.choco/skill-enabled.json. Skills are
// OFF by default (the file holds the ENABLED ids) — enabling a skill is opt-in, so
// agents only get the guidance the user explicitly turned on. Not secret, but kept
// with the other runtime config. Fail-open reads.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { globalConfigPath } from '@choco/api/config/global-config';

const SKILL_ENABLED_FILE = 'skill-enabled.json';

interface StoredEnabled {
  readonly enabled?: readonly string[];
}

/** File-backed set of ENABLED skill ids. */
export class SkillEnablementStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? globalConfigPath(SKILL_ENABLED_FILE);
  }

  /** The set of enabled skill ids (empty by default). */
  getEnabled(): Set<string> {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as StoredEnabled;
      const list = Array.isArray(parsed.enabled) ? parsed.enabled : [];
      return new Set(list.filter((id): id is string => typeof id === 'string'));
    } catch {
      return new Set();
    }
  }

  isEnabled(id: string): boolean {
    return this.getEnabled().has(id);
  }

  /** Turn a skill on/off (idempotent); persists the updated set. */
  setEnabled(id: string, enabled: boolean): void {
    const set = this.getEnabled();
    if (enabled) set.add(id);
    else set.delete(id);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ enabled: [...set] }, null, 2), 'utf-8');
  }
}
