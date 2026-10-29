/**
 * A bot thread runs in the kernel's default permission mode. The user (and only the user: a bot
 * definition cannot) may pin a mode per bot with `authorization.botModes` in `config.json`.
 */
import { type KernelRoot, parseAuthorizationConfig, type PermissionMode } from "@inhuman.tools/harness-model";

export function botPermissionMode(
  kernel: Pick<KernelRoot, "authorizationJson" | "defaultPermissionMode">,
  bot: string,
): PermissionMode {
  const parsed = parseAuthorizationConfig(kernel.authorizationJson);
  const pinned = parsed.ok ? parsed.config.botModes?.[bot] : undefined;
  return pinned ?? kernel.defaultPermissionMode;
}
