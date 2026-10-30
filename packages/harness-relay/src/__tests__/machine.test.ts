import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { buildDevCredential } from "../auth/dev.js";
import { handle } from "../index.js";
import { machineStub, userStub } from "../stubs.js";
import { DEV_SECRET, ORIGIN, testEnv, uniqueSub } from "./helpers.js";
import { awarenessFrame, Peer, YPeer } from "./peers.js";
import { readAwarenessFrame } from "../sync/awareness.js";
import { MESSAGE_QUERY_AWARENESS } from "../sync/constants.js";
import { decodeServerFrame, encodeChunk, encodeNodeFrame, type ReqFrame } from "../tunnel/protocol.js";
import { TunnelServer } from "../tunnel/server.js";

const OK = "ok@example.com";
const devBearer = (sub: string) => `Bearer ${buildDevCredential(DEV_SECRET, sub, OK)}`;
const devCookie = (sub: string) => `relay_dev=${encodeURIComponent(buildDevCredential(DEV_SECRET, sub, OK))}`;
const upgrade = (path: string, headers: Record<string, string>) =>
  new Request(ORIGIN + path, { headers: { upgrade: "websocket", ...headers } });

const env = testEnv();
let n = 0;
const fresh = () => ({ sub: uniqueSub(), id: `m${Date.now()}-${n++}` });

async function dial(path: string, headers: Record<string, string>): Promise<WebSocket> {
  const res = await handle(upgrade(path, headers), env);
  expect(res.status).toBe(101);
  return res.webSocket!;
}

const control = async (sub: string, id: string) =>
  new Peer(await dial(`/d/${id}/control?name=box`, { authorization: devBearer(sub) }));
const daemonRoom = async (sub: string, id: string, rest: string) =>
  new YPeer(await dial(`/d/${id}/room${rest}`, { authorization: devBearer(sub) }));
const browserRoom = async (sub: string, id: string, rest: string) =>
  new YPeer(await dial(`/m/${id}/room${rest}`, { cookie: devCookie(sub) }));

/** The fake daemon answers every request with its method, under the id it was given. */
function answerRpc(daemon: YPeer, seen: string[] = [], result: (method: string) => unknown = (m) => ({ echo: m })) {
  daemon.handle((f) => {
    if (typeof f !== "string") return false;
    const req = JSON.parse(f) as { id?: string | number; method: string };
    if (req.id === undefined) return false;
    seen.push(String(req.id));
    daemon.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: result(req.method) }));
    return true;
  });
  return seen;
}

const rpc = (id: unknown, method: string) => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
const isOpen = (f: unknown): f is string => typeof f === "string" && f.includes('"t":"open"');

