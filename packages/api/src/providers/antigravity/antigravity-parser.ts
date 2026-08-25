// packages/api/src/providers/antigravity/antigravity-parser.ts
// Antigravity CLI (agy) plain-text 分类器。
//
// 设计来源（对齐对象）：Clowder providers/antigravity-cli-event-parser.ts
// `classifyAntigravityCliPlainText`。从对齐对象写 WHAT，不复制源码。
//
// AGY print 模式不暴露 Gemini 那套 NDJSON：它把最终回答当 plain stdout 一次性打出，
// 而部分 provider 失败（超时 / 账号侧没选模型）也表现为 plain text / 日志行。本分类器
// 据 stdout（+ stderr）的形状把一次 agy print 输出判为：
//   - text：正常回答（trim 外层空白，保留内部换行）
//   - error/timeout：agy --print-timeout 命中（可能仍 exit 0，故必须靠文本识别）
//   - error/missing_model：账号侧没有可用默认模型（agy 1.0.x 无已验证的 per-call --model）
//   - empty：无输出
//
// 纯、确定性、零 any。

/** 一次 agy print 输出的分类结果。 */
export type AntigravityCliPlainTextResult =
  | { kind: 'text'; content: string }
  | { kind: 'error'; errorKind: 'timeout' | 'missing_model'; error: string }
  | { kind: 'empty' };

export interface AntigravityCliPlainTextInput {
  readonly stdout: string;
  readonly stderr?: string;
  /**
   * 是否为 resume 回合（options.sessionId 存在）。Clowder 在 resumed 时给 text 标
   * `textMode:'replace'`；我们的 AgentMessage 无 textMode 字段，下游对单条 text 直接
   * concat 即全文，无需 replace 语义——故此处仅保留入参以对齐签名，不改变分类结果。
   */
  readonly resumed?: boolean;
}

export function classifyAntigravityCliPlainText(
  input: AntigravityCliPlainTextInput,
): AntigravityCliPlainTextResult {
  const trimmedStdout = stripFreshConversationWarning(input.stdout).trim();
  const diagnosticText = `${trimmedStdout}\n${(input.stderr ?? '').trim()}`;

  if (isAgyPrintTimeoutOutput(trimmedStdout)) {
    return {
      kind: 'error',
      errorKind: 'timeout',
      error: 'Antigravity CLI 响应超时：agy --print-timeout 返回了 timeout 文本（进程可能仍是 exit 0）。',
    };
  }

  if (isAgyMissingModelDiagnostic(diagnosticText)) {
    return { kind: 'error', errorKind: 'missing_model', error: formatAgyMissingModelError() };
  }

  if (trimmedStdout.length === 0) {
    return { kind: 'empty' };
  }

  return { kind: 'text', content: trimmedStdout };
}

/** `Error: timed out waiting for response` —— agy print-timeout 文本（可能仍 exit 0）。 */
function isAgyPrintTimeoutOutput(stdout: string): boolean {
  return /^Error:\s*timed out waiting for response\.?$/i.test(stdout.trim());
}

/**
 * 剥掉开头的 fresh-conversation 警告：`Warning: conversation "agy-..." not found`。
 * fresh 回合用一个尚不存在的 `--conversation agy-<uuid>` id，agy 会先打这行警告再正常回答。
 * 末尾句点对齐 Clowder 的已知格式，但设为可选（`\.?`）以容忍 agy 版本差异（本仓装 1.0.6，
 * Clowder 对的是 1.0.1）——真机文本格式待用户复验。
 */
function stripFreshConversationWarning(stdout: string): string {
  return stdout.replace(/^Warning:\s*conversation\s+"agy-[^"\r\n]+"\s+not found\.?\r?\n/i, '');
}

/**
 * 账号侧没选默认模型：agy 报 `neither PlanModel nor RequestedModel specified` 或
 * `Please use the /model command`（查 stdout+stderr 合并文本）。
 */
function isAgyMissingModelDiagnostic(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^(?:Error:|E\.\.\.)\s*(?:failed to construct executor:\s*)?neither PlanModel nor RequestedModel specified\b/im.test(
      trimmed,
    ) || /^(?:Error:|E\.\.\.).*\bPlease use the \/model command\b/im.test(trimmed)
  );
}

function formatAgyMissingModelError(): string {
  return [
    'Antigravity CLI 没有可用的账号侧默认模型。',
    'agy 1.0.x 没有已验证的 per-call 模型覆盖；请先运行 `agy` 进入交互模式，用 `/model` 选择默认模型后再重试。',
  ].join(' ');
}
