// @vitest-environment jsdom
// QA gate — per-thread draft preservation in ChatInput. When the user types
// text, switches threads, and switches back, the draft must be restored.
// Sending clears the draft for the active thread.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ChatInput } from '@choco/web/components/ChatInput';

function textarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('[data-testid="chat-input-textarea"]') as HTMLTextAreaElement;
}

describe('ChatInput per-thread draft preservation', () => {
  it('restores the draft when switching back to a previous thread', () => {
    const onSend = vi.fn();
    const { rerender, container } = render(
      <ChatInput onSend={onSend} threadId="thread-a" />,
    );

    // Type in thread A
    fireEvent.change(textarea(container), { target: { value: 'hello from A' } });
    expect(textarea(container).value).toBe('hello from A');

    // Switch to thread B
    rerender(<ChatInput onSend={onSend} threadId="thread-b" />);
    expect(textarea(container).value).toBe('');

    // Type in thread B
    fireEvent.change(textarea(container), { target: { value: 'hello from B' } });

    // Switch back to thread A — draft restored
    rerender(<ChatInput onSend={onSend} threadId="thread-a" />);
    expect(textarea(container).value).toBe('hello from A');

    // Switch back to B — draft restored
    rerender(<ChatInput onSend={onSend} threadId="thread-b" />);
    expect(textarea(container).value).toBe('hello from B');
  });

  it('clears the draft for the active thread on send', () => {
    const onSend = vi.fn();
    const { rerender, container } = render(
      <ChatInput onSend={onSend} threadId="thread-a" />,
    );

    fireEvent.change(textarea(container), { target: { value: 'msg' } });
    // Send (Enter)
    fireEvent.keyDown(textarea(container), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea(container).value).toBe('');

    // Switch away and back — draft should be empty (was cleared on send)
    rerender(<ChatInput onSend={onSend} threadId="thread-b" />);
    rerender(<ChatInput onSend={onSend} threadId="thread-a" />);
    expect(textarea(container).value).toBe('');
  });

  it('starts empty when threadId is undefined', () => {
    const onSend = vi.fn();
    const { container } = render(
      <ChatInput onSend={onSend} />,
    );
    expect(textarea(container).value).toBe('');
  });
});
