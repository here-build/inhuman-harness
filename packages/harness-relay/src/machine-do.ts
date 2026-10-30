import { DurableObject } from "cloudflare:workers";

import { userStub } from "./stubs.js";

interface ControlAttachment {
  sub: string;
  machineId: string;
}

/**
 * One per (sub, machineId). Phase 2a: accepts the daemon control socket and reports presence.
 * Rooms, RPC routing and the HTTP tunnel arrive in phase 2b/2c. Documents never touch storage.
 */
export class MachineDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const role = req.headers.get("x-relay-role");
    const sub = req.headers.get("x-relay-sub");
    const machineId = req.headers.get("x-relay-machine");
    const path = new URL(req.url).pathname;
    if (role === "daemon" && path.endsWith("/control") && sub && machineId) {
      return this.acceptControl(req, { sub, machineId });
    }
    return new Response("not implemented", { status: 501 });
  }

  private async acceptControl(req: Request, att: ControlAttachment): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // A reconnecting daemon supersedes its stale socket.
    for (const old of this.ctx.getWebSockets("control")) old.close(1012, "replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["control"]);
    pair[1].serializeAttachment(att);
    await userStub(this.env, att.sub).setOnline(att.machineId, true);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.markOffline(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.markOffline(ws);
  }

  private async markOffline(closing: WebSocket): Promise<void> {
    const att = closing.deserializeAttachment() as ControlAttachment | null;
    if (!att) return;
    // Another live control socket means the daemon already reconnected.
    if (this.ctx.getWebSockets("control").some((w) => w !== closing && w.readyState === WebSocket.OPEN)) return;
    await userStub(this.env, att.sub).setOnline(att.machineId, false);
  }
}
