# Remote access through harness.inhuman.tools

Status: phases 1–6 done on branch `remote-access`; phase 7 (deploy) waits on the owner-only steps below. Experimental sandbox, not a commercial production service.

Run the whole chain locally: `pnpm turbo run build --filter=@inhuman.tools/harness-cli... --filter=@inhuman.tools/harness-relay...`, then `pnpm --filter @inhuman.tools/harness-relay test:e2e`. The wire contract between the connector and the relay is `packages/harness-relay/PROTOCOL.md`.

Known gaps: the workflow-graph SSE (`/sessions/:id/workflows/:job`) has no server in local mode either, so it is not tunneled; raw `<a href>` links in the rail ignore the `/m/<id>/app` base on middle-click; logout does not revoke the token at WorkOS; real AuthKit login, device login against WorkOS and Durable Object hibernation are untested until deploy.

## Goal

A user runs `inhuman login` on their machine. From then on they can open `https://harness.inhuman.tools`, sign in with the same WorkOS account, pick the machine, and use the regular inhuman web app against that machine's daemon from anywhere.

Constraints:

- The daemon never opens an inbound port. It dials out to Cloudflare.
- Idle costs nothing: hibernatable WebSockets, edge-answered PING/PONG.
- No persistence in the cloud. The Durable Object holds documents in memory only, as a speed-up and to decouple browser and machine connectivity. The daemon stays the source of truth.
- Security posture for a sandbox: the owner only (JWT `sub`), explicit opt-in on the machine (`inhuman login`), an email allowlist for testers. No E2E, no roles, no method allowlist.

## Topology

```
browser ⇄ wss /m/<machine>/<room>   chunked WS: Yjs binary + JSON-RPC text ⇄ MachineDO(sub:machineId)
browser ─ GET /m/<machine>/app/*, /m/<machine>/file ─ tunnel `req` ─────▶ MachineDO
                                                                          │ Map<room, Y.Doc>, memory only
daemon connector ── wss control (reverse-tunnel protocol, PING/PONG) ◀────┤ socket tags: control,
daemon connector ── wss /m/<machine>/<room> per room, on demand      ◀────┘ daemon:<room>, browser:<room>:<tag>
daemon connector ⇄ raw WS to daemon.sock (exactly what listen.ts does today)
```

### What travels where today

| Traffic | Client code | Remote path |
|---|---|---|
| Yjs sync + awareness | `harness-web-app/src/client/dial.ts`, `WebsocketProvider` | room socket, binary |
| JSON-RPC (incl. `blob/get`, `ui/resolve`) | `bindJsonRpc(room.provider)`, text frames on the room socket | room socket, text |
| Project file bytes | `shell/file-sidebar.tsx`: `fetch("/file?path=…")`, `<img>`, `<iframe>` | tunnel HTTP |
| App bundle | served by `harness-web-app/src/server/listen.ts` | tunnel HTTP, served by the machine itself, so app and daemon never skew |
| Workflow graph SSE `/sessions/:id/workflows/:job` | `dial.ts:179` | no server implements it today; out of scope until it exists |

## Components

### `packages/chunked-websocket` (`@inhuman.tools/chunked-websocket`)

A copy of `@here.build/chunked-websocket` 0.10.0 (`~/WebstormProjects/here.build/commons/packages/chunked-websocket`, MIT). Two changes:

1. A text frame that is not a chunking sentinel is delivered to the application. Upstream drops it; JSON-RPC rides text frames.
2. A batch marker carries `kind: "text" | "binary"`, so a text message over the 1 MiB workerd limit is chunked and reassembled into a string.

### `packages/harness-relay` (`@inhuman.tools/harness-relay`, private Worker)

