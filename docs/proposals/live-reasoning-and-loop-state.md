# Live reasoning streaming + loop-state indicator — rework plan

Status: draft for review
Scope: `surfaces/web`, `surfaces/tui`, `packages/harness` (provider actor + session daemon),
`packages/harness-model` (activity projection), `packages/harness-transcript` (tape),
`surfaces/web/src/shell/markdown.tsx`.
Constraint: no heavy per-token overhead; must stay viable over a phone cellular relay.

## 1. Goal

1. Reasoning ("thought") blocks appear and grow **while the model is still responding**, in both
   the web UI and the TUI — not only after the round seals. The old plexus/Yjs version had this;
   the SQLite/LiveShape rebuild kept the wire mechanism but the web tape stopped reading it.
2. The web UI shows the **current loop state** (waiting for model, thinking, responding, retrying,
   running tools, waiting for approval, …) as a single honest indicator, derived from one projection.

Non-goals: reviving the dead `stream/delta` frame; a new transport; per-token durable writes;
rewriting the TUI paint pipeline; touching the unrelated authorization/class-mode work in the tree.

## 2. What already exists (research findings, with evidence)

There are **two independent live channels** from daemon to surface. Both survive the Yjs purge.

### Channel A — durable document (SQLite → `shape/delta`)
- MobX session doc → `KernelDaemon.flushSession` (`KernelDaemon.ts:1444`, sync core `#flushSessionSync`
  `:1609`) → `session_nodes` rows → `UpdateLaneHub` → `shape/delta` → client `applyNodeShapeDelta`
  (`harness-peer/src/plane.ts:258`) → client MobX doc.
- Flush happens explicitly per RPC/checkpoint **and automatically on any doc patch**:
  `KernelDaemon.#bindSessionFlush` (`KernelDaemon.ts:1411-1438`, attached by `internSession` `:1310`
  and `mintSessionDocument` `:1718,1729,1734`) subscribes to `plexus.doc.onPatch`, debounces at
  **50 ms** (`setTimeout(flushNow, 50)`), checks `plexus.doc.peekNodeDelta()`, and runs
  `#flushSessionSync(plexus)`.
- `responseText` / `responseThought` are written only at round end
  (`CompletionExpectation.stampAnswer` / `complete` / error / abort).
- `phase`, `retryUntilMs`, `lastAttemptError`, `foregroundFailures`, `backgroundFailures`,
  `retryForeground` are durable `@state` fields on `CompletionExpectation`
  (`CompletionExpectation.ts:154-162`, working tree); mutating them inside `runInAction` emits
  `onPatch` and is therefore flushed by `#bindSessionFlush` within ~50 ms (and on explicit flushes).

### Channel B — ephemeral awareness (`presence/update`) — the live token stream
- `OpenAiCompatActor.speech(text, thought)` runs per normalized delta
  (`providers/openai-compat/actor.ts:1050-1068`). It sets `expectation.phase`
  (`thinking`/`responding`), calls `markThoughtEnded()` at the thought→text boundary, then
  `this.report({ text, thought, thoughtKind, startedAt, cacheHit, expectedCacheHit })`.
- `ExpectationActor.report` (`plexus-expectations/src/driver/ExpectationActor.ts:160-170`)
  JSON-encodes the frame, stores `#lastReportJson` (re-reported on rejoin, `:232`), and
  `reportRole(hub, uuid, frame)` → `MapFieldAwareness` on `ROLE_EXPECTATIONS_LANE`
  (`shared/role.ts:19-24`) keyed by expectation uuid.
- `PlexusAwareness` emits `update` → `PresenceRoom` (`server/transport/plane.ts:91-110`)
  `encodePresenceUpdate(entries)` → `sendText` to **every socket in the room, per change,
  with no throttle**. The frame carries the **full accumulated `text` + `thought` snapshot**.
- Client: `bindRoomAwareness` (`harness-peer/src/awareness.ts:17-47`) → `applyPresenceEntries`
  → `ReactiveAwareness` → `WorkExpectation.progressAwareness` (live frame ?? `lastProgress`
  cache, `WorkExpectation.ts:155-174`) → `report` getter = `outcomeReport ?? progressAwareness`
  (`:179-181`). On reconnect the server sends a full `presence/state` dump
  (`PresenceRoom.join`, `plane.ts:152-156`), so resync is free.
