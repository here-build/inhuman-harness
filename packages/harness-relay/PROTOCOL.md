# Node protocol (daemon connector <-> relay)

For the connector (phase 3b). Everything below is implemented in `src/machine-do.ts` and `src/plane.ts`; `src/tunnel/protocol.ts` has the control frame types.

## Sockets

The connector opens WebSockets to `wss://<relay>/d/<machineId>/...` with `Authorization: Bearer <WorkOS access token>` (fresh token on every connect). `machineId` matches `^[\w-]{1,64}$`.

| Socket | URL | Count |
|---|---|---|
| control | `/d/<id>/control?name=<display name>` | one; a new one replaces the old (old closes `1012 replaced`) |
| room | `/d/<id>/room<upgrade path and query>` | one per room, dialed on demand |

Every socket speaks chunked framing (`@inhuman.tools/chunked-websocket`, client side `ChunkedWebSocket`): messages over 1 MB are split transparently, text and binary. Expect one `y-pk-reset` text frame from the relay on a socket's first use; the library swallows it.

## Keepalive

Send the text frame `" ping"` (leading space) every 20-30 s on every socket. The edge answers `" pong"` without waking the Durable Object. The library delivers `" pong"` to the application as an ordinary text message; drop it there.

## Control socket: relay -> node

Text JSON frames.

```
{ "t": "open",   "room": "/session?sessionId=s1&path=%2Fwork" }
{ "t": "req",    "id": 12, "method": "GET", "url": "/app/index.html?v=2", "headers": [["accept","text/html"]] }
{ "t": "cancel", "id": 12 }
```

- `open`: a browser wants a room and no room socket exists. Dial `/d/<id>/room` + `room` verbatim (path and query exactly as given; an upgrade can create a session, so replay it unchanged), then bridge it to the daemon socket with the same path and query. Idempotent: the relay repeats `open` for a room at most every 10 s, and again when the control socket reconnects while browsers wait. Ignore it if the room is already dialed.
- `req`: GET or HEAD only. `url` is the path after `/m/<id>` plus the query (`/app/...`, `/file?path=...`). Headers are allowlisted (accept, accept-language, cache-control, content-type, if-*, range, user-agent); cookies and `x-relay-*` never arrive. Answer with `head`, binary chunks, `end`.
- `cancel`: the caller went away; abort the local fetch for `id`.

## Control socket: node -> relay

```
{ "t": "head", "id": 12, "status": 200, "statusText": "OK", "headers": [["content-type","text/html"]] }
{ "t": "end",  "id": 12 }
{ "t": "err",  "id": 12, "message": "ENOENT" }
```

Body bytes go as binary frames: `[uint32 big-endian id][bytes]`. Send chunks of 256 KiB or less (`NODE_CHUNK_BYTES`); the transport would split larger ones, but small chunks stream better and keep memory flat. Order: one `head`, any number of chunks, then `end`. `err` (before or after `head`) fails the call: before `head` the browser gets 502 with the message, after `head` the response stream errors. No `head` within 30 s fails the call with 502 and sends `cancel`. `set-cookie` and hop-by-hop headers are dropped by the relay. Statuses 101, 204, 205, 304 carry no body.

If the control socket drops, every call riding it fails; the relay does not retry.

## Room sockets

- Path: `/d/<id>/room` + the daemon's upgrade path and query (`/kernel`, `/project?path=...`, `/session?...`). Other paths are closed `4400`.
- Room identity: path plus query sorted by name. `/session?sessionId=s&path=p` and `/session?path=p&sessionId=s` are one room. `/session?sessionId=s` and `/session?sessionId=s&path=p` are two.
- Bridge UTF-8 text frames both ways between this socket and the daemon socket: reactivity plane JSON frames (`shape/*`, `presence/*`, `stream/delta`, `ping`/`pong`) and JSON-RPC 2.0 frames. Drop daemon `{"kind":"ping"}` keepalives at the connector so idle browsers do not wake the Durable Object.
- Close the room socket when the daemon socket closes. Pass the cause in the close code:
  - daemon refused the upgrade (404 / 400 / 500): close `4000 + status` (`4404`, `4400`, `4500`) with a short reason. The relay forwards that code and reason to the browsers.
  - anything else: any code; browsers get `4504`.
- The relay closes a room socket with `1000 idle` thirty seconds after the last browser leaves, `1000 machine offline` when the control socket has been gone for 60 s, and `1012 replaced` when the connector dials the same room again. Do not redial on `1000`; redial on demand through the next `open`.
- A control socket that drops does not close room sockets by itself. If the connector process dies, its room sockets die with it.

## Browser-visible close codes

| Code | Meaning |
|---|---|
| `4503` `offline` | no control socket (machine off), or it was lost for over 60 s |
| `4504` | the daemon's room socket closed |
| `4400` | not a room the daemon serves |
| `4404`, `4400`, `4500` | refusal passed through from the connector |

## JSON-RPC ids

The daemon sees one socket per room, so the relay rewrites request ids: `"<clientTag>:<original id as JSON>"`, with `clientTag` 12 hex characters per browser socket. `7` becomes `"3fa9c1d02b7e:7"`, `"a:b"` becomes `"3fa9c1d02b7e:\"a:b\""`, `null` becomes `"3fa9c1d02b7e:null"`. The daemon must echo the id it received (it does). Responses are routed back by prefix and the original id is restored. A frame without `id` is a notification: forwarded untouched from a browser, broadcast to every browser in the room from the daemon. The daemon sends no requests on this channel today; a frame with `method` is broadcast as is. Malformed JSON and invalid requests are answered by the relay and never reach the daemon. With no room socket, a call fails at once with error `-32000 machine offline`.

## Shape Subscriptions (`LiveShape`)

The relay is stateless across Durable Object hibernation: it holds no in-memory document state. Instead, each browser attachment persists its active `shape/subscribe` descriptors (`subs`). The relay prefixes `subscriptionId` with `<clientTag>:` when forwarding `shape/subscribe` and `shape/unsubscribe` to the daemon room socket, and strips the prefix when routing `shape/delta` back to the subscribing browser. When a room socket connects (or reconnects after hibernation), the relay replays all active browser `shape/subscribe` frames to the daemon. Forged `shape/delta` frames from browsers are dropped; clients write exclusively through JSON-RPC.

## Presence (`presence/*`)

Presence frames (`presence/update`, `presence/state`, `presence/query`) are UTF-8 JSON text frames carrying `[clientId, state | null, clock?]` entry tuples. The relay tracks `[clientId, clock]` pairs per browser attachment; when a browser disconnects, the relay synthesizes a `presence/update` removal (`[clientId, null, clock + 1]`) to the daemon and peer browsers in the room. When a browser joins and the room socket is open, `presence/query` is forwarded so the daemon's presence state reaches the newcomer.

The daemon sees one connection per room, not one per browser. Its per-connection cleanup (aborting in-flight calls and parked UI on close) runs when the room socket closes, not when a single browser leaves, and a parked UI form can be resolved from any browser in the room. Acceptable while every browser in a room is the same owner.
