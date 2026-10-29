/**
 * Tab/pane identity for `--continue`. Null if the process has no emulator
 * cookie and no mux pane — miss is mint. Outer TERM_SESSION_ID is not
 * identity under tmux: mix every live mux token.
 */

export type EnvBag = Record<string, string | undefined>;

export function termSessionKey(env: EnvBag): string | null {
  const parts: string[] = [];
  const emu = emulatorCookie(env);
  if (emu != null) parts.push(`emu=${emu}`);

  const tmux = tmuxFields(env);
  if (tmux != null) {
    parts.push(`tmux_sock=${tmux.socket}`, `tmux_pid=${tmux.pid}`, `tmux_pane=${tmux.pane}`);
  }
  if (env.ZELLIJ_PANE_ID != null && env.ZELLIJ_PANE_ID !== "") {
    parts.push(`zellij_pane=${env.ZELLIJ_PANE_ID}`);
    if (env.ZELLIJ_SESSION_NAME) parts.push(`zellij_session=${env.ZELLIJ_SESSION_NAME}`);
    if (env.ZELLIJ_SOCKET_DIR) parts.push(`zellij_sock=${env.ZELLIJ_SOCKET_DIR}`);
  }
  if (env.STY != null && env.STY !== "") {
    parts.push(`screen=${env.STY}`, `screen_win=${env.WINDOW === undefined || env.WINDOW === "" ? "0" : env.WINDOW}`);
  }

  return parts.length === 0 ? null : parts.join(";");
}

function emulatorCookie(env: EnvBag): string | null {
  const term = trim(env.TERM_SESSION_ID);
  if (term != null) {
    const colon = term.lastIndexOf(":");
    return colon === -1 ? term : term.slice(colon + 1);
  }
  const wt = trim(env.WT_SESSION);
  if (wt != null) return wt;
  const wezPane = trim(env.WEZTERM_PANE);
  const wezSock = trim(env.WEZTERM_UNIX_SOCKET);
  if (wezPane != null && wezSock != null) return `wez:${wezSock}:${wezPane}`;
  const kittyWin = trim(env.KITTY_WINDOW_ID);
  const kittyPid = trim(env.KITTY_PID);
  if (kittyWin != null && kittyPid != null) return `kitty:${kittyPid}:${kittyWin}`;
  const konsole = trim(env.SHELL_SESSION_ID);
  if (konsole != null) return konsole;
  const gnome = trim(env.GNOME_TERMINAL_SCREEN);
  if (gnome != null) return gnome;
  return null;
}

function tmuxFields(env: EnvBag): { socket: string; pid: string; pane: string } | null {
  const raw = trim(env.TMUX);
  const pane = trim(env.TMUX_PANE);
  if (raw == null || pane == null) return null;
  const last = raw.lastIndexOf(",");
  if (last <= 0) return null;
  const rest = raw.slice(0, last);
  const mid = rest.lastIndexOf(",");
  if (mid <= 0) return null;
  const socket = rest.slice(0, mid);
  const pid = rest.slice(mid + 1);
  if (socket === "" || pid === "") return null;
  return { socket, pid, pane };
}

function trim(value: string | undefined): string | null {
  if (value == null) return null;
  const next = value.trim();
  return next === "" ? null : next;
}