- `#beginAttempt` reports an empty frame (`actor.ts:1007`); `#sleepBackoff` reports
  `{ text:"", thought:"", startedAt, retryUntilMs }` (`actor.ts:1024`). `CompletionReport`
  already has `retryUntilMs?` (`CompletionExpectation.ts:30-46`). **It has no `phase`.**
- All streaming providers reuse this actor: OpenRouter and Nous extend
  `OpenAiCompatDriverConnection` (`openrouter/connection.ts:19`, `nous/driver.ts:58,191`);
  `speech()` is the single per-delta report site.

### Surfaces today
- **TUI already streams reasoning live at HEAD.** `completionPaintFields`
  (`surfaces/tui/src/interpreter/paint-controller.ts:322-343`) reads `report.text/thought`;
  `thoughtLive = live && thoughtEndedAtMs == null && text.trim() === ""` drives the Rust
  "Thinking" block + elapsed timer + collapsed first line (`quickdraw/src/tape.rs:339-357,547-559`).
  The SDK binds room awareness (`harness-sdk/src/client.ts:284-286`). Paint is already cheap:
  MST `onPatch` → microtask batch → splice patches → Rust 50 ms poll coalescing → row-diff ANSI
  (`state.ts:362-380`, `renderer.ts:36-99`). **No TUI architecture change is needed for part 1.**
- **Web at HEAD reads only durable fields** (`tape-read.ts` `responseText/responseThought`),
  so reasoning appears late. The **working tree** already changes `tape-read.ts` to read
  `expectation.report` when `!isDone` (live text + thought) and adds failure rows. This is the
  right mechanism; it needs completing and cost-bounding (§4).
- `Markdown` (`surfaces/web/src/shell/markdown.tsx:8-22`) is `memo` on `text`, so stable cells
  never re-parse. The **one growing live cell** re-parses its full text per update
  (`remend` + ReactMarkdown/remark-GFM). `tape-live.ts` recomputes `beats` per token but keeps a
  structurally-equal `outline`, so only the changed cell's body re-renders.

### Loop-state projection (working tree, untracked)
- `sessionActivity(root)` (`harness-model/src/session/activity.ts`) is the single projection:
  `idle | stopping | approval | tools | agents | compacting | working | stopped{detail} |
  waiting | thinking | responding | retrying | checking{completion}`. It reads the **durable**
  `expectation.phase`, `retryUntilMs`, `completionMode === "isolated" → checking`.
- `SessionStatus` (`surfaces/web/src/shell/session-status.tsx`) renders labels for all kinds,
  retry attempt `n/N`, `lastAttemptError`, and `autoModeProblem`; mounted above the composer
  (`composer.tsx:489`). `SessionRoot.activity` getter (`SessionRoot.ts:74-77`).
- `activity.test.ts` exercises the projection through stored replicas (`toNodeRows`/`fromNodeRows`).

### Dead code we will NOT revive
- `StreamDeltaFrame` (`harness-contract/src/lanes.ts:60-71`, `stream/delta` with
  `textDelta/thoughtDelta/text/thought/phase/done`) is decoded by web `RoomConnection`
  (`provider.ts:280-283`, emits `"stream"`), forwarded by the relay (`relay/src/plane.ts:205-209`),
  and **ignored by the daemon** (`transport/plane.ts:356-358`). No producer, no consumer.
  Reviving it would create a second streaming path beside awareness — reinventing the bicycle.
  Decision: keep using Channel B; leave `stream/delta` untouched (optional later removal).

## 3. Gap analysis

