/**
 * The real chain, in a temp directory: `wrangler dev` (the relay) and a daemon
 * with its own kernel root. Nothing is written inside the repo tree except
 * wrangler's own gitignored `.wrangler/tmp` bundle.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_SECRET = "e2e-dev-secret";
export const OWNER = { sub: "user_owner", email: "owner@example.com" };
export const STRANGER = { sub: "user_stranger", email: "stranger@example.com" };

const relayRoot = fileURLToPath(new URL("..", import.meta.url));
const bootJs = fileURLToPath(new URL("../../harness/dist/server/boot.js", import.meta.url));
export const webClientDir = fileURLToPath(new URL("../../harness-web-app/dist/client", import.meta.url));

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until it returns something other than undefined/false. */
export async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await sleep(50);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** A child process with captured output and a teardown that kills its whole group. */
export class Proc {
  output = "";
  readonly child: ChildProcess;
  readonly exited: Promise<void>;

  constructor(label: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const take = (chunk: Buffer): void => {
      this.output = `${this.output}${chunk.toString()}`.slice(-20_000);
    };
    this.child.stdout?.on("data", take);
    this.child.stderr?.on("data", take);
    this.exited = new Promise((resolve) => this.child.once("exit", () => resolve()));
    this.child.once("error", (error) => {
      this.output += `\n[${label}] spawn error: ${String(error)}`;
    });
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  async stop(): Promise<void> {
    if (!this.alive || this.child.pid === undefined) return;
    const group = -this.child.pid;
    for (const [signal, ms] of [
      ["SIGTERM", 5_000],
      ["SIGKILL", 5_000],
    ] as const) {
      try {
        process.kill(group, signal);
      } catch {
        return;
      }
      await Promise.race([this.exited, sleep(ms)]);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `exited` ran the getter's state change
      if (!this.alive) return;
    }
  }
}

export type Stack = {
  readonly base: string;
  readonly port: number;
  readonly dir: string;
  readonly kernel: string;
  /** A project directory with files; registered with the kernel once a session opens in it. */
  readonly project: string;
  readonly daemonToken: string;
  daemon: Proc | null;
  startDaemon(): Promise<void>;
  stopDaemon(): Promise<void>;
  stop(): Promise<void>;
  logs(): string;
};

export async function startStack(): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-e2e-")));
  const kernel = join(dir, "kernel");
  const project = join(dir, "project");
  const home = join(dir, "home");
  for (const path of [kernel, project, home]) mkdirSync(path);
  writeFileSync(join(project, "hello.txt"), "hello from the project\n");
  writeFileSync(join(dir, "outside.txt"), "not in a project\n");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // Dummy secrets in a temp env file; wrangler reads it with --env-file, so the package's own .dev.vars is never touched.
  const envFile = join(dir, "relay.env");
  writeFileSync(
    envFile,
    [
      `DEV_AUTH_TOKEN=${DEV_SECRET}`,
      `ALLOWED_EMAILS=${OWNER.email},${STRANGER.email}`,
      "WORKOS_COOKIE_PASSWORD=e2e-cookie-password-0123456789abcdef",
      "WORKOS_CLIENT_ID=client_e2e_dummy",
      "WORKOS_API_KEY=sk_e2e_dummy",
      // Short grace so the offline scenarios do not wait a minute.
      "CONTROL_GRACE_MS=2000",
      "",
    ].join("\n"),
  );

  const stack: Stack = {
    base,
    port,
    dir,
    kernel,
    project,
    daemonToken: `dev.${DEV_SECRET}.${OWNER.sub}.${OWNER.email}`,
    daemon: null,
    async startDaemon() {
      if (stack.daemon?.alive) throw new Error("daemon already running");
      const daemon = new Proc("daemon", process.execPath, [bootJs], {
        cwd: kernel,
        env: {
          ...process.env,
          HOME: home,
          DEBUG: "*",
          HARNESS_LOG: join(dir, "daemon.log"),
          HARNESS_REMOTE_URL: base,
          HARNESS_REMOTE_DEV_TOKEN: stack.daemonToken,
          HARNESS_WEB_STATIC_DIR: webClientDir,
        },
      });
      stack.daemon = daemon;
      await until(
        "daemon socket",
        () => /daemon ready/.test(readLog()) || (!daemon.alive ? fail(daemon) : undefined),
        60_000,
      );
    },
    async stopDaemon() {
      await stack.daemon?.stop();
    },
    async stop() {
      await Promise.allSettled([stack.daemon?.stop(), relay.stop()]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
    logs: () => `--- relay ---\n${relay.output}\n--- daemon ---\n${stack.daemon?.output ?? ""}\n${readLog()}`,
  };
  const readLog = (): string => {
    try {
      return readFileSync(join(dir, "daemon.log"), "utf8");
    } catch {
      return "";
    }
  };
  const fail = (daemon: Proc): never => {
    throw new Error(`daemon exited early\n${daemon.output}\n${readLog()}`);
  };

  const relay = new Proc(
    "relay",
    join(relayRoot, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--env-file",
      envFile,
      "--persist-to",
      join(dir, "wrangler-state"),
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    { cwd: relayRoot, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" } },
  );
  const onExit = (): void => {
    for (const proc of [relay, stack.daemon]) {
      if (proc?.alive && proc.child.pid !== undefined) {
        try {
          process.kill(-proc.child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  };
  process.once("exit", onExit);
  try {
    await until(
      "relay ready",
      async () => {
        if (!relay.alive) throw new Error(`wrangler exited\n${relay.output}`);
        const res = await fetch(`${base}/api/machines`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
        return res !== null && res.status === 401 ? true : undefined;
      },
      90_000,
    );
  } catch (error) {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return stack;
}