- Auth: AuthKit sealed-cookie session for browsers (`/auth/login`, `/auth/callback`, `/auth/logout`); `Authorization: Bearer <WorkOS access token>` for the daemon. Both verified against the WorkOS JWKS (pattern: `here.build/inhuman/saas/api/src/middleware/auth.ts`). Email allowlist from env.
- `UserDO(sub)`: machine registry (`machineId`, name, `lastSeen`, online).
- `MachineDO(sub:machineId)`: the DO name is built from the verified `sub`, so no token can address another user's machine.
  - Rooms: one in-memory `Y.Doc` per room, y-sync codec copied from `plexus/packages/plexus-do/src/protocol.ts`. No leader, archive, persist or spill.
  - Room opens on demand: a browser joins a room with no daemon socket, the DO sends `open` over control, the connector dials the room.
  - Wake from hibernation with empty docs: send sync step 1 to the daemon socket of each room as browsers talk.
  - Awareness: relayed between sockets of a room, never applied in the DO (the daemon owns kernel-seat and channel-0 semantics, see `harness-peer/src/rpc.ts` `detachProtocolAwareness`).
  - RPC: a browser text frame's JSON-RPC `id` is rewritten to `"<clientTag>:<id>"` and forwarded to the room's daemon socket; responses route back by prefix. `clientTag` lives in the socket attachment, so routing survives hibernation without a pending table.
  - Daemon gone: browsers get an offline status; their in-flight calls fail.
  - HTTP: the reverse-tunnel server half (copied from `here.build/inhuman/saas/reverse-tunnel`) on the `control` socket. `GET /m/<machine>/app/*` and `/m/<machine>/file` become `req` frames with streamed responses.
- `GET /`: machine picker.

### Daemon (`packages/harness`, `packages/harness-contract`)

- WorkOS `DeviceClient` over the existing RFC 8628 client `harness/src/providers/auth/device.ts`. Verified endpoints (form-encoded works): `POST https://api.workos.com/user_management/authorize/device` with `client_id`; poll `POST https://api.workos.com/user_management/authenticate` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Refresh: same endpoint, `grant_type=refresh_token`.
- Contract methods `remote/login` (parks with `(harness/open-url :url … :description …)` like `providers/nous/driver.ts`), `remote/status`, `remote/logout`.
- Tokens in the runtime's `CredentialsStore`. `machineId` minted once, kept by the kernel; default name is the hostname.
- Connector: control socket with backoff and a fresh token on every reconnect; `req` served by a local HTTP handler (static app + `sendProjectFile` extracted from `listen.ts` into a shared module); room bridge raw WS ⇄ chunked WS, bytes not parsed. The CLI passes `staticDir` and `fileRoots` to the daemon, so the daemon still does not depend on `harness-web-app`.

### CLI and web app

- `inhuman login`, `inhuman logout`, `inhuman remote status`.
- Web app: a base URL (origin + `/m/<machine>`) for `dialOrigin` and `/file`; remote mode uses `ChunkedWebSocket` as `WebSocketPolyfill` over `wss`; offline and reconnecting states.

## Phases

| # | Work | Done when |
|---|---|---|
| 1 | `packages/chunked-websocket` copy + text passthrough + text batches | JSON-RPC text and Yjs binary share one socket, both over 1 MiB, tests green |
| 2a | relay scaffold, auth, allowlist, `UserDO`, picker | `wrangler dev` boots; auth unit tests green |
| 2b | `MachineDO` rooms, awareness relay, RPC id routing, on-demand open, hibernation resume | workers-pool tests with a fake daemon green |
| 2c | tunnel HTTP inside `MachineDO` | app and `/file` stream through a fake node |
| 3a | WorkOS device login, contract methods, token storage and refresh, `machineId` | `remote/login` parks with open-url and stores tokens (unit tests with a fake WorkOS) |
| 3b | connector + extracted HTTP serving | daemon bridges rooms and `req` against `wrangler dev` |
| 4 | CLI commands | `inhuman login` drives 3a |
| 5 | web app base URL + remote mode | app works under `/m/<machine>/app/` |
| 6 | e2e against `wrangler dev` with a dev-only token gate | scenarios: open session, stream, two tabs RPC, >1 MiB blob, `/file`, daemon restart, expired token, logout |
| 7 | deploy workflow, README | needs the owner: CF zone, WorkOS production env, secrets |

## Owner-only steps (not automated)

- Cloudflare zone `inhuman.tools`, custom domain `harness.inhuman.tools`.
- WorkOS production environment with CLI Auth enabled and redirect `https://harness.inhuman.tools/auth/callback`.
- Secrets: `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `CLOUDFLARE_API_TOKEN`.

## Open questions

- Remote access as a PEW connection or as a kernel service: decided in phase 3a by how naturally adopt and lifecycle fit.
- Copied code from private here.build packages (`reverse-tunnel`) is relicensed MIT by the owner.
