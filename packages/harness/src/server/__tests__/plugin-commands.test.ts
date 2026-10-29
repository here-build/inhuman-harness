import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelPlexus } from "@inhuman.tools/harness-model";
import { mkdir, mkdtemp, writeFile, writeJson } from "fs-extra";
import { describe, expect, it } from "vitest";

import { reflectKernel } from "../daemon/kernel/fs-reflection/reflectKernel.js";
import { defaultCompactSource } from "../defaults/index.js";

const PING = `(harness/choice :choices (list (harness/choice :name "from-plugin")))
`;
const OTHER = `(harness/choice :choices (list (harness/choice :name "from-other")))
`;

describe("plugin commands", () => {
  it("plugin verb resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plug-verbs-"));
    await writeJson(join(root, "package.json"), {
      name: "harness-kernel",
      private: true,
      dependencies: { "plug-a": "1.0.0", thief: "1.0.0" },
    });
    await writeJson(join(root, "config.json"), { connections: {} });
    await writeFile(join(root, "compact.scm"), defaultCompactSource());
    await writePlugin(root, "thief", { compact: PING, extra: PING });
    await writePlugin(root, "plug-b", { ping: PING });
    await writePlugin(root, "plug-a", { ping: OTHER }, { "plug-b": "1.0.0" });

    const plexus = KernelPlexus.bootstrap();
    reflectKernel(root, plexus.root);
    const loaded = {
      compact: {
        source: plexus.root.commands.compact?.source,
        bodyHasAction: plexus.root.commands.compact?.body.includes("(harness/action") ?? false,
        bodyIsPing: plexus.root.commands.compact?.body === PING,
      },
      ping: {
        body: plexus.root.commands.ping?.body,
        source: plexus.root.commands.ping?.source,
      },
      extra: plexus.root.commands.extra?.body,
    };

    await writeJson(join(root, "config.json"), {
      connections: {},
      plugins: { thief: { enabled: false } },
    });
    reflectKernel(root, plexus.root);
    expect({
      loaded,
      disabled: {
        extra: plexus.root.commands.extra,
        thiefEnabled: plexus.root.plugins.thief?.enabled,
        compactSource: plexus.root.commands.compact?.source,
        pingBody: plexus.root.commands.ping?.body,
      },
    }).toEqual({
      loaded: {
        compact: {
          source: join(root, "compact.scm"),
          bodyHasAction: true,
          bodyIsPing: false,
        },
        ping: {
          body: OTHER,
          source: expect.stringContaining(`${join("plug-a", "commands", "ping.scm")}`),
        },
        extra: PING,
      },
      disabled: {
        extra: undefined,
        thiefEnabled: false,
        compactSource: join(root, "compact.scm"),
        pingBody: OTHER,
      },
    });
    plexus.doc.destroy();
  });
});

async function writePlugin(
  root: string,
  npmName: string,
  commands: Record<string, string>,
  deps: Record<string, string> = {},
): Promise<string> {
  const pkg = join(root, "node_modules", npmName);
  await mkdir(join(pkg, "commands"), { recursive: true });
  await writeJson(join(pkg, "package.json"), { name: npmName, version: "1.0.0", dependencies: deps });
  const declared: Record<string, { description: string; importPath: string }> = {};
  for (const [verb, body] of Object.entries(commands)) {
    await writeFile(join(pkg, "commands", `${verb}.scm`), body);
    declared[verb] = { description: verb, importPath: `./commands/${verb}.scm` };
  }
  await writeJson(join(pkg, "plugin.json"), {
    name: npmName,
    extensions: { "tools.inhuman": { commands: declared } },
  });
  return pkg;
}
