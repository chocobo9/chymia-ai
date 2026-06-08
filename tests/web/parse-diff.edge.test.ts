// parseUnifiedDiff — pure unified-diff → per-file lines parser used by the 变更
// view. Ported from Clowder DiffViewer.parseUnifiedDiff; tested without React.

import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../../packages/web/src/lib/parse-diff.js';

describe('parseUnifiedDiff', () => {
  it('returns [] for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('splits per file and classifies add / remove / context / meta lines', () => {
    const diff =
      'diff --git a/src/a.ts b/src/a.ts\n' +
      '--- a/src/a.ts\n+++ b/src/a.ts\n' +
      '@@ -1,2 +1,2 @@\n const keep = 1;\n-const x = 1;\n+const x = 2;\n';
    const [file] = parseUnifiedDiff(diff);
    expect(file.path).toBe('src/a.ts');
    const types = file.lines.map((l) => l.type);
    expect(types).toContain('meta'); // the @@ header
    expect(file.lines.find((l) => l.type === 'add')?.content).toBe('const x = 2;');
    expect(file.lines.find((l) => l.type === 'remove')?.content).toBe('const x = 1;');
    expect(file.lines.find((l) => l.type === 'context')?.content).toBe('const keep = 1;');
  });

  it('resolves a renamed file to its new path (+++ b/ wins over diff --git old)', () => {
    const diff =
      'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n' +
      '--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const [file] = parseUnifiedDiff(diff);
    expect(file.path).toBe('new.ts');
  });

  it('separates two files into two entries', () => {
    const diff =
      'diff --git a/one.ts b/one.ts\n@@ -1 +1 @@\n-1\n+2\n' +
      'diff --git a/two.ts b/two.ts\n@@ -1 +1 @@\n-3\n+4\n';
    expect(parseUnifiedDiff(diff).map((f) => f.path)).toEqual(['one.ts', 'two.ts']);
  });

  it('annotates each line with 1-based old/new line numbers seeded from the @@ header', () => {
    const diff =
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n' +
      '@@ -5,3 +5,3 @@\n const keep = 1;\n-const x = 1;\n+const x = 2;\n const tail = 3;\n';
    const [file] = parseUnifiedDiff(diff);
    expect(file.lines.find((l) => l.content === 'const keep = 1;')).toMatchObject({ oldLine: 5, newLine: 5 });
    const removed = file.lines.find((l) => l.type === 'remove');
    expect(removed).toMatchObject({ oldLine: 6 });
    expect(removed?.newLine).toBeUndefined(); // a removed line has no new-file number
    const added = file.lines.find((l) => l.type === 'add');
    expect(added).toMatchObject({ newLine: 6 });
    expect(added?.oldLine).toBeUndefined(); // an added line has no old-file number
    // trailing context resumes after the 1-for-1 replacement: old 7 / new 7
    expect(file.lines.find((l) => l.content === 'const tail = 3;')).toMatchObject({ oldLine: 7, newLine: 7 });
  });
});
