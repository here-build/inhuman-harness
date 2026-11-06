import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";

import { CodeView } from "./code-view.js";

// A turn re-renders all of its beats when any one cell changes. Same text must not be parsed again.
export const Markdown = memo(function MarkdownView({ text }: { readonly text: string }) {
  return (
    <div className="prose prose-wrap">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          code: ({ children }) => <code>{children}</code>,
        }}
      >
        {remend(text)}
      </ReactMarkdown>
    </div>
  );
});

// The Markdown pre node, not a language class, identifies a code block.
function CodeBlock({ children }: { readonly children?: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
  const text = String(code?.children ?? "").replace(/\n$/, "");
  const lang = /language-(\S+)/.exec(code?.className ?? "")?.[1];
  return <CodeView guess={lang === undefined} lang={lang ?? "text"} text={text} />;
}