describe("rooms", () => {
  it("opens the room on demand, replays the exact path, and keeps browser writes out of the doc", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const browser = await browserRoom(sub, id, "/session?sessionId=s1&path=%2Fwork");
    const open = JSON.parse(await ctl.take(isOpen, "open frame")) as unknown;
    expect(open).toEqual({ t: "open", room: "/session?sessionId=s1&path=%2Fwork" });

    // The daemon fills the doc; until then the browser is not told it is synced.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(browser.synced).toBe(false);

    // Same room, query in another order.
    const daemon = await daemonRoom(sub, id, "/session?path=%2Fwork&sessionId=s1");
    daemon.doc.getMap("m").set("fromDaemon", 1);
    await browser.until(
      () => browser.synced && browser.doc.getMap("m").get("fromDaemon") === 1,
      "daemon state in browser",
    );
    // Clients write through RPC; a stray browser edit reaches neither the relay doc nor the daemon.
    browser.doc.getMap("m").set("fromBrowser", 2);
    daemon.doc.getMap("m").set("again", 3);
    await browser.until(() => browser.doc.getMap("m").get("again") === 3, "live daemon edit");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(daemon.doc.getMap("m").get("fromBrowser")).toBeUndefined();
    for (const p of [browser, daemon, ctl]) p.close();
  });

  it("does not ask again while the room is open, asks for a second room", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const a = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open kernel");
    const b = await browserRoom(sub, id, "/kernel");
    const c = await browserRoom(sub, id, "/project?path=%2Fp");
    expect(JSON.parse(await ctl.take(isOpen, "open project"))).toEqual({ t: "open", room: "/project?path=%2Fp" });
    expect(ctl.frames.filter(isOpen)).toHaveLength(0);
    for (const p of [a, b, c, ctl]) p.close();
  });

  it("routes RPC by client tag and broadcasts notifications", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const b1 = await browserRoom(sub, id, "/kernel");
    const b2 = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open");
    const daemon = await daemonRoom(sub, id, "/kernel");
    const seen = answerRpc(daemon);
    await b1.until(() => b1.synced, "b1 synced");

    b1.send(rpc(1, "from-b1"));
    b2.send(rpc(1, "from-b2"));
    b2.send(rpc("s", "string-id"));
    expect(await b1.takeJson((j) => j.id === 1, "b1 reply")).toMatchObject({ result: { echo: "from-b1" } });
    expect(await b2.takeJson((j) => j.id === 1, "b2 reply")).toMatchObject({ result: { echo: "from-b2" } });
    expect(await b2.takeJson((j) => j.id === "s", "b2 string reply")).toMatchObject({ result: { echo: "string-id" } });
    expect(b1.frames.filter((f) => typeof f === "string")).toHaveLength(0);
    // The daemon saw distinct, tagged ids.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen.every((s) => /^[\da-f]{12}:/.test(s))).toBe(true);

    // A notification (no id) goes through untouched both ways.
    b1.send(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
    const note = JSON.stringify({ jsonrpc: "2.0", method: "note", params: { n: 1 } });
    daemon.send(note);
    expect(await b1.take((f) => f === note, "b1 notification")).toBe(note);
    expect(await b2.take((f) => f === note, "b2 notification")).toBe(note);

    // Garbage never reaches the daemon.
    b1.send("not json");
    expect(
      await b1.takeJson((j) => (j.error as { code: number } | undefined)?.code === -32_700, "parse error"),
    ).toBeTruthy();
    for (const p of [b1, b2, daemon, ctl]) p.close();
  });

  it("fails a call at once when the daemon room is not there", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const b = await browserRoom(sub, id, "/kernel");
    b.send(rpc(7, "x"));
    expect(await b.takeJson((j) => j.id === 7, "error reply")).toMatchObject({ error: { message: "machine offline" } });
    b.close();
    ctl.close();
  });

  it("delivers a text response over 1 MiB intact", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const b = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open");
    const daemon = await daemonRoom(sub, id, "/kernel");
    const big = `${"é".repeat(700_000)}tail`;
    answerRpc(daemon, [], () => big);
    await b.until(() => b.synced, "synced");
    b.send(rpc(1, "blob/get"));
    const reply = await b.takeJson((j) => j.id === 1, "big reply");
    expect(reply.result).toBe(big);
    for (const p of [b, daemon, ctl]) p.close();
  });

  it("relays awareness untouched and tells the daemon when a browser leaves", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const b1 = await browserRoom(sub, id, "/kernel");
    const b2 = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open");
    const daemon = await daemonRoom(sub, id, "/kernel");
    await b1.until(() => b1.synced && b2.synced, "synced");

    const frame = awarenessFrame(42, 3, { cursor: 1 });
    b1.send(frame);
    const atDaemon = await daemon.until(() => daemon.awareness[0], "awareness at daemon");
    expect([...atDaemon]).toEqual([...frame]);
    await b2.until(() => b2.awareness[0], "awareness at other browser");
    expect(b1.awareness).toHaveLength(0);

    // Daemon awareness reaches every browser.
    const back = awarenessFrame(7, 1, { seat: "kernel" });
    daemon.send(back);
    await b1.until(() => b1.awareness[0], "daemon awareness at b1");
    await b2.until(() => b2.awareness.length > 1, "daemon awareness at b2");

    daemon.awareness.length = 0;
    b1.close();
    const removal = await daemon.until(() => daemon.awareness[0], "removal at daemon");
    expect(readAwarenessFrame(removal)).toEqual([{ id: 42, clock: 4, removed: true }]);
    for (const p of [b2, daemon, ctl]) p.close();
  });

  it("asks the daemon for awareness when a browser joins and forwards the daemon keepalive", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const first = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open");
    const daemon = await daemonRoom(sub, id, "/kernel");
    await first.until(() => first.synced, "synced");
    const before = daemon.queries;
    const late = await browserRoom(sub, id, "/kernel");
    await daemon.until(() => daemon.queries > before, "awareness query");
    const keepalive = new Uint8Array([MESSAGE_QUERY_AWARENESS]);
    daemon.send(keepalive);
    await late.until(() => late.queries > 0, "keepalive at browser");
    for (const p of [first, late, daemon, ctl]) p.close();
  });

  it("closes browsers as offline when there is no control socket", async () => {
    const { sub, id } = fresh();
    await userStub(env, sub).registerMachine(id, "x");
    const b = await browserRoom(sub, id, "/kernel");
    expect(await b.closedWith()).toEqual({ code: 4503, reason: "offline" });
    const http = await handle(
      new Request(`${ORIGIN}/m/${id}/app/index.html`, { headers: { cookie: devCookie(sub) } }),
      env,
    );
    expect(http.status).toBe(503);
    expect(await http.text()).toContain("offline");
  });

  it("refuses a room path the daemon does not serve", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const b = await browserRoom(sub, id, "/nope");
    expect((await b.closedWith()).code).toBe(4400);
    ctl.close();
  });

  it("closes browsers when the daemon room goes, passing a connector code through", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const a = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open");
    const d1 = await daemonRoom(sub, id, "/kernel");
    await a.until(() => a.synced, "synced");
    d1.close(1011, "boom");
    expect((await a.closedWith()).code).toBe(4504);

    const b = await browserRoom(sub, id, "/session?sessionId=gone");
    await ctl.take(isOpen, "open session");
    const d2 = await daemonRoom(sub, id, "/session?sessionId=gone");
    d2.close(4404, "not found");
    expect(await b.closedWith()).toEqual({ code: 4404, reason: "not found" });
    ctl.close();
  });

  it("keeps the daemon room through a quick reload, closes it after the grace", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const b = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open");
    const daemon = await daemonRoom(sub, id, "/kernel");
    await b.until(() => b.synced, "synced");
    b.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await browserRoom(sub, id, "/kernel");
    await again.until(() => again.synced, "resynced");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(daemon.closed).toBeNull();
    again.close();
    expect(await daemon.closedWith()).toEqual({ code: 1000, reason: "idle" });
    ctl.close();
  });

  it("ends daemon room sockets that outlive the control socket, and tells browsers", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const b = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open");
    const daemon = await daemonRoom(sub, id, "/kernel");
    await b.until(() => b.synced, "synced");
    ctl.close();
    expect(await b.closedWith()).toEqual({ code: 4503, reason: "offline" });
    expect((await daemon.closedWith()).reason).toBe("machine offline");
  });

  it("re-asks for state when a room's document is recreated (hibernation wake)", async () => {
    const { sub, id } = fresh();
    const ctl = await control(sub, id);
    const b = await browserRoom(sub, id, "/kernel");
    await ctl.take(isOpen, "open");
    const daemon = await daemonRoom(sub, id, "/kernel");
    daemon.doc.getMap("m").set("k", "v");
    await b.until(() => b.doc.getMap("m").get("k") === "v", "state");
    // What a wake leaves behind: sockets kept, memory gone.
    await runInDurableObject(machineStub(env, sub, id), (instance: unknown) => {
      (instance as { rooms: Map<string, unknown> }).rooms.clear();
    });
    const asked = { b: b.step1s, daemon: daemon.step1s };
    // The next frame wakes the room: everyone is asked for state again.
    b.send(awarenessFrame(1, 1, {}));
    await daemon.until(() => daemon.step1s > asked.daemon, "step 1 at daemon");
    await b.until(() => b.step1s > asked.b, "step 1 at browser");
    // The daemon's answer refilled the room, so a browser joining now gets the state.
    const late = await browserRoom(sub, id, "/kernel");
    await late.until(() => late.doc.getMap("m").get("k") === "v", "state after wake");
    for (const p of [b, late, daemon, ctl]) p.close();
  });

  it("keeps users apart", async () => {
    const a = fresh();
    const other = uniqueSub();
    const ctl = await control(a.sub, a.id);
    // Another user cannot even open the browser route to a machine they never registered.
    const res = await handle(upgrade(`/m/${a.id}/room/kernel`, { cookie: devCookie(other) }), env);
    expect(res.status).toBe(404);
    // Their daemon with the same machine id lands in their own, separate object.
    const theirs = await daemonRoom(other, a.id, "/kernel");
    await userStub(env, other).registerMachine(a.id, "mine");
    const mine = await browserRoom(a.sub, a.id, "/kernel");
    await ctl.take(isOpen, "open");
    theirs.send(JSON.stringify({ jsonrpc: "2.0", method: "leak" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mine.frames.filter((f) => typeof f === "string")).toHaveLength(0);
    for (const p of [theirs, mine, ctl]) p.close();
  });
});

