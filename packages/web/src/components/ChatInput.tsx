// M9 ChatInput — the composer (.composer) in the .d-choco design: a mouse-
// selectable scope chip (lock the turn's target agent), an auto-growing textarea,
// and a send button (or the injected cancel/stop slot while a turn is in flight),
// with composer hints below. Above the composer, an @mention autocomplete dropdown
// (.mentions): when the user types "@" followed by a partial token we surface
// matching agents from the LIVE roster (agent store) — each row shows the agent
// name, model, strengths, and the mention pattern; picking one completes the token.
//
// Scope lock: clicking the chip opens a picker of 全体 + each roster agent. A
// locked agent persists across messages (per-thread, owned by the parent) so a
// 1:1 conversation needs no re-@; on send we auto-prepend the locked agent's
// @mention UNLESS the message already carries an explicit known mention (explicit
// always wins). 全体 prepends the broadcast token @all (F078) so the turn fans out
// to ALL available agents — unless the user already typed a @mention/broadcast.
//
// Preserves the wiring/a11y hooks: data-testid="chat-input"/"chat-input-textarea"
// /"chat-send-button"/"mention-suggestions"/"mention-suggestion", data-pattern,
// role="listbox"/"option". Enter sends, Shift+Enter inserts a newline.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { BROADCAST_MENTION, BROADCAST_MENTIONS } from '@choco/shared';
import { useAgentStore } from '../stores/agent-store.js';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss.js';
import type { AgentRosterEntry } from '../lib/api.js';
import { IconSend, IconStop } from './choco/icons.js';
import { Avatar, modelBadge, shortName } from './choco/primitives.js';

/** A single autocomplete candidate (enriched with roster display fields). */
export interface MentionSuggestion {
  readonly agentId: string;
  readonly displayName: string;
  readonly shortName: string;
  readonly model: string;
  readonly accent: string;
  readonly strengths: readonly string[];
  readonly pattern: string;
}

/** Matches the @token currently being typed at the caret-end of the text. */
const ACTIVE_MENTION = /(^|\s)@([^\s@]*)$/;

export interface ChatInputProps {
  /** Send the composed message (container forwards to the API). */
  readonly onSend: (content: string) => void;
  /** Disable input while a turn is in flight (optional). */
  readonly disabled?: boolean;
  /**
   * True while a turn is in flight. When busy the composer shows the 停止 (stop)
   * button INSTEAD of send (never both, never 停止 at idle — Bug 2).
   */
  readonly busy?: boolean;
  /** Cancel the in-flight turn (wired to the socket cancel). */
  readonly onCancel?: () => void;
  /**
   * The currently locked target agent's roster id, or null/undefined for 全体
   * (broadcast / default routing). Owned by the parent so the lock persists
   * per-thread. When set, send auto-prepends this agent's @mention.
   */
  readonly lockedAgentId?: string | null;
  /** Change the locked target agent (null = 全体). Omit to render a read-only chip. */
  readonly onLockChange?: (agentId: string | null) => void;
  /** Active thread id — drives per-thread draft preservation. */
  readonly threadId?: string | null;
}

/** True when `text` already carries an explicit mention of a KNOWN roster agent. */
function hasKnownMention(text: string, roster: readonly AgentRosterEntry[]): boolean {
  const lower = text.toLowerCase();
  return roster.some((agent) =>
    agent.mentionPatterns.some((pattern) => lower.includes(pattern.toLowerCase())),
  );
}

/** True when `text` already carries a broadcast token (@all / @全体). */
function hasBroadcastToken(text: string): boolean {
  const lower = text.toLowerCase();
  return BROADCAST_MENTIONS.some((token) => lower.includes(token.toLowerCase()));
}

/** Build the full suggestion list from the roster's mentionPatterns. */
function buildSuggestions(roster: readonly AgentRosterEntry[]): readonly MentionSuggestion[] {
  return roster.flatMap((agent) =>
    agent.mentionPatterns.map((pattern) => ({
      agentId: agent.id,
      displayName: agent.displayName,
      shortName: shortName(agent),
      model: modelBadge(agent),
      accent: agent.color.primary,
      strengths: agent.strengths,
      pattern,
    })),
  );
}

/** Extract the partial "@..." token at the end of `value`, if any. */
function activeMentionToken(value: string): string | null {
  const match = ACTIVE_MENTION.exec(value);
  return match === null ? null : match[2];
}

