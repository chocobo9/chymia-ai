// M9 ChatInput — the composer (.composer) in the .d-choco design: a scope chip,
// an auto-growing textarea, and a send button (or the injected cancel/stop slot
// while a turn is in flight), with composer hints below. Above the composer, an
// @mention autocomplete dropdown (.mentions): when the user types "@" followed
// by a partial token we surface matching agents from the LIVE roster (agent
// store) — each row shows the agent name, model, strengths, and the mention
// pattern; picking one completes the token in place.
//
// Preserves the wiring/a11y hooks: data-testid="chat-input"/"chat-input-textarea"
// /"chat-send-button"/"mention-suggestions"/"mention-suggestion", data-pattern,
// role="listbox"/"option". Enter sends, Shift+Enter inserts a newline.

import {
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type ChangeEvent,
} from 'react';
import { useAgentStore } from '../stores/agent-store.js';
import type { AgentRosterEntry } from '../lib/api.js';
import { IconSend } from './choco/icons.js';
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
   * Slot rendered alongside the send button (the App's cancel/stop button).
   * Rendered in addition to send so the send-button wiring is never removed.
   */
  readonly cancelSlot?: ReactNode;
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
  const { onSend, disabled = false, cancelSlot } = props;
  const [value, setValue] = useState('');
  const roster = useAgentStore((s) => s.roster);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const allSuggestions = useMemo(() => buildSuggestions(roster), [roster]);

  const token = activeMentionToken(value);
  const suggestions = useMemo(() => {
    if (token === null) return [] as readonly MentionSuggestion[];
    const needle = `@${token}`.toLowerCase();
    return allSuggestions.filter((s) => s.pattern.toLowerCase().startsWith(needle));
  }, [token, allSuggestions]);

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
    onSend(trimmed);
    setValue('');
  };

  return (
    <div className="composer-wrap chat-input" data-testid="chat-input">
      {suggestions.length > 0 && (
        <ul className="mentions chat-input__suggestions" data-testid="mention-suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li key={`${s.agentId}:${s.pattern}`} role="option" aria-selected="false">
              <button
                type="button"
                className={`mention chat-input__suggestion${i === 0 ? ' active' : ''}`}
                data-testid="mention-suggestion"
                data-pattern={s.pattern}
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
        <span className="scope">@all</span>
        <textarea
          ref={textareaRef}
          className="ta chat-input__textarea"
          data-testid="chat-input-textarea"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder="给团队下达指令…  输入 @ 点名某个 agent"
          onChange={handleChange}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {cancelSlot}
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
      </div>
      <div className="composer-hint">
        <span>
          <b>Enter</b> 发送 · <b>Shift+Enter</b> 换行
        </span>
        <span style={{ marginLeft: 'auto' }}>@claude 架构 · @codex 评审 · @gemini 设计</span>
      </div>
    </div>
  );
}