describe("tunnel", () => {
  const get = (sub: string, id: string, path: string, init: RequestInit = {}) =>
    handle(
      new Request(ORIGIN + path.replace("$id", id), {
        ...init,
        headers: { cookie: devCookie(sub), accept: "text/html", ...init.headers },
      }),
      env,
    );
  const nextReq = async (node: Peer) =>
    JSON.parse(
      await node.take((f): f is string => typeof f === "string" && f.includes('"t":"req"'), "req"),
    ) as ReqFrame;

  it("streams an app file through the node", async () => {
    const { sub, id } = fresh();
    const node = await control(sub, id);
    const pending = get(sub, id, "/m/$id/app/index.html?v=2");
    const req = await nextReq(node);
    expect(req).toMatchObject({ t: "req", method: "GET", url: "/app/index.html?v=2" });
    const names = req.headers.map(([k]) => k);
    expect(names).toContain("accept");
    expect(names).not.toContain("cookie");
    expect(names.some((k) => k.startsWith("x-relay"))).toBe(false);

    node.send(
      encodeNodeFrame({
        t: "head",
        id: req.id,
        status: 200,
        statusText: "OK",
        headers: [
          ["content-type", "text/html"],
          ["set-cookie", "x=1"],
        ],
      }),
    );
    node.send(new Uint8Array(encodeChunk(req.id, new TextEncoder().encode("<h1>"))));
    node.send(new Uint8Array(encodeChunk(req.id, new TextEncoder().encode("hi</h1>"))));
    node.send(encodeNodeFrame({ t: "end", id: req.id }));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(await res.text()).toBe("<h1>hi</h1>");
    node.close();
  });

  it("serves /file with its query and a body over 1 MiB in node chunks", async () => {
    const { sub, id } = fresh();
    const node = await control(sub, id);
    const pending = get(sub, id, "/m/$id/file?path=%2Fa%20b.png");
    const req = await nextReq(node);
    expect(req.url).toBe("/file?path=%2Fa%20b.png");
    node.send(encodeNodeFrame({ t: "head", id: req.id, status: 200, statusText: "OK", headers: [] }));
    const piece = new Uint8Array(256 * 1024).fill(7);
    for (let i = 0; i < 5; i++) node.send(new Uint8Array(encodeChunk(req.id, piece)));
    node.send(encodeNodeFrame({ t: "end", id: req.id }));
    const body = new Uint8Array(await (await pending).arrayBuffer());
    expect(body.byteLength).toBe(5 * 256 * 1024);
    node.close();
  });

  it("maps a node error to 502", async () => {
    const { sub, id } = fresh();
    const node = await control(sub, id);
    const pending = get(sub, id, "/m/$id/app/x");
    const req = await nextReq(node);
    node.send(encodeNodeFrame({ t: "err", id: req.id, message: "ENOENT" }));
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("ENOENT");
    node.close();
  });

  it("sends cancel when the caller drops the body", async () => {
    const { sub, id } = fresh();
    const node = await control(sub, id);
    const pending = get(sub, id, "/m/$id/app/big");
    const req = await nextReq(node);
    node.send(encodeNodeFrame({ t: "head", id: req.id, status: 200, statusText: "OK", headers: [] }));
    node.send(new Uint8Array(encodeChunk(req.id, new Uint8Array(10))));
    const res = await pending;
    await res.body!.cancel();
    const cancel = decodeServerFrame(
      await node.take((f): f is string => typeof f === "string" && f.includes('"cancel"'), "cancel"),
    );
    expect(cancel).toEqual({ t: "cancel", id: req.id });
    node.close();
  });

  it("fails in-flight calls when the node goes, and refuses non-GET", async () => {
    const { sub, id } = fresh();
    const node = await control(sub, id);
    const pending = get(sub, id, "/m/$id/app/x");
    await nextReq(node);
    node.close();
    expect((await pending).status).toBe(502);
    const post = await get(sub, id, "/m/$id/app/x", { method: "POST", body: "x" });
    expect(post.status).toBe(405);
  });
});

describe("TunnelServer", () => {
  it("sends cancel when the caller aborts before the head", async () => {
    const sent: string[] = [];
    const tunnel = new TunnelServer((frame) => sent.push(frame));
    const ac = new AbortController();
    const res = tunnel.call(new Request("https://x/app/a", { signal: ac.signal }), "/app/a");
    const req = decodeServerFrame(sent[0]!) as ReqFrame;
    ac.abort();
    expect((await res).status).toBe(502);
    expect(decodeServerFrame(sent[1]!)).toEqual({ t: "cancel", id: req.id });
    expect(tunnel.inflight).toBe(0);
  });

  it("ignores frames for calls it does not know", () => {
    const tunnel = new TunnelServer(() => undefined);
    tunnel.onText(encodeNodeFrame({ t: "end", id: 99 }));
    tunnel.onBinary(encodeChunk(99, new Uint8Array(1)));
    tunnel.onBinary(new ArrayBuffer(2));
    expect(tunnel.inflight).toBe(0);
  });
});
