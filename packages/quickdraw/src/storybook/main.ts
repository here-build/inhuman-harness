/**
 * Interactive in-terminal storybook.
 *
 *   pnpm --filter @inhuman.tools/quickdraw storybook
 *
 * Same runtime as the product TUI: startRender → Renderer →
 * catalog.snapshot → renderFrame. Catalog chrome and widget demos share
 * that path. No private present loop. The snapshot is a computed; the
 * live timer does not rebuild the shell.
 *
 * Live demand stays on cadence (spinners, birth, bgFx). The catalog source
 * only one-shots the ink hold clock — never a 30fps idle timer.
 */

import process from "node:process";

import { createPaintLocal, processStdioInput, processStdioOutput, startRender, type RenderHandle } from "../index.js";
import { createCatalogController } from "./catalog-source.js";

async function main(): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error("quickdraw storybook: need a TTY");
    process.exit(1);
  }

  const catalog = createCatalogController();
  const paintLocal = createPaintLocal(process.stdout.columns || 80, process.stdout.rows || 24);
  let session: RenderHandle | undefined;
  let exiting = false;

  const quit = (code = 0): void => {
    if (exiting) return;
    exiting = true;
    try {
      session?.stop();
      session?.restore();
    } catch {
      /* teardown */
    }
    process.exit(code);
  };

  process.on("SIGINT", () => quit(0));
  process.on("SIGTERM", () => quit(0));
  process.on("uncaughtException", (err) => {
    console.error("[storybook] uncaughtException:", err);
    quit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[storybook] unhandledRejection:", err);
    quit(1);
  });

  session = await startRender({
    stdin: process.stdin,
    stdout: process.stdout,
    input: processStdioInput(process.stdin),
    output: processStdioOutput(process.stdout),
    port: {
      post(message) {
        catalog.handle(message, { onQuit: () => quit(0) });
      },
      onBatch() {
        /* no worker — retained source is the frame */
      },
    },
    paintSource: catalog,
    paintLocal,
    onQuit: () => quit(0),
  });
}

void main();
