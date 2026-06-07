import { type ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

interface MarkdownTextProps {
  readonly text: string;
}

const remarkPlugins = [remarkGfm, remarkBreaks];

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  pre: ({ children }) => <pre className="md-code-block">{children}</pre>,
  input: ({ type, checked }) =>
    type === 'checkbox'
      ? <input type="checkbox" checked={checked} readOnly />
      : <input type={type} />,
};

export function MarkdownText({ text }: MarkdownTextProps): ReactElement {
  if (text.length === 0) return <></>;

  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
