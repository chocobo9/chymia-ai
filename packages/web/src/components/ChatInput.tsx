// M9 ChatInput — message composer with @mention autocomplete against the agent
// roster (agent store). When the user types "@" followed by a partial token, we
// surface matching mention patterns (e.g. "@claude", "@codex") from each agent's
// configured mentionPatterns; picking one completes the token in place.

import { useMemo, useRef, useState, type ReactElement, type ChangeEvent } from 'react';
import { useAgentStore } from '../stores/agent-store.js';

/** A single autocomplete candidate. */
export interface MentionSuggestion {
  readonly agentId: string;
  readonly displayName: string;
  readonly pattern: string;
}

/** Matches the @token currently being typed at the caret-end of the text. */
const ACTIVE_MENTION = /(^|\s)@([^\s@]*)$/;

export interface ChatInputProps {
  /** Send the composed message (container forwards to the API). */
  readonly onSend: (content: string) => void;
  /** Disable input while a turn is in flight (optional). */
  readonly disabled?: boolean;
}

/** Build the full suggestion list from the roster's mentionPatterns. */
function buildSuggestions(
  roster: ReturnType<typeof useAgentStore.getState>['roster'],
): readonly MentionSuggestion[] {
  return roster.flatMap((agent) =>
    agent.mentionPatterns.map((pattern) => ({
      agentId: agent.id,
      displayName: agent.displayName,
      pattern,
    })),
  );
}

/** Extract the partial "@..." token at the end of `value`, if any. */
function activeMentionToken(value: string): string | null {
  const match = ACTIVE_MENTION.exec(value);
  return match === null ? null : match[2];
}

/** Render the message composer with @mention autocomplete. */
export function ChatInput(props: ChatInputProps): ReactElement {
  const { onSend, disabled = false } = props;
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
    setValue((current) => current.replace(ACTIVE_MENTION, (_full, lead: string) => `${lead}${pattern} `));
    textareaRef.current?.focus();
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend(trimmed);
    setValue('');
  };

  return (
    <div className="chat-input" data-testid="chat-input">
      {suggestions.length > 0 && (
        <ul className="chat-input__suggestions" data-testid="mention-suggestions" role="listbox">
          {suggestions.map((s) => (
            <li key={`${s.agentId}:${s.pattern}`} role="option" aria-selected="false">
              <button
                type="button"
                className="chat-input__suggestion"
                data-testid="mention-suggestion"
                data-pattern={s.pattern}
                onClick={() => applySuggestion(s.pattern)}
              >
                <span className="chat-input__suggestion-pattern">{s.pattern}</span>
                <span className="chat-input__suggestion-name">{s.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="chat-input__row">
        <textarea
          ref={textareaRef}
          className="chat-input__textarea"
          data-testid="chat-input-textarea"
          value={value}
          disabled={disabled}
          placeholder="输入消息，用 @ 召唤 agent（如 @claude 写代码）"
          onChange={handleChange}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="chat-input__send"
          data-testid="chat-send-button"
          disabled={disabled || value.trim().length === 0}
          onClick={submit}
        >
          发送
        </button>
      </div>
    </div>
  );
}