| # | Gap | Effect | Root cause |
|---|-----|--------|-----------|
| G1 | Web reasoning late at HEAD | part 1 broken on web | tape reads durable fields only (working tree fixes the read; needs completion + cost bound) |
| G2 | **Loop state propagation unverified (already wired via `#bindSessionFlush`)** | unclear until tested | Initial inspection missed `KernelDaemon.#bindSessionFlush` (`KernelDaemon.ts:1411-1438`), which already flushes `onPatch` node deltas every **50 ms**. `phase`/retry `@state` writes inside `runInAction` (`actor.ts:1060,1080`) already mark the doc dirty and flush via Channel A, though no integration test currently verifies mid-round `phase`/retry delivery through `#bindSessionFlush` → `shape/delta` → `sessionActivity`. |
| G3 | Per-delta full-snapshot awareness broadcast | O(n²) bytes/round, per-delta JSON+send to every socket; heavy on cellular | `speech()` reports every delta; `PresenceRoom` has no coalescing |
| G4 | Growing web cell re-parses full markdown per update | client CPU on phone | `Markdown` memo only helps unchanged text; the live tail re-parses |
| G5 | Narrow-screen reasoning hidden while live | part 1 UX on phone | `ThoughtNotes` collapses on narrow; no live auto-expand / duration label |

TUI has no part-1 gap (already live). Part 2 on TUI is covered by occupancy
(`connecting/waiting/responding/using-tools`) + the per-completion Thinking block; `#bindSessionFlush`
also keeps TUI's durable `phase` view current within ~50 ms at no extra cost.

## 4. Design decisions

### D1 — Reuse Channel B for live tokens (no new wire format)
Awareness already delivers live `text`/`thought` to both surfaces, is last-writer-wins, and
resyncs for free on reconnect. Web reads `expectation.report` when `!isDone` (working tree) and
falls back to durable `responseText/responseThought` when done. **Do not revive `stream/delta`.**

### D2 — Reuse `KernelDaemon.#bindSessionFlush` for live loop state (closes G2 without a duplicate reaction)
**No new MobX `reaction` or transport field is needed.** `KernelDaemon.#bindSessionFlush`
(`KernelDaemon.ts:1411-1438`) already watches `plexus.doc.onPatch` for every interned or minted
session (`internSession` `:1310`, `mintSessionDocument` `:1718,1729,1734`):

- When `OpenAiCompatActor` (`actor.ts:1060-1064,1080-1083`) or attempt/backoff transitions update
  `CompletionExpectation` `@state` fields (`phase`, `retryUntilMs`, `lastAttemptError`,
  `foregroundFailures`, `backgroundFailures`, `retryForeground`, `thoughtEndedAtMs`) inside
  `runInAction`, the doc records a node patch (`onPatch`).
- `#bindSessionFlush` coalesces patches with a **50 ms** trailing timer (`setTimeout(flushNow, 50)`),
  skips empty deltas via `plexus.doc.peekNodeDelta()` (`:1419`), and calls `#flushSessionSync(plexus)`
  (`:1609`) → SQLite `session_nodes` → `UpdateLaneHub` → `shape/delta`.
- Because these discrete fields only change a handful of times per round (`waiting` → `thinking` →
  `responding`, plus retry transitions), and streaming text/thought lives only in ephemeral
  Channel B (not `@state`) until seal, per-token writes still never happen; each discrete transition
  produces at most one small debounced SQLite write + `shape/delta` frame. Cellular-safe.
- **Single source of truth preserved**: durable fields stay authoritative; no `phase` duplicated
  into `CompletionReport`, no overlay logic in `sessionActivity`, and no redundant `SessionDaemon`
  flush reaction fighting `#bindSessionFlush`.
- Remaining work for G2: verify all provider phase/retry transitions mutate `@state` inside
  `runInAction` and add an integration test proving `phase`/retry updates flow through
  `KernelDaemon.#bindSessionFlush` → `shape/delta` → replica doc → `sessionActivity`.

### D3 — Source-side coalescing of per-delta reports (fixes G3)
Throttle the **report** inside `speech()` (the single per-delta site), not the transport:
- Trailing-edge coalesce, target interval **~100 ms** (≈10 Hz). Keep the latest `{text, thought}`;
  a timer flushes the pending snapshot. Skip if unchanged since last send.
- **Immediate flush** at the thought→text boundary (`markThoughtEnded`) so the phase edge is crisp,
  and a **terminal flush** before `stampAnswer`/`complete`/error/abort so the tail is visible before
  seal. `#beginAttempt` and `#sleepBackoff` reports stay immediate (discrete, already rare).
