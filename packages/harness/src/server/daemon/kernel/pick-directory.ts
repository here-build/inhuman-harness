import { execFile, spawn } from "node:child_process";

export type DirectoryPicker = (signal?: AbortSignal) => Promise<string | null>;

const PROMPT = "Select a project folder";
const READY_MARKER = "__HARNESS_PICKER_READY__\n";

/**
 * macOS Powerbox (`NSOpenPanel`) script via JXA.
 *
 * Pre-initializes `NSApplication` (as an accessory process with no Dock icon or menu bar)
 * and `NSOpenPanel.openPanel` (which warms the `com.apple.appkit.xpc.openAndSavePanelService`
 * XPC session), prints `READY_MARKER`, and blocks on `stdin`.
 * - If `stdin` closes with EOF (0 bytes), the helper exits immediately without showing any UI.
 * - When `"1\n"` is written to `stdin`, it activates and presents the modal folder sheet in ~6ms.
 */
const DARWIN_JXA_SCRIPT = [
  'ObjC.import("AppKit");',
  'ObjC.import("Foundation");',
  'ObjC.import("stdlib");',
  "const app = $.NSApplication.sharedApplication;",
  "app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);",
  "const panel = $.NSOpenPanel.openPanel;",
  `panel.title = ${JSON.stringify(PROMPT)};`,
  `panel.message = ${JSON.stringify(PROMPT)};`,
  'panel.prompt = "Select";',
  "panel.canChooseFiles = false;",
  "panel.canChooseDirectories = true;",
  "panel.canCreateDirectories = true;",
  "panel.allowsMultipleSelection = false;",
  `$.NSFileHandle.fileHandleWithStandardOutput.writeData($(${JSON.stringify(READY_MARKER)}).dataUsingEncoding($.NSUTF8StringEncoding));`,
  "const trigger = $.NSFileHandle.fileHandleWithStandardInput.availableData;",
  "const cmd = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(trigger, $.NSUTF8StringEncoding));",
  "if (!cmd || cmd.length === 0) $.exit(0);",
  "app.activateIgnoringOtherApps(true);",
  'panel.runModal === $.NSModalResponseOK ? ObjC.unwrap(panel.URL.path) : "";',
].join(" ");

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly enoent: boolean;
};

type WarmDarwinPicker = {
  readonly isAlive: () => boolean;
  readonly trigger: (signal?: AbortSignal) => Promise<CommandResult | null>;
  readonly dispose: () => void;
};

let warmDarwin: WarmDarwinPicker | null = null;

function stripReadyMarker(raw: string): string {
  const index = raw.indexOf(READY_MARKER);
  return index === -1 ? raw : raw.slice(index + READY_MARKER.length);
}

function spawnDarwinPicker(): WarmDarwinPicker {
  const child = spawn("osascript", ["-l", "JavaScript", "-e", DARWIN_JXA_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.unref();

  let stdout = "";
  let stderr = "";
  let exited = false;
  let claimed = false;
  let enoent = false;

  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  const done = new Promise<CommandResult>((resolve) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(READY_MARKER)) resolveReady(true);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      exited = true;
      if (error.code === "ENOENT") enoent = true;
      stderr = stderr || error.message;
      resolveReady(false);
      if (!claimed && warmDarwin === handle) warmDarwin = null;
      resolve({ code: enoent ? 127 : 1, stdout: stripReadyMarker(stdout), stderr, enoent });
    });
    child.on("close", (code) => {
      exited = true;
      resolveReady(false);
      if (!claimed && warmDarwin === handle) warmDarwin = null;
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout: stripReadyMarker(stdout),
        stderr,
        enoent,
      });
    });
  });

  const dispose = (): void => {
    if (warmDarwin === handle) warmDarwin = null;
    if (exited) return;
    try {
      child.stdin?.end();
    } catch {
      // Ignore broken pipe on teardown.
    }
    child.kill();
  };

  const handle: WarmDarwinPicker = {
    isAlive: () => !exited && !claimed,
    dispose,
    trigger: async (signal?: AbortSignal): Promise<CommandResult | null> => {
      if (claimed || exited) return null;
      claimed = true;
      if (warmDarwin === handle) warmDarwin = null;

      const isReady = await ready;
      if (!isReady || exited || child.stdin == null || child.stdin.destroyed) {
        dispose();
        return null;
      }
      if (signal?.aborted) {
        dispose();
        return { code: 1, stdout: "", stderr: "aborted", enoent: false };
      }

      child.ref();
      const onAbort = (): void => {
        dispose();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdin.end("1\n");
        return await done;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };

  return handle;
}

/**
 * Pre-warms the macOS Powerbox (`NSOpenPanel`) helper in the background so that
 * when the user clicks "Add", the native folder sheet appears immediately (~6ms)
 * without waiting on `WindowServer` / `openAndSavePanelService` XPC cold-start.
 */
export function warmNativeDirectoryPicker(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") return;
  if (warmDarwin != null && warmDarwin.isAlive()) return;
  warmDarwin = spawnDarwinPicker();
}

export function disposeNativeDirectoryPicker(): void {
  if (warmDarwin != null) {
    const held = warmDarwin;
    warmDarwin = null;
    held.dispose();
  }
}

function normalizePickedPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed === "/" || /^[A-Za-z]:\\?$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[/\\]+$/, "");
}

