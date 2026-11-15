import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";

import { CodeBlock } from "./code-block.js";
import { cn } from "../lib/cn.js";

export interface MarkdownBlockProps {
  readonly text: string;
  readonly className?: string;
}

/** Memoized GFM Markdown renderer with incomplete-stream repair and highlighted code fences. */
export const MarkdownBlock = memo(function MarkdownView({ text, className }: MarkdownBlockProps) {
  return (
    <div className={cn("prose prose-wrap", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: FencedCodeBlock,
          code: ({ children }) => <code>{children}</code>,
        }}
      >
        {remend(text)}
      </ReactMarkdown>
    </div>
  );
});

/** Reference shell alias for {@link MarkdownBlock}. */
export const Markdown = MarkdownBlock;

function FencedCodeBlock({ children }: { readonly children?: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
  const text = String(code?.children ?? "").replace(/\n$/, "");
  const lang = /language-(\S+)/.exec(code?.className ?? "")?.[1];
  return <CodeBlock guess={lang === undefined} lang={lang ?? "text"} text={text} />;
}
