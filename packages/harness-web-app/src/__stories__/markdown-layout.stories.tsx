import type { Meta, StoryObj } from "@storybook/react-vite";

import { Markdown } from "../shell/markdown.js";

const meta = {
  title: "Graphic Precision/Markdown alignment",
  component: Markdown,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: "48rem", marginInline: "auto", padding: "2rem 3.5rem" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Hanging: Story = {
  args: {
    text: `The body edge stays steady as the content changes shape.

- List text aligns with the paragraph above, including a second line when the viewport becomes narrow.
- A second item retains the same edge.
  - Nested items remain indented to preserve hierarchy.
    - A third level stays distinct.

98. Ordered markers hang outside the reading column.
99. The numbering can grow without moving the text.
100. Three digits still fit in the conversation gutter.

- [x] A completed task aligns with the body text.
- [ ] An unfinished task can wrap onto another line without returning beneath its checkbox.
  - [x] Nested tasks keep their indentation.

> Quoted text also follows the body edge. Its rule lives in the gutter.
>
> Another paragraph keeps the same alignment.
>
> > Nested quotations remain visibly nested.

| Name | Status |
| :--- | :--- |
| First cell | Aligned with the body |
| Longer content | The table can scroll when necessary |

The paragraph after the table returns to exactly the same edge.`,
  },
};
