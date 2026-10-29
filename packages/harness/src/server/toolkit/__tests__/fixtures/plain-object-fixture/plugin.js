import { z } from "@inhuman.tools/plugin-sdk";

export default {
  apiVersion: 1,
  tools: [
    {
      type: "function",
      name: "plain_echo",
      class: "read",
      input: z.object({ note: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    },
  ],
};
