import { createConnection } from "node:net";

import { expect, test } from "vitest";

import { createControlHost } from "../control.js";

test("control host ready credits: early ready, no reuse, step handshake", async () => {
  await using host = await createControlHost();
  const sock = createConnection({ host: host.host, port: host.port });
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    sock.setEncoding("utf8");

    // Scenario sends ready BEFORE host calls waitReady (the race that hung kitty).
    sock.write(`${JSON.stringify({ type: "ready" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(host.waitReady(2000)).resolves.toBeUndefined();

    await expect(host.waitReady(150)).rejects.toThrow(/timeout/);

    const gotStep = new Promise<string>((resolve) => {
      let carry = "";
      sock.on("data", (chunk: string) => {
        carry += chunk;
        for (const line of carry.split("\n")) {
          if (!line.trim()) continue;
          try {
            const m = JSON.parse(line) as { type: string; name?: string };
            if (m.type === "step" && m.name) resolve(m.name);
          } catch {
            /* ignore */
          }
        }
      });
    });
    await host.send({ type: "step", name: "dirty-row" });
    await expect(gotStep).resolves.toBe("dirty-row");
    sock.write(`${JSON.stringify({ type: "ready" })}\n`);
    await host.waitReady(2000);
  } finally {
    sock.end();
  }
});
