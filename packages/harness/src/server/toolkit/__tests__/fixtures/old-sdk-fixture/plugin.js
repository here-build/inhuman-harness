import { InhumanPlugin, InhumanTool, z } from "@inhuman.tools/plugin-sdk";

export default new InhumanPlugin({
  tools: [
    new InhumanTool({
      name: "old_ping",
      class: "read",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    }),
  ],
});