- Keep **full snapshots** (not deltas): last-writer-wins awareness semantics, trivial reconnect
  resync via `presence/state`, no reassembly/ordering state. `#lastReportJson` stays current
  because each flush still calls `this.report`.
- Why source, not `PresenceRoom`: provider-local, one place, leaves the generic
  `ExpectationActor`/transport untouched and other expectation types unaffected. Covers all
  providers (OpenRouter/Nous reuse this actor).
- Cellular byte math: a 5 KB thought at 10 Hz ≈ 50 KB/s peak, ~half average; total per round
  ≈ rate × n²/2 instead of per-delta. ~5–10× fewer frames than today with no readable UX loss
  (humans cannot parse >10 Hz updates). Adaptive rate / delta mode is a possible later optimization,
  not needed now.

### D4 — Bound the growing web cell's render cost (fixes G4)
Server coalescing (D3) already caps updates at ~10 Hz and `Markdown` memo already protects stable
cells. For the one growing cell:
- Primary: **block-memoized markdown** — split the live text into top-level blocks (blank-line
  separated), memoize every completed block, re-parse only the growing tail block. Standard
  incremental-rendering technique; keeps formatting stable while streaming.
- Fallback (if measurement shows the tail parse is still heavy on phone): render the live cell as
  plain `pre-wrap` text while streaming and switch to full markdown on seal (matches TUI, which
  renders plain text). Decide after measuring; do not ship both paths.
- Keep `tape-live.ts`'s structural `outline` so only the changed cell body re-renders.

### D5 — ThoughtNotes live UX (fixes G5)
- While live: show the streaming thought, **auto-expand on narrow screens** so reasoning is visible
  as it arrives; label "Thinking…" with elapsed time (reuse `thoughtDurationMs()` /
  `thoughtEndedAtMs`, `CompletionExpectation.ts:406-444`).
- On seal: collapse to "Thought for Xs" (duration from `thoughtDurationMs()`), default collapsed on
  narrow, always laid out on wide (current behavior). Empty thought stays hidden (working-tree guard).
- The live→durable handoff at `isDone` must be seamless (same text, no flicker).

### D6 — TUI: verify, don't rearchitect
Part 1 already works. Add/confirm a test that awareness report frames drive `thoughtLive`, the
collapsed first line, and the seal transition. `#bindSessionFlush` already keeps durable `phase`
consistent for TUI too. No paint-pipeline change. (Optional polish, out of scope: an occupancy
`thinking` kind — the Thinking block already conveys it.)

## 5. Loop-state inventory (part 2)

One projection (`sessionActivity`) is the source for the web indicator. Full inventory:

**Session activity** (`activity.ts`, rendered by `SessionStatus`):
| kind | meaning | source |
|------|---------|--------|
| idle | no open turn | no live turn, head not broke |
| stopped{detail} | turn failed/stopped | `head.broke` / `reducerExited` |
| stopping | cancel requested | `turn.cancelRequested` |
| approval | waiting on a permission ask | open `ApprovalJob`/ask |
| tools | running tool calls | open `ToolCallJob`/`ProgrammaticJob` |
| agents | running sub-agents | open `CallJob` |
| compacting | context compaction | open `CompactJob` |
| working | other open work | fallback open work |
| waiting | model request sent, no tokens yet | `phase === "waiting"` |
| thinking | reasoning tokens arriving | `phase === "thinking"` |
| responding | answer tokens arriving | `phase === "responding"` |
| retrying | transient-error backoff | `retryUntilMs != null` (+ attempt n/N, `lastAttemptError`) |
| checking{completion} | isolated completion being verified | `completionMode === "isolated"` |

**Provider phase** (durable `CompletionExpectation.phase`): `waiting | thinking | responding`.
**Retry sub-state**: `retryForeground`, `foregroundFailures`/`backgroundFailures` vs
`retryMaxAttempts`/`retryBackgroundMaxAttempts`, `retryUntilMs` countdown, `lastAttemptError`.
**Connection link** (`Dial.Link`, rendered by `link-notice.tsx`, separate from activity):
`unreachable | unanswered | cancelled | missing | elsewhere | reconnecting | offline | unavailable`,
`null` = attached & live.
**TUI occupancy** (`wait-phrase.ts`): `connecting | waiting | responding | using-tools`; host spinner
phases (`liveness.ts`): `openingSession, syncingSession, syncingKernel, kernelOccupancy,
syncingProject, applyingModel, loadingModels, closingSession, cancelTurn`; plus the per-completion
Thinking block and statusline (`session-statusline.ts`).

