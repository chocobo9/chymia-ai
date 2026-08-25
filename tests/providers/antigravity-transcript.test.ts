import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractAntigravityTextFromStepPayload,
  readLatestAntigravityTranscriptText,
} from '@choco/api/providers/antigravity/antigravity-transcript';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'choco-agy-transcript-'));
  roots.push(root);
  return root;
}

function createConversationDb(dbPath: string, payloads: readonly Buffer[]): void {
  const db = new Database(dbPath);
  try {
    db.exec('create table steps (idx integer primary key, step_payload blob)');
    const insert = db.prepare('insert into steps (idx, step_payload) values (?, ?)');
    payloads.forEach((payload, idx) => insert.run(idx, payload));
  } finally {
    db.close();
  }
}

describe('Antigravity transcript fallback', () => {
  it('extracts the assistant markdown chunk and rejects prompt markers', () => {
    const payload = Buffer.from(
      [
        '\u0001Identity: Gemini\n@gemini prompt text',
        '\u0002### 十六进制转十进制分析\n\n转换结果为：**3,735,928,559**。\n\n请问你的上下文是哪一种数据类型？',
        '\u0003USER_REQUEST should not be selected',
      ].join(''),
      'utf8',
    );

    expect(extractAntigravityTextFromStepPayload(payload)).toBe(
      '### 十六进制转十进制分析\n\n转换结果为：**3,735,928,559**。\n\n请问你的上下文是哪一种数据类型？',
    );
  });

  it('reads the latest cached conversation DB for a workspace', () => {
    const root = tempRoot();
    const workspace = join(root, 'workspace');
    const appData = join(root, 'antigravity-cli');
    const convDir = join(appData, 'conversations');
    mkdirSync(join(appData, 'cache'), { recursive: true });
    mkdirSync(convDir, { recursive: true });
    writeFileSync(
      join(appData, 'cache', 'last_conversations.json'),
      JSON.stringify({ [workspace]: 'conv-1' }),
      'utf8',
    );
    createConversationDb(join(convDir, 'conv-1.db'), [
      Buffer.from('old answer', 'utf8'),
      Buffer.from('\u0001### Final\n\nfallback answer from sqlite', 'utf8'),
    ]);

    expect(readLatestAntigravityTranscriptText(workspace, appData)).toBe(
      '### Final\n\nfallback answer from sqlite',
    );
  });
});
