import type { MachineRow } from "./user-do.js";

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function renderPicker(machines: MachineRow[], email?: string): string {
  const rows = machines
    .map(
      (m) => `<li><a href="/m/${encodeURIComponent(m.machineId)}/app/">${esc(m.name)}</a>
  <span class="${m.online ? "on" : "off"}">${m.online ? "online" : "offline"}</span>
  <time datetime="${new Date(m.lastSeen).toISOString()}">${new Date(m.lastSeen).toISOString()}</time></li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness machines</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{max-width:40rem;margin:2rem auto;padding:0 1rem}
li{display:flex;gap:1rem;align-items:baseline;padding:.4rem 0}
.on{color:#1a7f37}.off{color:#888}time{margin-left:auto;font-size:.8rem;opacity:.7}
</style></head><body>
<h1>Machines</h1>
${machines.length === 0 ? "<p>No machines yet. Run <code>inhuman login</code> on one.</p>" : `<ul style="list-style:none;padding:0">${rows}</ul>`}
<form method="post" action="/auth/logout">${email ? `<small>${esc(email)}</small> ` : ""}<button>Sign out</button></form>
</body></html>`;
}
