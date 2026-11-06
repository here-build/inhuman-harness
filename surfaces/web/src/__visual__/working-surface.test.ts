import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "vite";
import { expect, it } from "vitest";

async function renderedApproval(chrome: string, profile: string, url: string, narrow: boolean) {
  const browser = spawn(
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
  let socket: WebSocket | undefined;
  try {
    const port = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error("Chromium did not expose its debugging endpoint")), 15_000);
      browser.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      browser.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        const endpointPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
        if (endpointPort) {
          clearTimeout(timer);
          resolve(endpointPort);
        }
      });
    });
    const pages = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    socket = new WebSocket(pages.find((page) => page.type === "page")!.webSocketDebuggerUrl);
    const connection = socket;
    await new Promise<void>((resolve, reject) => {
      connection.onopen = () => resolve();
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
    const command = (method: string, params = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        connection.send(JSON.stringify({ id, method, params }));
      });
    await command("Page.enable");
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
      const result = await command("Runtime.evaluate", {
        expression: 'document.querySelector("#result")?.textContent ?? null',
        returnByValue: true,
      });
      const value = result.result.value;
      if (value) return JSON.parse(value) as { frame?: unknown; error?: string };
      if (value === "" && !started) {
        started = true;
        // Trusted keyboard input establishes :focus-visible modality before programmatic focus checks.
        await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await command("Runtime.evaluate", { expression: 'import("/src/__visual__/working-surface.tsx")' });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Browser did not finish visual approval");
  } finally {
    socket?.close();
    if (browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise<void>((resolve) => browser.once("exit", () => resolve()));
      browser.kill("SIGTERM");
      await exited;
    }
  }
}

it.each(["composer", "transcript", "approval", "agent", "fallback-anchors", "fallback-popover"])(
  "approves rendered %s appearance and keyboard focus in Chromium",
  async (scene) => {
    const chrome =
      process.env.CHROME_BIN ??
      [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ].find(existsSync);
    if (!chrome) throw new Error("Visual approval needs Chromium: set CHROME_BIN to the browser executable");
    const profile = mkdtempSync(join(tmpdir(), "harness-web-visual-"));
    const server = await createServer({ appType: "custom", server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
    server.middlewares.use("/visual-approval", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><style>#result{display:none}</style><div id="app"></div><pre id="result"></pre>');
    });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (typeof address !== "object" || address === null) throw new Error("visual server has no address");
      const approval = await renderedApproval(
        chrome,
        profile,
        `http://127.0.0.1:${address.port}/visual-approval?scene=${scene}`,
        scene.startsWith("fallback-"),
      );
      if (approval.error) throw new Error(approval.error);
      expect(approval.frame).toMatchSnapshot();
    } finally {
      await server.close();
      rmSync(profile, { recursive: true, force: true });
    }
  },
);
