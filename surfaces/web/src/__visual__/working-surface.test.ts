import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

interface CdpSession {
  readonly port: number;
  command(method: string, params?: Record<string, unknown>): Promise<any>;
}

let session: CdpSession | undefined;
let browser: ChildProcess | undefined;
let socket: WebSocket | undefined;
let server: ViteDevServer | undefined;
let profile: string | undefined;

beforeAll(async () => {
  const chrome =
    process.env.CHROME_BIN ??
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].find(existsSync);
  if (!chrome) throw new Error("Visual approval needs Chromium: set CHROME_BIN to the browser executable");

  profile = mkdtempSync(join(tmpdir(), "harness-web-visual-"));
  server = await createServer({ appType: "custom", server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  server.middlewares.use("/visual-approval", (request, response) => {
    const reqUrl = new URL(request.url ?? "/visual-approval", "http://127.0.0.1");
    const scene = reqUrl.searchParams.get("scene") ?? "";
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><style>#result{display:none}</style><div id="app"></div><pre id="result" data-scene="${scene.replaceAll('"', "&quot;")}"></pre>`,
    );
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (typeof address !== "object" || address === null) throw new Error("visual server has no address");

  browser = spawn(
    chrome,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const debugPort = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not expose its debugging endpoint")), 15_000);
    browser!.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    browser!.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
      const endpointPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
      if (endpointPort) {
        clearTimeout(timer);
        resolve(endpointPort);
      }
    });
  });

  const pages = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json())) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  socket = new WebSocket(pages.find((page) => page.type === "page")!.webSocketDebuggerUrl);
  const connection = socket;
  await new Promise<void>((resolve, reject) => {
    connection.addEventListener("open", () => resolve());
    connection.onerror = reject;
  });

  let next = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  connection.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      connection.send(JSON.stringify({ id, method, params }));
    });
  await command("Page.enable");
  session = { port: address.port, command };
});

afterAll(async () => {
  socket?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise<void>((resolve) => browser!.once("exit", () => resolve()));
    browser.kill("SIGTERM");
    await exited;
  }
  await server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

async function renderedApproval(scene: string, narrow: boolean) {
  if (!session) throw new Error("Visual test browser session was not initialized");
  const { port, command } = session;
  const url = `http://127.0.0.1:${port}/visual-approval?scene=${scene}`;

  // CLI window-size has a 500px layout minimum; CDP sets the actual narrow viewport.
  await command("Emulation.setDeviceMetricsOverride", {
    width: narrow ? 390 : 1280,
    height: narrow ? 844 : 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await command("Page.navigate", { url });
  const until = Date.now() + 30_000;
  let started = false;
  while (Date.now() < until) {
    const state = (
      await command("Runtime.evaluate", {
        expression: `(() => {
          const r = document.querySelector("#result");
          if (!r || r.getAttribute("data-scene") !== ${JSON.stringify(scene)}) return null;
          const clickRaw = document.documentElement.dataset.cdpClick ?? null;
          if (clickRaw) delete document.documentElement.dataset.cdpClick;
          return { text: r.textContent ?? "", clickRaw };
        })()`,
        returnByValue: true,
      })
    ).result.value as { text: string; clickRaw: string | null } | null;

    if (state?.clickRaw) {
      const { x, y } = JSON.parse(state.clickRaw) as { x: number; y: number };
      await command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await command("Runtime.evaluate", { expression: 'document.documentElement.dataset.cdpClickDone = "1"' });
      continue;
    }

    if (state?.text) {
      const directory = process.env.HARNESS_VISUAL_SCREENSHOTS;
      if (directory) {
        const screenshot = await command("Page.captureScreenshot", { format: "png" });
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${scene}.png`), Buffer.from(screenshot.data, "base64"));
      }
      return JSON.parse(state.text) as { frame?: unknown; error?: string };
    }

    if (state && !started) {
      started = true;
      // Trusted keyboard input establishes :focus-visible modality before programmatic focus checks.
      await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await command("Runtime.evaluate", { expression: 'import("/src/__visual__/working-surface.tsx")' });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Browser did not finish visual approval for ${scene}`);
}

it.each([
  "composer",
  "permissions",
  "permissions-narrow",
  "transcript",
  "approval",
  "native-popover",
  "fallback-popover",
  "design-system",
  "design-system-light",
  "activity",
  "activity-narrow",
  "agent-activity",
  "agent-activity-narrow",
])("approves rendered %s appearance and keyboard focus in Chromium", async (scene) => {
  const approval = await renderedApproval(
    scene,
    scene === "native-popover" || scene.startsWith("fallback-") || scene.endsWith("-narrow"),
  );
  if (approval.error) throw new Error(approval.error);
  expect(approval.frame).toMatchSnapshot();
});