/** Render the composer with @mention autocomplete. */
export function ChatInput(props: ChatInputProps): ReactElement {
  const { onSend, disabled = false, busy = false, onCancel, lockedAgentId = null, onLockChange, threadId } = props;
  const [value, setValue] = useState('');
  // Per-thread draft map: saves/restores the textarea content on thread switch.
  const draftMap = useRef<Record<string, string>>({});
  const latestValue = useRef(value);
  latestValue.current = value;
  const prevThreadId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (prevThreadId.current != null) {
      draftMap.current[prevThreadId.current] = latestValue.current;
    }
    prevThreadId.current = threadId;
    setValue(threadId != null ? (draftMap.current[threadId] ?? '') : '');
  }, [threadId]);

  const clearDraft = useCallback(() => {
    if (threadId != null) {
      delete draftMap.current[threadId];
    }
  }, [threadId]);

  // Index of the highlighted @mention suggestion (keyboard ↑/↓ navigation).
  const [activeIndex, setActiveIndex] = useState(0);
  // True after the user presses Esc to dismiss the dropdown without picking;
  // reset whenever the active @token changes so typing more re-opens it.
  const [dismissed, setDismissed] = useState(false);
  // Whether the scope (target-agent) picker popover is open.
  const [scopeOpen, setScopeOpen] = useState(false);
  const roster = useAgentStore((s) => s.roster);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scopeWrapRef = useRef<HTMLDivElement | null>(null);

  // The locked target agent's roster entry, if any (null/unknown id → 全体).
  const lockedEntry = useMemo(
    () => (lockedAgentId === null ? undefined : roster.find((a) => a.id === lockedAgentId)),
    [roster, lockedAgentId],
  );

  // Close the scope picker on Escape and on a click outside the chip+menu.
  useOverlayDismiss(scopeOpen, () => setScopeOpen(false));
  useEffect(() => {
    if (!scopeOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (scopeWrapRef.current !== null && !scopeWrapRef.current.contains(event.target as Node)) {
        setScopeOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [scopeOpen]);

  const pickScope = (agentId: string | null): void => {
    onLockChange?.(agentId);
    setScopeOpen(false);
    textareaRef.current?.focus();
  };

  // Auto-grow the textarea to fit its content: reset to natural height, then snap
  // to scrollHeight so Shift+Enter newlines lengthen the box (CSS max-height caps
  // it, then it scrolls). Runs on every value change — including the reset to ''
  // after send, which shrinks it back to one row. useLayoutEffect so the height
  // is set before paint (no flicker). Guarded for jsdom, where scrollHeight is 0.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta === null) return;
    ta.style.height = 'auto';
    if (ta.scrollHeight > 0) {
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [value]);

  const allSuggestions = useMemo(() => buildSuggestions(roster), [roster]);

  const token = activeMentionToken(value);
  const suggestions = useMemo(() => {
    if (token === null) return [] as readonly MentionSuggestion[];
    const needle = `@${token}`.toLowerCase();
    return allSuggestions.filter((s) => s.pattern.toLowerCase().startsWith(needle));
  }, [token, allSuggestions]);

  // The dropdown is open only when there are matches AND it hasn't been
  // Esc-dismissed for the current token. While open, Enter PICKS the highlighted
  // suggestion (it does NOT send) and ↑/↓ move the highlight — so "@" + Enter
  // chooses an agent instead of firing a bare "@" message.
  const showSuggestions = suggestions.length > 0 && !dismissed;

  // Reset the highlight + un-dismiss every time the typed @token changes.
  useEffect(() => {
    setActiveIndex(0);
    setDismissed(false);
  }, [token]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setValue(event.target.value);
  };

  const applySuggestion = (pattern: string): void => {
    setValue((current) =>
      current.replace(ACTIVE_MENTION, (_full, lead: string) => `${lead}${pattern} `),
    );
    textareaRef.current?.focus();
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    // Lock-aware send:
    //   • a specific agent locked + no explicit known @mention → prepend its mention
    //     so the turn targets it without re-typing "@" each time;
    //   • 全体 (no lock) + no explicit @mention and no broadcast token → prepend @all
    //     so the turn BROADCASTS to all agents (F078), not a single default agent;
    //   • an explicit @mention (or an already-typed broadcast token) → send verbatim.
    let outgoing = trimmed;
    if (lockedEntry !== undefined) {
      const pattern = lockedEntry.mentionPatterns[0];
      outgoing =
        pattern !== undefined && !hasKnownMention(trimmed, roster) ? `${pattern} ${trimmed}` : trimmed;
    } else if (!hasKnownMention(trimmed, roster) && !hasBroadcastToken(trimmed)) {
      outgoing = `${BROADCAST_MENTION} ${trimmed}`;
    }
    onSend(outgoing);
    setValue('');
    clearDraft();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showSuggestions) {
      const count = suggestions.length;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % count);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + count) % count);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        // Enter/Tab confirm the highlighted agent rather than sending the message.
        event.preventDefault();
        applySuggestion(suggestions[Math.min(activeIndex, count - 1)].pattern);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap chat-input" data-testid="chat-input">
      {showSuggestions && (
        <ul className="mentions chat-input__suggestions" data-testid="mention-suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li key={`${s.agentId}:${s.pattern}`} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                className={`mention chat-input__suggestion${i === activeIndex ? ' active' : ''}`}
                data-testid="mention-suggestion"
                data-pattern={s.pattern}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => applySuggestion(s.pattern)}
              >
                <Avatar agentId={s.agentId} name={s.shortName} accent={s.accent} small />
                <div className="mention-main">
                  <div className="mention-name chat-input__suggestion-name">
                    {s.shortName} <span>{s.model}</span>
                  </div>
                  {s.strengths.length > 0 && (
                    <div className="mention-hint">{s.strengths.join(' · ')}</div>
                  )}
                </div>
                <span className="mention-key chat-input__suggestion-pattern">{s.pattern}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer chat-input__row">
        <div className="scope-wrap" ref={scopeWrapRef}>
          <button
            type="button"
            className={`scope${lockedEntry !== undefined ? ' locked' : ''}`}
            data-testid="scope-selector"
            data-agent={lockedEntry?.id ?? ''}
            aria-haspopup="listbox"
            aria-expanded={scopeOpen}
            aria-label="选择对话对象"
            disabled={onLockChange === undefined}
            onClick={() => setScopeOpen((v) => !v)}
            style={lockedEntry === undefined ? undefined : { color: lockedEntry.color.primary }}
          >
            {lockedEntry === undefined ? '@全体' : `@${shortName(lockedEntry)}`}
          </button>
          {scopeOpen && (
            <ul className="scope-menu" data-testid="scope-menu" role="listbox">
              <li role="option" aria-selected={lockedAgentId === null}>
                <button
                  type="button"
                  className={`scope-opt${lockedAgentId === null ? ' active' : ''}`}
                  data-testid="scope-option"
                  data-agent=""
                  onClick={() => pickScope(null)}
                >
                  <span className="scope-opt-all" aria-hidden="true">
                    @
                  </span>
                  <span className="scope-opt-main">全体</span>
                  <span className="scope-opt-hint">广播给所有 agent</span>
                </button>
              </li>
              {roster.map((agent) => (
                <li key={agent.id} role="option" aria-selected={agent.id === lockedAgentId}>
                  <button
                    type="button"
                    className={`scope-opt${agent.id === lockedAgentId ? ' active' : ''}`}
                    data-testid="scope-option"
                    data-agent={agent.id}
                    onClick={() => pickScope(agent.id)}
                  >
                    <Avatar agentId={agent.id} name={shortName(agent)} accent={agent.color.primary} small />
                    <span className="scope-opt-main" style={{ color: agent.color.primary }}>
                      {shortName(agent)}
                    </span>
                    <span className="scope-opt-hint">{modelBadge(agent)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <textarea
          ref={textareaRef}
          className="ta chat-input__textarea"
          data-testid="chat-input-textarea"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={
            lockedEntry === undefined
              ? '给团队下达指令…  输入 @ 点名某个 agent'
              : `对 ${shortName(lockedEntry)} 说…  （@ 可临时改点名）`
          }
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        {busy ? (
          <button
            type="button"
            className="cancel chat-input__cancel"
            data-testid="cancel-button"
            onClick={onCancel}
            aria-label="停止"
          >
            <IconStop /> 停止
          </button>
        ) : (
          <button
            type="button"
            className="send chat-input__send"
            data-testid="chat-send-button"
            disabled={disabled || value.trim().length === 0}
            onClick={submit}
            aria-label="发送"
          >
            <IconSend />
          </button>
        )}
      </div>
      <div className="composer-hint">
        {showSuggestions ? (
          <span>
            <b>↑↓</b> 选择 · <b>Enter</b> 确认 · <b>Esc</b> 关闭
          </span>
        ) : (
          <span>
            <b>Enter</b> 发送 · <b>Shift+Enter</b> 换行
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>@claude 架构 · @codex 评审 · @gemini 设计</span>
      </div>
    </div>
  );
}
