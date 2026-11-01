import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessDaemon } from "@inhuman.tools/harness/testkit";
import { onTestFinished } from "vitest";

export async function openWorld(): Promise<{
  readonly kernel: string;
  readonly workspace: string;
  readonly daemon: HarnessDaemon;
}> {
  const kernel = await mkdtemp(join(tmpdir(), "harness-eval-cli-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-eval-cli-p-"));
  onTestFinished(async () => {
    await rm(kernel, { recursive: true, force: true, maxRetries: 10 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 10 });
  });
  await writeFile(join(kernel, "config.json"), JSON.stringify({ connections: {} }));
  const daemon = new HarnessDaemon(kernel);
  await daemon.listen();
  onTestFinished(async () => {
    await daemon[Symbol.asyncDispose]();
  });
  return { kernel, workspace, daemon };
}