The web indicator covers activity + `autoModeProblem`; link state stays in `link-notice`.
Channel A's 50 ms `#bindSessionFlush` makes `waiting/thinking/responding/retrying` transition live
instead of sticking at `waiting`.

## 6. Per-package change list

1. `packages/harness` — **no new flush reaction needed** (`KernelDaemon.#bindSessionFlush` at
   `KernelDaemon.ts:1411-1438` already handles discrete `@state` flushes); audit actor phase/retry
   mutations in `runInAction` if any path skips `@state`.
2. `packages/harness/src/providers/openai-compat/actor.ts` — D3 speech report coalescing
   (trailing ~100 ms, boundary + terminal flush, skip-unchanged). Discrete reports unchanged.
3. `packages/harness-transcript/src/tape.tsx` — D5 ThoughtNotes live label/auto-expand/duration;
   ensure only the growing cell re-renders.
4. `surfaces/web/src/shell/markdown.tsx` — D4 block-memoized live rendering (or plain-while-live
   fallback after measurement).
5. `surfaces/web/src/shell/tape-read.ts` — complete/verify the working-tree live `report` read and
   the `isDone` durable handoff.
6. Tests: actor coalescing (fake timers), `#bindSessionFlush` phase/retry propagation (doc →
   `KernelDaemon` flush → `shape/delta` → replica → `sessionActivity`), web live tape read +
   handoff, TUI `thoughtLive` confirm, markdown block memo.
7. Docs: this plan + the inventory; note `stream/delta` as intentionally-unused.

## 7. Performance & cellular budget
- No per-token durable writes. Durable writes occur only via 50 ms debounced `#bindSessionFlush` on
  discrete `@state` transitions (D2) and explicit flushes at round end/checkpoints.
- Awareness frames coalesced to ~10 Hz full snapshots (D3); reconnect resync via `presence/state`.
- Web re-parse bounded to the growing tail block (D4); stable cells memoized already.
- TUI unchanged (already coalesced at 50 ms + row-diff).
- Net: fewer frames than today, no new transport, no second streaming path.

## 8. Test plan
- Unit: `speech` coalescing emits ≤1 frame/100 ms, flushes on boundary/terminal, skips unchanged;
  `sessionActivity` unchanged semantics.
- Integration: `#bindSessionFlush` (`KernelDaemon.ts:1411-1438`) flushes `phase`/retry `@state`
  changes within ~50 ms → `shape/delta` → replica doc → `sessionActivity` returns
  `thinking`/`responding`/`retrying` mid-round (extend `activity.test.ts` / kernel flush tests).
- Surface: web tape shows live thought before seal and hands off to durable on `isDone`;
  TUI `thoughtLive` true while streaming, false on seal.
- `pnpm typecheck` + targeted `vitest` for touched packages.

## 9. Risks / open questions
- Flush reaction firing during hydration/recovery → guard install timing; flush is idempotent.
- Terminal report flush ordering vs seal → flush before `stampAnswer` so no visible tail gap.
- Markdown block-memo correctness (tables/code fences spanning blocks) → memo only completed
  top-level blocks; tail re-parses; verify with existing markdown tests.
- Narrow-screen auto-expand UX → confirm it doesn't fight the manual disclosure toggle.
- Working tree mixes unrelated authorization/class-mode changes → keep this diff additive and
  focused; do not revert or refactor unrelated files.
- Open: measure tail-parse cost on a phone-class device to choose D4 primary vs fallback.

## 10. Note on prior partial implementation
The working tree already contains part of this feature (uncommitted): `phase`/retry fields on
`CompletionExpectation`, `activity.ts` + `SessionStatus`, the `tape-read.ts` live `report` read,
and `KernelDaemon.#bindSessionFlush` (closing the missing-flush half of G2).
This plan **completes and verifies** that work rather than restarting it; the missing pieces are
end-to-end verification of G2, G3/G4 (cost bounding), and G5 (live UX), plus tests.