function runCommand(
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { signal, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout, stderr, enoent: false });
        return;
      }
      const err = error as NodeJS.ErrnoException & { code?: number | string };
      if (err.code === "ENOENT") {
        resolve({ code: 127, stdout: stdout ?? "", stderr: stderr ?? "", enoent: true });
        return;
      }
      const exitCode = typeof err.code === "number" ? err.code : 1;
      resolve({ code: exitCode, stdout: stdout ?? "", stderr: stderr ?? error.message, enoent: false });
    });
  });
}

/**
 * Spawns the host OS native folder chooser dialog and returns the selected directory's path,
 * or `null` when the user cancels the dialog.
 */
export async function pickNativeDirectory(
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (signal?.aborted) return null;

  if (platform === "darwin") {
    let candidate = warmDarwin;
    warmDarwin = null;
    let res = candidate != null ? await candidate.trigger(signal) : null;
    if (res == null && !signal?.aborted) {
      res = await spawnDarwinPicker().trigger(signal);
    }
    if (!signal?.aborted && !process.env["VITEST"]) {
      warmNativeDirectoryPicker(platform);
    }
    if (res == null || signal?.aborted) return null;
    if (res.code === 0) return normalizePickedPath(res.stdout);
    if (res.stderr.includes("-128") || /user cancel/i.test(res.stderr)) return null;
    throw new Error(res.stderr.trim() || "Could not open the macOS folder picker.");
  }

  if (platform === "linux") {
    const zenity = await runCommand(
      "zenity",
      ["--file-selection", "--directory", `--title=${PROMPT}`],
      signal,
    );
    if (signal?.aborted) return null;
    if (!zenity.enoent) {
      if (zenity.code === 0) return normalizePickedPath(zenity.stdout);
      if (zenity.code === 1 || zenity.code === 5) return null;
      throw new Error(zenity.stderr.trim() || "Could not open the folder picker.");
    }
    const kdialog = await runCommand(
      "kdialog",
      ["--getexistingdirectory", ".", "--title", PROMPT],
      signal,
    );
    if (signal?.aborted) return null;
    if (!kdialog.enoent) {
      if (kdialog.code === 0) return normalizePickedPath(kdialog.stdout);
      if (kdialog.code === 1) return null;
      throw new Error(kdialog.stderr.trim() || "Could not open the folder picker.");
    }
    throw new Error("No native folder picker found (install zenity or kdialog).");
  }

  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog;",
      `$f.Description = '${PROMPT}';`,
      "$f.ShowNewFolderButton = $true;",
      "if ($f.ShowDialog() -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }",
    ].join(" ");
    const res = await runCommand("powershell", ["-NoProfile", "-Sta", "-Command", script], signal);
    if (signal?.aborted) return null;
    if (res.code === 0) return normalizePickedPath(res.stdout);
    throw new Error(res.stderr.trim() || "Could not open the Windows folder picker.");
  }

  throw new Error(`Native folder picker is not supported on ${platform}.`);
}
