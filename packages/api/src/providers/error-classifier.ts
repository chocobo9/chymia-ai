// packages/api/src/providers/error-classifier.ts
// M2: CLI 错误分类器
//
// 把 CLI 的错误文本（stderr / result.error / 退出原因）归到四类，供 M3 retry
// 策略使用（设计 §7.5 / 状态流 §6.2 / 补充 §A9）：
//   - missing session → 清 session 后重试
//   - prompt limit     → 清 session 后重试
//   - transient        → 原样重试一次
//   - timeout          → 清 session 后重试
//
// 补充 §A9 给出初始宽泛正则，并明确"针对每个 CLI 的实际错误消息格式调优、覆盖多变体"。
// 这里按该指引收紧并补全 Claude / Codex / Gemini 三种 CLI 的真实措辞变体。
//
// 全部纯函数、对 null/undefined/空串安全；不抛异常。

/** 归一化：小写 + 折叠空白，便于做大小写不敏感的子串匹配 */
function normalize(input: string | null | undefined): string {
  if (!input) {
    return '';
  }
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 是否为 "session 不存在 / 无效 / 已过期" 错误。
 *
 * 真实变体来源：
 *   - Claude Code: "No conversation found with session id ...", "session not found"
 *   - Codex:       "experimental-resume: unknown session", "rollout not found"
 *   - Gemini:      "resume failed: session expired", "invalid session id"
 */
export function isMissingSessionError(message: string | null | undefined): boolean {
  const m = normalize(message);
  if (!m) {
    return false;
  }
  const sessionRefersTo =
    m.includes('session') || m.includes('conversation') || m.includes('rollout');
  const notFoundLike =
    m.includes('not found') ||
    m.includes('no conversation found') ||
    m.includes('unknown session') ||
    m.includes('does not exist') ||
    m.includes('invalid session') ||
    m.includes('session expired') ||
    m.includes('resume failed') ||
    m.includes('cannot resume') ||
    m.includes('missing session');
  return sessionRefersTo && notFoundLike;
}

/**
 * 是否为 "上下文/prompt 过长、超出窗口" 错误。
 *
 * 真实变体来源：
 *   - Claude Code: "prompt is too long", "input length ... exceeds the maximum"
 *   - Codex:       "context length exceeded", "maximum context length is ... tokens"
 *   - Gemini:      "request payload size exceeds the limit",
 *                  "the input token count ... exceeds the maximum"
 */
export function isPromptLimitError(message: string | null | undefined): boolean {
  const m = normalize(message);
  if (!m) {
    return false;
  }
  if (m.includes('prompt is too long') || m.includes('prompt too long')) {
    return true;
  }
  if (m.includes('context length exceeded') || m.includes('context_length_exceeded')) {
    return true;
  }
  if (m.includes('token limit') || m.includes('max tokens') || m.includes('max_tokens')) {
    return true;
  }
  if (m.includes('maximum context length') && m.includes('token')) {
    return true;
  }
  // 通用 "input/token/payload ... exceed ... maximum/limit" 组合
  const mentionsInput =
    m.includes('input length') ||
    m.includes('input token') ||
    m.includes('token count') ||
    m.includes('payload size');
  const mentionsExceed =
    m.includes('exceed') || m.includes('exceeds') || m.includes('too large');
  const mentionsLimit =
    m.includes('maximum') || m.includes('limit') || m.includes('max');
  return mentionsInput && mentionsExceed && mentionsLimit;
}

/**
 * 是否为 "上下文窗口耗尽 / 会话上下文溢出" 错误（区别于 prompt 单次过长）。
 * 对齐 Clowder invoke-helpers.isContextWindowOverflowError（ran out of room |
 * context window | context_window）。与 prompt-limit 行为相同（清 session 重试），
 * 但语义不同：多轮累积撑满上下文，非单条输入超长——分开分类便于诊断区分。
 */
export function isContextWindowOverflowError(message: string | null | undefined): boolean {
  const m = normalize(message);
  if (!m) {
    return false;
  }
  return (
    m.includes('ran out of room') ||
    m.includes('context window') ||
    m.includes('context_window')
  );
}

/**
 * 是否为 "瞬时/可重试" CLI 错误（网络抖动、5xx、限流、连接重置等）。
 *
 * 真实变体来源：
 *   - Claude Code: "overloaded_error", "service temporarily unavailable", "529"
 *   - Codex:       "stream disconnected", "ECONNRESET", "503 service unavailable"
 *   - Gemini:      "internal error, please retry", "ETIMEDOUT"
 *
 * 注意：prompt-limit 与 missing-session 是更具体的分类，调用方应先判它们；
 * 本函数只识别广义瞬时性信号。
 */
export function isTransientCliError(message: string | null | undefined): boolean {
  const m = normalize(message);
  if (!m) {
    return false;
  }
  const transientSignals = [
    'overloaded',
    'service temporarily unavailable',
    'service unavailable',
    'temporarily unavailable',
    'please retry',
    'please try again',
    'try again later',
    'rate limit',
    'rate_limit',
    'too many requests',
    'stream disconnected',
    'connection reset',
    'connection closed',
    'econnreset',
    'econnrefused',
    // §A9: ETIMEDOUT counts as transient too (intentional overlap with timeout)
    'etimedout',
    'deadline exceeded',
    'epipe',
    'socket hang up',
    'network error',
    'internal error',
    'internal server error',
    '429',
    '500',
    '502',
    '503',
    '504',
    '529',
  ];
  return transientSignals.some((sig) => m.includes(sig));
}

/**
 * 是否为超时错误。
 *
 * 真实变体来源：
 *   - 进程层（cli-spawn）：CliExitReason === 'timeout'（service 据此组装 "timed out" 文本）
 *   - Claude Code: "request timed out"
 *   - Codex:       "ETIMEDOUT", "operation timed out"
 *   - Gemini:      "context deadline exceeded", "timeout waiting for response"
 *
 * 与 transient 可能有交集（deadline exceeded）属预期：调用方按 timeout → 清 session
 * 重试，比 transient 的原样重试更激进，故应优先判 timeout。
 */
export function isTimeoutError(message: string | null | undefined): boolean {
  const m = normalize(message);
  if (!m) {
    return false;
  }
  return (
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('etimedout') ||
    m.includes('deadline exceeded') ||
    m.includes('operation timed out') ||
    m.includes('request timeout')
  );
}
