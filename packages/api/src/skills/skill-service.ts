// packages/api/src/skills/skill-service.ts
// M11 skill governance — the per-skill on/off toggle + the ENABLED-skill prompt
// block that actually reaches the agent. This is the seam that makes the toggle
// OPERABLE (not cosmetic): the invoke layer appends `block()` to the agent's
// system prompt, so enabling a skill genuinely injects its guidance and disabling
// it removes it. Skills are off by default (opt-in).
//
// The manifest loader + content reader are injectable so tests drive this without
// touching the on-disk manifest / skill files.

import type { SkillDefinition, SkillManifest } from '@choco/shared';
import { loadManifest } from '@choco/api/skills/manifest-loader';
import { loadSkillContent } from '@choco/api/skills/skill-reader';
import type { SkillEnablementStore } from '@choco/api/skills/skill-enablement-store';

/** A skill in the catalog plus its current on/off state. */
export interface SkillListEntry extends SkillDefinition {
  readonly enabled: boolean;
}

export interface SkillServiceDeps {
  readonly store: SkillEnablementStore;
  /** Manifest source (default: load from the @choco/skills package). */
  readonly loadManifestFn?: () => SkillManifest;
  /** Skill markdown reader (default: read `<id>.md` from the skills dir). */
  readonly readContent?: (id: string) => string;
}

export class SkillService {
  private readonly store: SkillEnablementStore;
  private readonly loadManifestFn: () => SkillManifest;
  private readonly readContent: (id: string) => string;

  constructor(deps: SkillServiceDeps) {
    this.store = deps.store;
    this.loadManifestFn = deps.loadManifestFn ?? ((): SkillManifest => loadManifest());
    this.readContent = deps.readContent ?? ((id): string => loadSkillContent(id));
  }

  /** The catalog with each skill's on/off state. */
  list(): SkillListEntry[] {
    const manifest = this.loadManifestFn();
    const enabled = this.store.getEnabled();
    return Object.values(manifest.skills).map((s) => ({ ...s, enabled: enabled.has(s.id) }));
  }

  /** Toggle a skill. Returns false when the id is not in the manifest. */
  setEnabled(id: string, enabled: boolean): boolean {
    const manifest = this.loadManifestFn();
    if (manifest.skills[id] === undefined) return false;
    this.store.setEnabled(id, enabled);
    return true;
  }

  /**
   * The system-prompt block for the ENABLED skills (each skill's markdown,
   * concatenated). Returns '' when none are enabled. A skill whose markdown file
   * is missing is skipped (a bad skill must never break a turn).
   */
  block(): string {
    const manifest = this.loadManifestFn();
    const enabled = this.store.getEnabled();
    const parts: string[] = [];
    for (const id of Object.keys(manifest.skills)) {
      if (!enabled.has(id)) continue;
      try {
        parts.push(`### ${id}\n\n${this.readContent(id).trim()}`);
      } catch {
        // missing/unreadable skill file → skip it (never break the invocation)
      }
    }
    if (parts.length === 0) return '';
    return `## 启用的技能（Skills）\n以下技能已启用，请按其指引工作：\n\n${parts.join('\n\n---\n\n')}`;
  }
}
