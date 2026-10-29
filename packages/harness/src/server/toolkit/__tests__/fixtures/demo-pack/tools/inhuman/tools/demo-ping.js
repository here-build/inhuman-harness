import { InhumanTool, z } from "@inhuman.tools/plugin-sdk";

export default new InhumanTool({
  name: "demo_ping",
  class: "read",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  run: () => ({ ok: true }),
});
