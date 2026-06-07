// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownText } from '../../packages/web/src/components/MarkdownText.js';

describe('MarkdownText', () => {
  it('renders headers (h1–h6)', () => {
    const { container } = render(<MarkdownText text="## Section Title" />);
    const h2 = container.querySelector('h2');
    expect(h2).not.toBeNull();
    expect(h2!.textContent).toBe('Section Title');
  });

  it('renders GFM tables', () => {
    const md = [
      '| Name | Value |',
      '|------|-------|',
      '| A    | 1     |',
      '| B    | 2     |',
    ].join('\n');
    const { container } = render(<MarkdownText text={md} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const rows = container.querySelectorAll('tr');
    expect(rows.length).toBe(3); // header + 2 data rows
    const cells = container.querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toBe('A');
  });

  it('renders links with target=_blank', () => {
    const { container } = render(
      <MarkdownText text="Visit [Google](https://google.com) now" />,
    );
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://google.com');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.textContent).toBe('Google');
  });

  it('renders horizontal rules', () => {
    const md = 'above\n\n---\n\nbelow';
    const { container } = render(<MarkdownText text={md} />);
    const hr = container.querySelector('hr');
    expect(hr).not.toBeNull();
  });

  it('renders blockquotes', () => {
    const { container } = render(<MarkdownText text="> Important note" />);
    const bq = container.querySelector('blockquote');
    expect(bq).not.toBeNull();
    expect(bq!.textContent).toContain('Important note');
  });

  it('renders fenced code blocks with language', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const { container } = render(<MarkdownText text={md} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    const code = pre!.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain('const x = 1;');
  });

  it('renders inline code', () => {
    const { container } = render(<MarkdownText text="Use `console.log` here" />);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('console.log');
  });

  it('renders bold and italic', () => {
    const { container } = render(
      <MarkdownText text="**bold** and *italic*" />,
    );
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('bold');
    const em = container.querySelector('em');
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe('italic');
  });

  it('renders unordered and ordered lists', () => {
    const md = '- item a\n- item b\n\n1. first\n2. second';
    const { container } = render(<MarkdownText text={md} />);
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
  });

  it('renders strikethrough (GFM)', () => {
    const { container } = render(<MarkdownText text="~~deleted~~" />);
    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe('deleted');
  });

  it('renders task lists (GFM)', () => {
    const md = '- [ ] todo\n- [x] done';
    const { container } = render(<MarkdownText text={md} />);
    const inputs = container.querySelectorAll('input[type="checkbox"]');
    expect(inputs.length).toBe(2);
  });

  it('returns empty fragment for empty text', () => {
    const { container } = render(<MarkdownText text="" />);
    expect(container.innerHTML).toBe('');
  });
});
