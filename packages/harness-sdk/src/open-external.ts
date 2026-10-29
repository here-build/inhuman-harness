/**
 * Fire-and-forget URL open. No display (SSH / container) is fine.
 * WIN_START: cmd.exe `start "" url` — without the empty title the quoted
 * URL becomes the window title and navigation is swallowed.
 */
import { spawn } from "node:child_process";

export function openExternalUrl(url: string): void {
  if (!/^https?:\/\//i.test(url.trim())) return;
  try {
    const target = url.trim();
    if (process.platform === "darwin") {
      spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}
