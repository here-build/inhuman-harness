import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "../markdown.js";

const render = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown", () => {
  it("keeps inline code inline, including language-looking text", () => {
    const html = render("Use `language-ts` here.");
    expect(html).toContain("<p>Use <code>language-ts</code> here.</p>");
    expect(html).not.toContain("<pre");
  });

  it.each(["```ts\nconst value = 1;\n```", "```\nconst value = 1;\n```", "    const value = 1;"])(
    "renders one readable pre for a code block: %s",
    (text) => {
      const html = render(text);
      expect(html.match(/<pre\b/g)).toHaveLength(1);
      expect(html).toContain('<pre class="mono"><code>const value = 1;</code></pre>');
      expect(html).not.toContain("<pre><pre");
    },
  );

  it("keeps code readable and escaped before the highlighter loads", () => {
    const html = render("```unknown-language\n<script>alert('no')</script>\n```");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<code>");
  });

  it("heals an unfinished fence without putting code into a paragraph", () => {
    const html = render("```tsx\nconst view = <div />;");
    expect(html.match(/<pre\b/g)).toHaveLength(1);
    expect(html).toContain("&lt;div /&gt;");
  });

  it("preserves prose semantics and GFM tables and task lists", () => {
    const html = render(
      "## Notes\n\n- one\n- two\n\n> quoted\n\n| Name | Result |\n| --- | --- |\n| test | pass |\n\n- [x] done",
    );
    expect(html).toContain("<h2>Notes</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('class="task-list-item"');
  });

  it("does not execute raw HTML or unsafe links", () => {
    const html = render("<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });
});
