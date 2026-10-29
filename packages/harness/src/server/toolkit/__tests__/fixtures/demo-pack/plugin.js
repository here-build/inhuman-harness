import { InhumanPlugin, InhumanTool, z } from "@inhuman.tools/plugin-sdk";

export default new InhumanPlugin({
  tools: [
    new InhumanTool({
      name: "demo_ping",
      description: "demo ping",
      class: "read",
      question: "ping?",
      effect: "pinged",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    }),
  ],
});
