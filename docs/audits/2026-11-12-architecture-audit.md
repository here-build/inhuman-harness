# Architecture audit — inhuman monorepo

Date: 2026-11-12 · Scope: whole workspace (~60 packages, ~280k LOC TS) · Mode: read-only
Axes: generalized architecture · isolation boundaries · type strictness/precision · data-representation normalization · runtime state coherence

Method: five parallel read-only deep-dive investigations (dependency graph from every workspace manifest + full `src` import scan; boundary tracing; 137-file tsconfig census; concept-by-concept representation inventory; state/sync/lifecycle tracing), followed by direct source verification of every headline finding. Citations are `file:line`. Items marked **INFERRED** were not fully proven and are listed for follow-up in §9.

---

## 1. Executive summary

**Verdict.** This is a disciplined, mid-migration architecture. The fundamentals are unusually good: zero dependency cycles, zero deep imports, exact manifest↔import consistency, a pure L0 kernel, a coherent and well-fenced turn lifecycle, symlink-aware file jails, fail-closed auto-mode judges, and epoch-ms timestamps normalized everywhere. The repo's own rebuild docs (`docs/architecture-rebuild/02`, `05`) already prescribe the fully-normalized target (Drizzle tables as single source of truth, `@column`-bound domain classes, deleted Plexus layer). **The distance to that target is measurable and concentrated at a small number of seams** — not spread evenly through the code.

The four weakest points, one per axis:

1. **Architecture** — boundaries are *conventional, not mechanical*. The largest concrete break is `harness-transcript` ↔ `surfaces/web`: 39 relative imports escape the package into the app that bundles it, with the lint rule explicitly disabled (`packages/harness-transcript/eslint.config.mjs:11`). The domain kernel imports feature libs (`KernelRoot.ts:10` → statusline). Browser-safety lint exists but is wired to nothing.
2. **Isolation** — the daemon unix socket has **no authentication** (`server/transport/accept.ts:23-42`); `:readonly` is a catalog projection, not a boundary (`harness-scheme/src/bound-tools.ts:25-32` — shell survives); plugins run **in-process** behind a lexical-only jail (`extensions/jail.ts:3-9`).
3. **Types** — base `strict:true`, but five runtime packages inherit `noImplicitAny:false` from `internal/tsconfig/purpose/lib.json:16`; `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` are absent everywhere except two packages; unvalidated `JSON.parse … as T` crosses persistence seams into the typed core (`react-chunk.ts:22-36`); IDs are unbranded strings.
4. **Normalization** — the same concept lives in 2–5 hand-maintained shapes: session (live doc vs wire table disagree on field names and vocabularies), permission mode (**wire default `"ask"` is not a member of the domain union `manual|auto|yolo`**), policy decision (4-shape ladder + duplicated `CLASS_IDS`), connection status (4-state vs 6-state), job status (boolean flag soup), tool result (3 envelopes), reasoning effort (5 identical copies pinned only by tests).

Top consistency hazard: client-held session replicas are **fully writable mobx state by convention only** — `SessionPlexus.connect` accepts `readOnly` and never reads it (`SessionPlexus.ts:130-151`), and a reconnect `reset` clears dirty tracking with `Math.max` revision merge (`model/src/container.ts:724-728`).

---

## 2. Generalized architecture analysis

### 2.1 Intended vs actual layering

Intended DAG (`docs/architecture-rebuild/00-strategy-and-dag.md:33-52`):
L0 `model` + `harness-contract` (zero workspace deps) → L1 `plexus-expectations`, `scope-plane` → L2 `harness-model` → L3 `turn` → L4 `harness`/`harness-peer`/`harness-relay` → L5 clients/SDKs.

Actual (manifest-verified):

- **L0 clean.** `model` and `harness-contract` have zero workspace deps; `packages/model/src` contains no `@inhuman.tools/*` import. Kernel purity holds.
- **L2 contaminated.** `harness-model` depends on `activity`, `continuation`, `statusline` — feature libs absent from the DAG. Concrete imports: `kernel/KernelRoot.ts:10` (`statusline/constants`), `schemas/context-need.ts:5,65` + `session/update-metadata.ts:12` (activity), `shared/ReActLoopIntentDetectedTrigger.ts:19` (continuation). Browser-safe today only because `/constants` is import-free while the statusline barrel re-exports node-bearing modules (`statusline/src/index.ts:2-4`).
- **L3 edge missing.** `turn` does **not** depend on `scope-plane` (DAG N4→N6 absent); instead it fans in to `policy`, `plugin-sdk`, `scheme-program`, `harness-provider-sdk`, `continuation`.
- **L4/L5.** `harness` → 35 workspace deps. `harness-peer` pulls domain (`harness-model`, `model`, `plexus-expectations`), not just contract. `harness-sdk` pulls the storage plane (`scope-plane`, `harness-peer`). `harness-provider-sdk` → `harness-model`. Only `harness-client` (→ contract only) and `plugin-sdk` (→ commons only) are contract-clean entry points.
- **Cycles: none.** DFS over all manifest edges (incl. dev) = 0. The one import-level candidate (`harness-contract → harness-client`) is a false positive: `spec/readme.ts:71-72` sits inside a markdown code fence in a template literal.
- **Deep imports: zero.** Every subpath (`harness-model/kernel`, `turn/catalog`, `substrate/doors`, `policy/floor`, …) resolves to a declared `exports` entry. No `/dist/` or `/src/` specifiers anywhere.

### 2.2 Ranked structural violations

1. **`harness-transcript` ↔ `surfaces/web` bidirectional source coupling.** 39 relative imports escape into the app: `tape.tsx:29-36` (`../../../surfaces/web/src/client/context.js`, `components/ui/button.js`, `shell/code-view.js`, `shell/edit-message.js`, …), plus `session-beats.ts:4-5`, `stage.tsx`, `plugin-progress.ts`. Web dev-depends on transcript; transcript reaches back into web `src`. The "private library bundled into web" (`docs/packages.md`) is structurally a web appendix. Lint rule disabled with an acknowledging comment (`transcript/eslint.config.mjs:11`).
2. **Domain kernel → feature libs** (§2.1). Erodes the L0/L2 purity the rebuild DAG presumes; browser clients transitively pull feature libraries.
3. **SDKs depend on domain/storage, not contract.** Extension entry points are coupled to internals; a provider author transitively installs the document kernel and storage plane.
4. **`turn` fan-in / missing storage edge.** Runtime layer depends on policy + SDK layers; the DAG's N4→N6 edge is absent.
5. **Browser pulls runtime.** `surfaces/web/src/workflow/use-workflow-graph.ts:4` → `harness-scheme/replay` → `scheme-program` barrel → `source.ts:7` `makeFsLoader` from `@here.build/arrival-modules`, whose dist contains `node:fs`/`node:path`. Whether Vite tree-shakes it is **INFERRED** — the static export chain exists.

### 2.3 Browser safety

- `harness-peer`: clean, header-contracted ("No `node:`, no `ws`"), but lints as Node.
- `scope-plane`: `.` entry browser-safe; node code correctly segregated in `./sqlite` (`sqlite-database.ts:29-31` better-sqlite3/drizzle), re-exported type-only from the barrel (`index.ts:30-39`).
- `surfaces/web`: browser entry clean; node imports confined to `server/listen.ts:6-11` behind a separate `./server` export.
- **Enforcement gap:** `internal/eslint-config/index.js:273` defines `import-x/no-nodejs-modules:"warn"` in `browserRelatedRules`, wired into a `browser` config that **no package imports**. web/peer/transcript all use `nodeProject`. Browser node-import lint is effectively unenforced.

### 2.4 Adapter families (duplication)

18 policy adapters = 6 hosts × {base, jev, sage}. **`aider` and `continue` base are byte-identical** (md5 `3e3e7e55…`, 116 LOC each). jev/sage variants are thin shims differing by ~3 lines (aider/continue/pi = 17 LOC). The canonical abstraction exists (`authorize` in `packages-policy/policy/src/index.ts:3` + `EnvCapability`), but the `Judge`/`judgeWith` glue is **re-defined per base adapter** (`aider-auto-mode/src/index.ts:40`, `continue:40`, `crush:26`, …) instead of exported from `policy`. One real abstraction, ~6 copies of glue, 12 near-identical shims; sibling forests (statusline/activity/continuation adapters) are host-API wrappers, not Judge adapters.

### 2.5 Enforcement: mechanical vs documented

Mechanical:
- `scripts/release-check.mjs:66-81` — publishability closure only (private-in-closure, access, files, version, public→private runtime deps). Passes today. No layering/cycle/browser checks.
- `scripts/packed-product.test.mjs` — SDK barrel must not load providers/composition (`:96-108`); testkit door restricted (`:110-123`); single `harness-model` + unique intern tables (`:125-144`); packed bins/exports/assets. **Gap:** `productPackages()` walks only `packages`, `surfaces`, `plugins` (`:43`) — skips `packages-policy`, `packages-runtime`, `env-capabilities`, `extras`.
- ESLint `no-relative-packages:"error"` globally (`internal/eslint-config/index.js:156`) — but OFF for tests and OFF for transcript src.

Documented only: the DAG, SDK→domain prohibition, browser safety, adapter DRY. `docs/package-guidelines.md` itself says the boundary tests "are not a universal clean-install test". Docs also drift from manifests: `docs/packages.md` calls `scope-plane` private (manifest is public); `harness-contract/src/spec/readme.ts:100` claims harness depends on the web app (false).

---

## 3. Isolation boundaries

### 3.1 Boundary inventory

| # | Boundary | Mechanism | Enforcement point | Residual risk |
|---|----------|-----------|-------------------|---------------|
| 1 | Local process → daemon unix socket | **None** — connection accepted, UUID minted, no token/peer-cred check | `harness/src/server/transport/accept.ts:23-42`; bind `server/daemon/server/HTTPServer.ts:104-118`; SDK sends no credential `harness-sdk/src/transport/unix.ts:56` | Any same-user process drives full JSON-RPC incl. approval of its own tool calls. No chmod on socket/root (perms = umask default; cross-user reach **INFERRED**) |
| 2 | Browser → loopback web door | Bind 127.0.0.1; WS-upgrade Origin allowlist; `null` origin refused; rooms whitelist; client `x-harness-remote` stripped | `harness/src/server/listen.ts:70,51-57,95-98,102,117` | HTTP GET `/file` has **no** origin check (`:35-48`); traversal body not read (**INFERRED**) |
| 3 | Remote user → relay → machine | WorkOS JWT + sealed cookie; email allowlist (empty = nobody); tunnel header allow/droplist | `harness-relay/src/allowlist.ts:1-9`, `auth/index.ts:26-49`, `tunnel/server.ts:9,22,53,98-99` | Dev credential path `auth/dev.ts` gating **INFERRED**; machine-side tunnel auth not located (**INFERRED**) |
| 4 | Plugin code → daemon | **In-process** Arrival Scheme interpreter; no VM/process/worker isolation; npm `--ignore-scripts`; capability = bound host procs + `hostAuthority:false`; digest consent | `harness/src/extensions/eval.ts:1,40-60`, `install.ts:110`, `host.ts:4`; tools enter via the same admit door `turn/src/tool-runtime/handler.ts:184-192` | Plugin file jail is **lexical only** (`extensions/jail.ts:3-9`, "Does not follow realpath") → symlink escape (**INFERRED** exploit). A compromised plugin shares daemon memory and credentials |
| 5 | Scheme `require`/`load` → disk | realpath-resolving jail; `..`/absolute handled | `scheme-program/src/source-fs.ts:18-29` | Replay cache returns recorded module text **before** jail check (`:14-17`) — safe only if cache trusted |
| 6 | Scheme `:readonly` | Catalog filter: drops `write_file`, `edit_file`, write-class connection tools **only** | `harness-scheme/src/bound-tools.ts:25-32`; flag plumbing `env.ts:676,923,972` | `shell`, `web_search`, read-class MCP, nested scheme remain → readonly is a hint, not a boundary (docs admit this) |
| 7 | Scheme resource use | Opt-in `timeoutMs`/`maxInternalCalls`; "no host ceiling" | `harness-scheme/src/limits.ts:1-13` | Unbounded CPU/memory by default (DoS) |
| 8 | Tool execution → policy | Scheme policy program (`authorization + risk-margin ≥ risk`), soft-deny judges per cluster; single `admit` door; scheme inner calls reuse it | decision `policy/src/processor.ts:7,57,81,153-165`; classifier `turn/src/policy-processor/classifier.ts:42,84-85,371,465`; guards `unattended-guard.ts:108-114`, `self-protect.ts:4-9`; enforcement `turn/src/tool-runtime/handler.ts:140-192,296-345` | Admit-time snapshot vs later effect (TOCTOU, G3) |
| 9 | Auto-mode adapters | Policy floor first, then LLM vote; vote error → deny; non-allow → block | `openclaw-auto-mode/src/index.ts:181-199,246-257` | Pattern verified for one adapter; others **INFERRED** same shape |
| 10 | Worker/agent isolation | Logical only: disposable worker per `agent/ask`, readonly catalog filter; no spawn/fork/Worker found | `bound-tools.ts:25-32`; `env.ts:923,972` | Same daemon process (**INFERRED**); readonly worker retains shell → full mutation/exfil |
| 11 | MCP output → model/UI | Content verbatim; Mustache escaping **disabled** | `arrival-manifold/src/manifold-tool.ts:394,346-347`; `pretty-mcp/src/render.ts:6,24,83-84` | Prompt injection via text/images; UI XSS if rendered unescaped (**INFERRED**) |
| 12 | Credentials at rest | `secrets.json` in kernel root; never config/Plexus; chmod 0600 **after** write | `harness/src/server/secrets.ts:1-4,18-19,70-80`; `connections/credentials.ts:1-43` | chmod-after-write umask window (**INFERRED**); zero `redact` hits in connections/secrets — log/transcript redaction unverified |
| 13 | File tools → project root | Lexical resolve + realpath re-check; write climbs to existing ancestor, resolves leaf symlink, refuses dangling; extra-root only when licensed | `harness/src/builtin-tools/toolkit/dist-tools.ts:174-194,206-236,242-260` | Licensed escape hatches (`namedBotsAllowed`/`extraRootAllowed` `:178,200-203,212`); door text itself sanctions shell escape (`:160-163`) |

### 3.2 Ranked gaps (code-grounded; none executed)

**G1 — Unauthenticated daemon socket (high).** `accept.ts:23-42` performs no authentication; the socket peer *is* the approval authority, so a rogue same-user process can connect, issue tool RPCs, and approve its own pending asks — no policy bypass needed. Threat model is local same-user (malware, other tools), plus cross-user if umask is permissive (**INFERRED**). Fix direction: `SO_PEERCRED` peer-credential check or a per-daemon token in a 0600 file; explicit socket mode.

**G2 — `:readonly` is not isolation (high).** Verified verbatim: the filter removes only `write_file`/`edit_file`/write-class connection tools. A "readonly" worker retains `shell` (`echo … > file`, `curl` exfil) and read-class MCP. No process separation found. The docs' admission is accurate; the gap is structural — readonly should be enforced at the policy/admit layer, not by catalog projection. Related fail-open: `harness/src/server/daemon/session/agent-runtime.ts:513` — `const parsedInput = tool?.input.parse(args) ?? args;` passes arguments **unvalidated when the tool is unknown** (verified).

**G3 — Approval TOCTOU (high).** `write-admit.ts:1-4` snapshots prior text at admit; effects run later (`handler.ts:184`). File tools partially mitigate by re-resolving realpath at execution (`dist-tools.ts:206-260`), but shell approvals judge text against cwd/symlink state at check time (`peelShellCwd`, `handler.ts:59`); no re-verification hook at effect time was found. Scenario: swap a symlinked target between approval and run (**INFERRED**).

**G4 — Plugin in-process + lexical jail (high).** Behaviors execute inside the daemon (`eval.ts:1`); `hostAuthority:false` is a flag, not an OS boundary. `extensions/jail.ts:3-9` explicitly skips realpath, so a symlink inside a plugin root pointing outside passes `jailedInside` (**INFERRED** exploit). Capability gating is only the bound-proc surface.

**G5 — `/file` GET lacks origin verification (medium).** Origin checked only on WS upgrade (`listen.ts:51-57`); the HTTP handler serves `/file` to any request (`:35-48`). Response readability depends on CORS headers not verified; `fileRoots` confinement (`:18-19,38-41`) is the only stated guard.

**G6 — MCP output fully trusted (medium).** Verbatim forwarding into the model loop + disabled Mustache escaping. A hostile MCP server injects instructions/images straight into context. Readonly filtering of MCP depends on a `class === "write"` label whose assignment site was not located (**INFERRED**): a server declaring a destructive tool as read defeats the filter.

**G7 — Credential file race + no redaction evidence (medium).** `secrets.ts:75-77` writes JSON then chmods 0600 — umask-default window between. No redaction code found in connections/secrets; transcript/log redaction elsewhere unverified.

**G8 — Scheme DoS + replay-cache jail skip (low/medium).** Budgets opt-in with "no host ceiling"; `source-fs.ts:14-17` returns cached module text before the realpath jail.

**G9 — Relay dev-auth / machine tunnel auth unverified (low, INFERRED).** `auth/dev.ts` exists alongside WorkOS; production gating and machine-side bearer check not located. Allowlist itself is sound (empty = nobody).

### 3.3 Verified strengths

File-tool jail genuinely symlink-aware on read and write incl. dangling-leaf refusal; `require` jail resolves symlinks; web door strips client-supplied `x-harness-remote`, binds loopback, refuses `null` origin; auto-mode fail-closed on vote errors; policy self-protect blocks writes to policy files; plugin install `--ignore-scripts`; secrets kept out of config/Plexus by design.

---

## 4. Type strictness and precision

### 4.1 Strictness matrix (137 tsconfig files)

Base `tsconfig.base.json:8-18`: `strict:true`, `skipLibCheck:true`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `isolatedModules`. **Absent everywhere** (exhaustive grep): `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`.

| Group | Delta vs base |
|---|---|
| ~125 package configs | extend base; only `outDir`/`types`/`jsx`/`lib`/`paths` deltas |
| `extras/arrival-manifold/tsconfig.json:10`, `plexus-expectations/tsconfig.json:12` | **add** `noUncheckedIndexedAccess:true` (only two) |
| `internal/tsconfig/purpose/lib.json:16-19` and `purpose/app.json` | **relax**: `noImplicitAny:false`, `noImplicitReturns:false`, `noUnusedLocals:false`, `noUnusedParameters:false` (verified — explicit flags override `strict:true`) |
| Consumers: `packages-runtime/substrate`, `extras/arrival-manifold`, `pretty-mcp`, `tool-call-normalize`, `plexus-expectations` | inherit `noImplicitAny:false`; **none re-enable it** — implicit any is legal in the turn-runtime substrate and the MCP manifold |
| `packages/harness/tsconfig.json:20-24` | excludes `src/policy-processor/__research__` from typecheck |

Tests **are** typechecked via per-package `typecheck` (`tsc -p tsconfig.json --noEmit`), never via build (`tsconfig.build.json` excludes tests). All harness/model `@ts-expect-error`s are deliberate negative-type assertions in tests. `skipLibCheck:true` hides cross-package `.d.ts` mismatches; the repo knows this — `harness-contract/src/schema/rows.ts:1-7` keeps rows Drizzle-free for "`skipLibCheck:false` consumers", and the compile-time identity bridge `schema/sqlite.ts` runs only in `__tests__/schema-contract.test.ts`, not in consumer builds.

### 4.2 Census (non-test; reconciled)

| Package | `as X` casts | explicit `any` | non-null `!.` | zod-loose sites |
|---|---|---|---|---|
| harness | 370 | 2 (both in tests) | 14 | 44 |
| surfaces/web | 266 | 0 | 29 | — |
| harness-model | 185 | 0 | — | 33 |
| model (kernel) | 170 | 25 | 1 | — |
| arrival-manifold | 104 | 0 | 20 | — |
| harness-contract | 24 | 0 | — | 23 |

Explicit `any` is rare and concentrated; the real looseness is **casts, implicit-any presets, and unvalidated parses**.

### 4.3 Cast taxonomy (exemplars, verdicts)

**Laundering (`as unknown as`):**
- `model/src/state.ts:41` (repeated ~20×: 54, 82, 101, 161, 180, 316…) `this as unknown as Linkable` — the class should implement the interface.
- `model/src/state.ts:338,367,414` `obsArr as unknown as TItem[]` — erases MobX observable-array typing at every accessor.
- `model/src/column.ts:90-91` `codec.toModel(raw) as unknown as TActual` — double-cast defeats the codec's own generics.
- **`model/src/column.ts:96` `undefined as unknown as TActual` — unsound: fabricates a value of a non-nullable type** (verified verbatim).
- `model/src/decorator-model.ts:43` `return target as any` — decorator erases the decorated class type.
- `harness/src/server/daemon/session/plugin-abi.ts:194` `call as unknown as Proc["call"]` — Scheme ABI signature laundered.
- `arrival-manifold/src/bind.ts:51` fabricated `TemplateStringsArray`; `:483` symbol-tagging errors via cast (a WeakMap would be typed).

**Boundary casts that should be runtime parses:**
- **`harness-model/src/session/turn/react-chunk.ts:22,29,36`** `JSON.parse(this.notesJson) as RoundContextNote[]` / `as RoundDecision` / `as IntentAssessment` — **DB JSON columns enter the typed core unvalidated** (verified).
- `harness/src/server/daemon/kernel/remote-connector.ts:289` `JSON.parse(raw) as ControlFrame` + ad-hoc typeof guards — wire frame, should be zod.
- `harness/src/extensions/state-store.ts:51` `JSON.parse(text) as {log?:unknown}` — persisted state trusted.
- `surfaces/web/src/shell/syntax-wasm.ts:194,223,248` — WASM bridge output trusted.
- `harness-client/src/client.ts:39` `createORPCClient(link) as HarnessClient` — documented trust cast ("daemon validates both"); acceptable but unverified client-side.

**Legitimate:** polyfill identity casts (`request-timeout.ts:21`), dynamic-import interop (`elk.ts:20`), and the **correct pattern** at `harness/src/hypervisor/child-runtime.ts:205`: `supervisionIdentitySchema.parse(JSON.parse(raw) as unknown)`.

### 4.4 Zod looseness and boundary totality

- **Contract (23 sites):** envelope `z.unknown()` for JSON-RPC params/result (`schemas/rpc.ts:41,48,62`) is fine — per-procedure schemas validate. But `uiParkSchema`/`uiFormSchema` are `.passthrough()` (`rpc.ts:19,27`), one procedure output is wholly loose (`contract.ts:415`), settings/authorization are open records (`schemas/connection.ts:19`, `shapes.ts:140,154,205,228`).
- **Harness (44):** worst is `server/schemas/well-known.ts:10-25` (verified): `secrets/tools/toolSeverity/alwaysAllow: z.unknown()` + `.catchall(z.unknown())`, then a transform merges them into the connection `settings` bag — **unvalidated config flows into the daemon core**. Also `extensions/schemas/plugin-manifest.ts:81-91` (name/version unknown + passthrough), MCP passthroughs (`providers/mcp/schemas/mcp.ts:10,53,73`).
- **Harness-model (33):** tool-input schemas deliberately loose (`schemas/web-search.ts:9-14`, `web-extract.ts:11-17`, `update-metadata.ts:5-8`, scheme-repl, tool-outcome, agent-call).
- **Totality: partial.** Envelope parse is total (`harness-client/src/link.ts:98-102`); per-procedure validation delegated to daemon. But `agent-runtime.ts:513` fails open for unknown tools, and react-chunk/remote-connector/state-store bypass zod entirely. **Unvalidated data does reach the typed core.**
- **`schema/` vs `schemas/` in harness-contract is NOT legacy duplication:** `schema/` = storage (pure-TS rows, lane frames, patches, Drizzle sqlite/postgres dual dialects), `schemas/` = zod RPC/domain; `contract.ts:4-7` imports only `schemas/`. Both exported (`index.ts:1-11`). The near-identical names are a clarity hazard, not a normalization defect.

### 4.5 Precision gaps

- **IDs: plain strings, no brands.** `sessionId: z.string().trim().min(1)` (`shapes.ts:72`), `Model.uuid: string` (`model.ts:24`), `id: string` (`rows.ts:10`). Paths get one template literal `` `/${string}` `` (`contract.ts:39-41`). Cross-entity ID swaps are type-legal today.
- **Statuses: good** — `z.enum` unions and `as const` arrays, no TS enums. `HarnessHost` includes `"any"` (`contract.ts:15`), a stringly overlap.
- **Optionals: mixed.** Contract: 161 `.optional()` vs 20 `.nullable()`; types `|null` 16× vs `|undefined` 1×; `mayPark?: true` absent-only. Same file disagrees with itself: `endedAtMs: number|null` (`rows.ts:115`) vs `endedAtMs?: number|null` (`:127`). With `exactOptionalPropertyTypes` off, `{x?:T}` silently accepts explicit `undefined` at all 161 sites.
- **Errors:** `ErrorWithInvariant` gives `asserts condition` with typed overloads but `...args:any[]` in the first overload (`error-with-invariant/src/index.ts:9,13,24`). Catch typing clean (`useUnknownInCatchVariables` via strict; zero `catch(e:any)` non-test).
- **Generic kernel (`packages/model`): strong static shell, untyped dynamic core.** `AssertModelMatchesTable` (`types.ts:60-75`) maps column/model mismatches to `__error` objects; tests prove static rejection. But the runtime path is any-riddled: `Model<TRow=any,TParent=any>` (`model.ts:20`), `get plexus():any` (`:64`), `(this as any)[col.propertyKey]` in applyRow/toRow (`:77-90`), `serialize.ts:327-350` patches via `(instance as any)[key]`. The 25 `any`s concentrate exactly in the reflective paths.

### 4.6 Recommendations (types)

1. Re-enable `noImplicitAny` in `internal/tsconfig/purpose/{lib,app}.json`; fix fallout in substrate dispatch and manifold bind code.
2. Add zod parses at `react-chunk.ts:22-36`, `remote-connector.ts:289`, `state-store.ts:51`, `syntax-wasm.ts`; validate the `well-known.ts` settings bag; make `agent-runtime.ts:513` fail closed on unknown tools.
3. Type the kernel's dynamic core: class implements `Linkable`; column getters `T|undefined` (fixes `column.ts:96`); generic decorator return; typed patch application.
4. Flags: `noUncheckedIndexedAccess` in base (manifold/plexus already comply; the 14/29 non-null assertions mark hot spots); `exactOptionalPropertyTypes` starting in harness-contract (normalize `endedAtMs` first); `noImplicitOverride` + `verbatimModuleSyntax` (cheap).
5. Brands: `SessionId/ProjectId/TurnId/JobId/ConnectionId/ModelId`, `MsTimestamp`, `AbsPath` via `z.string().brand()` in contract, propagated through rows/shapes/`Model.uuid`.
6. Hygiene: rename `schema/`→`storage/` (or `schemas/`→`rpc/`); run the sqlite identity bridge in CI typecheck, not only tests; consider `skipLibCheck:false` for harness-contract.

---

## 5. Data-representation normalization

Intended canonical design (repo's own docs): `02-node-2-schema-and-wire-contract.md` §2 — Drizzle `sqlite.ts` is the single source of truth, rows mirror types; `05-node-5-harness-domain-models.md` §2-4 — domain classes bind `@column` directly to contract tables, `SessionDocument` replaces `SessionPlexus`, zero yjs/plexus. **Yjs is already gone** (grep empty); the migration is partially executed. What remains:

### 5.1 Concept → representations

| Concept | Representations | Canonical | Drift |
|---|---|---|---|
| **Session** | wire `sessionsTable` `contract/schema/sqlite.ts:54-79`; `SessionRow`/`SessionSummaryRow` `schema/rows.ts:47-81`; `SessionSummaryRecord` `harness-model/records.ts:29-49`; live `SessionRoot` `session/SessionRoot.ts:71-263`; `SessionOverview`/`SessionGlance` `kernel/SessionOverview.ts:22-110`; sync `overviews`+`roster` `scope-plane/schema.ts:63-84,118-133`; web `LiveShape<SessionSummaryRow>` `dial.ts:97-100` | `sessionsTable` per doc 02 | **Verified:** `SessionRoot.path` (`:179`) vs `workspacePath`; `mode: string = "act"` (`:180`) vs wire enum `assistant\|agentic` (`sqlite.ts:60-62`); `standingPermissionMode:"manual"` (`:186`) vs wire default `"ask"` (`:63`); `manualTitle` vs `title`; no createdAtMs/revision on root. `SessionRoot` still `@modelDecorator`+`@state`, not `@column` |
| **Permission mode** | domain `["manual","auto","yolo"]` `shared/permission-mode.ts:2`; wire default `"ask"` `sqlite.ts:35,63`; `SessionTurn.permissionMode` `session-turn.ts:132`; `rows.ts:52` bare `string` | domain union | **Verified:** `parsePermissionMode("ask") → null` (`:10-13`); mint falls back to `"manual"`. Wire default is dead/invalid vocabulary; comment lists `plan`/`act`/`always-approve` as legacy→null |
| **Project** | `ProjectRoot` `kernel/ProjectRoot.ts:11,39-47`; sync `scopes`+`config` `scope-plane/schema.ts:87-116`; `projectScopeId()` `contract/schema/keys.ts:1-5` | scopeId `project:<path>` | Fields split across two sync tables; `ProjectRoot` lacks `parentId`/`revision`; path-as-identity vs scopeId |
| **Turn** | `sessionTurnsTable` `sqlite.ts:97-113`; `SessionTurnRow`+status `rows.ts:104-116`; `SessionTurnRecord` `records.ts:66-80`; live `SessionTurn extends SequenceJob` `session-turn.ts:82-181` | table per doc 05 | Live turn has no status/ordinal/startedAtMs columns; uses `reducerExited`/`cancelRequested`/`broke` flags + chunk lists; `prompt: UserPrompt` vs `prompt: string`. Status union triplicated (identical today) |
| **Round / message** | `ReACTChunk` `react-chunk.ts:12`; `RoundDecision`/`RoundGate` `round-decision.ts:2-42`; runtime `round-boundary.ts`/`round-stop.ts`; `PromptMessage` `expectations/PromptMessage.ts:9-24`; OpenAI-style `MessageInput` `tool-call-normalize/types.ts:99` | none on wire | Rounds live in `snapshotJson` (**INFERRED** boundary); `content`+`contentBlobJson` vs normalize `content` string |
| **Tool call** | OpenAI `ToolCall` `tool-call-normalize/types.ts:4-8`; `ToolCallJobProps`/`outcomeJson` `jobs/ToolCallJob.ts:25-31,76`; `AdmittedCall` `turn/tool-runtime/handler.ts:215`; `agentCallFromWire` `:237` | normalize IR | string-arguments vs object args; fold `assembleEvents` is the bridge |
| **Tool result** | `ToolOutcomeSnap` `schemas/tool-outcome.ts:3-17`; `RenderOk/RenderFail` `pretty-mcp/render.ts:154-158`; `stampToolOutcome(text:"denied"\|"cancelled")` `turn/tool-runtime/approval/approved.ts:9` | `ToolOutcomeSnap` | **Three envelopes**; `code` open-ended; legacy denials stored only in `text` (`tool-outcome.ts:6`) |
| **Approval / policy decision** | `Disposition` 4-value `policy/types.ts:10`; `LicenseDetail{decision:boolean\|null,code}` `jobs/ApprovableJob.ts:55-61,354-437`; wire grants/`CLASS_IDS` `contract/schemas/authorization.ts:11-70`; `pendingAsksTable kind ask\|ack` `sqlite.ts:81-95`; `UiDefinition` 6 kinds `schemas/rpc.ts:90-145` | policy `Disposition` | 4-value union → tri-state boolean+code → ask/ack rows → 6 UI kinds; stored aliases `approve`/`allow`; wire tier `"soft-deny"` vs engine `"deny"`; **`CLASS_IDS` duplicated** (`policy/classes.ts:10` vs `authorization.ts:11`), pinned only by a test |
| **Policy processor** | `turn/src/policy-processor/` (16 files) vs `harness/src/policy-processor/` (5 files) | unclear | **Verified:** harness `index.ts` is a pure type re-export of `turn/policy`, but `explain/license/peel-cwd/scope` exist as local files in **both** trees |
| **Connection** | wire `ConnectionStatus` 6 values `schemas/connection.ts:3-20`; `ConnectionSpec` `plexus-expectations/shared/models/ConnectionSpec.ts:22-41` with `ReadyState` 4 values `shared/types.ts:9` | wire row | `null\|bootstrapping\|ready\|failed` vs `idle\|connecting\|ready\|needs-auth\|failed\|disabled`; spec lacks enabled/toolCount/abilityClaim; `configurationMap Record<string,string>` vs structured `ConfigurationValue` vs untyped wire `settings` |
| **Model id** | `defaultModel` `rows.ts:11`; `SessionOverview.model`; `lastUsedConnectionModel` `SessionRoot.ts:85`; sync `lastUsedModel`/`modelUsage`; `connectModelsRow.models:string[]` | none | Plain strings everywhere; `connection/model` convention unbranded |
| **Job / expectation** | `JobResolution fulfilled\|rejected` `plexus Job.ts:18-19`; `JobKind` 4 values `:21`; state flags `orchestrationResult/cancelled/completed/crash` `:38-48`; 22 job classes `harness-model/session/jobs/`; wire `sessionEffects kind commit\|command\|effect, phase intent\|result\|committed` `rows.ts:150-160` | none | **Job status = 5 independent flags, not an enum**; 4 JobKinds vs 22 subclasses vs 3 effect kinds |
| **Reasoning effort** | `harness-model/reasoning-effort.ts:5`; `contract/schemas/shapes.ts:9` (comment: "Mirrors plugin-sdk… Inlined"); `plugin-sdk/schemas/plugin.ts:152`; `providers/openai-compat/reasoning-flavor.ts:11,37`; `model-capabilities.ts:9-15` | none | **Five copies** of the same 7-value list (two verified verbatim); identical today, pinned by tests; per-provider clamps |
| **Token usage** | `CompletionExpectation.totalTokens/inputTokens/outputTokens` `:157-163`; ledger `openai-compat/actor.ts:1136-1142`; sync `modelUsage` `schema.ts:158-160` | expectation fields | No contract-level usage schema; input/output vs prompt/completion naming |
| **IDs / keys** | `rowPairId` JSON-tuple keys + `splitRowPairId` `keys.ts:11-33`; `projectScopeId`; prompt brand `harness-commons/prompt.ts:2`; roster `UNIQUE(scope_id,name)` | keys.ts | No branded entity IDs; composite keys are JSON strings; roster identity name-based |
| **Timestamps** | epoch-ms integers throughout rows/sqlite; display-only ISO in `permissions-view.ts:112` | epoch ms | **Largely normalized** ✅ (nullability inconsistency in `rows.ts` noted §4.5) |

### 5.2 Ranked misalignments (blast radius)

1. **Session has two misaligned bodies** — every daemon↔client session path crosses the `SessionRoot`↔`sessionsTable` seam (field names, mode vocabulary, permission vocabulary, title). Doc 05 mandates `@column` binding; not done. `SessionPlexus.ts`/`KernelPlexus.ts`/`ProjectPlexus.ts` still exist (doc 05 §4 says delete; `SessionPlexus` is now an alias of `SessionDocument`, but the file/name persists).
2. **Permission-mode vocabulary split** — wire default `"ask"` is outside the domain union and parses to null. Affects kernel, session, project, and turn defaults. This is a live bug class, not just aesthetics.
3. **Policy decision ladder + duplicated taxonomy** — four hand-maintained shapes; `CLASS_IDS` twice; two policy-processor trees with four same-named modules.
4. **Connection status/config drift** — 4-state vs 6-state; three configuration representations; no mapping function found (**INFERRED** ad-hoc assembly).
5. **Job status flag soup** — independent booleans + crash string, misaligned with `SessionTurnStatus` and `JobResolution`.
6. **Three tool-result envelopes** + string-vs-object args; legacy text-only denials.
7. **`SessionOverview.status` is a free string** (`SessionOverview.ts:44`) mirrored into 20 hand-written sync columns (`scope-plane/schema.ts:63-84`) — no enum, no generated mirror.
8. **Reasoning effort: five copies** — aligned today, five drift points tomorrow.
9. **Token usage has no wire schema.**
10. **IDs unbranded**; JSON-tuple composite keys; name-based roster identity.
11. Positive: timestamps normalized; turn-status copies currently identical.

### 5.3 Normalization plan (target: one canonical shape per concept, everything else generated or a typed projection)

- **Session/turn/project — SSOT: contract Drizzle tables.** Finish doc 05: rebind `SessionRoot`/`SessionTurn` via `@column(sessionsTable.*)`; generate `rows.ts` from Drizzle `$inferSelect` instead of hand-mirroring; derive scope-plane `overviewColumns` from the shared definition; delete the Plexus files and the free-string `SessionOverview.status` (replace with a derived projection of `running` + `SessionTurnStatus` + pending asks); migrate `mode:"act"` → `assistant|agentic`.
- **Permission mode:** one zod enum in contract; domain re-exports; change wire default `"ask"` → `"manual"` (or add `"ask"` to the union — pick one, generate the rest).
- **Policy:** `Disposition` + `CLASS_IDS` live only in `packages-policy/policy`; generate `authorization.ts` enums (delete the test-pinned copy); one `ApprovalDecision` zod schema deriving `LicenseDetail`, `pending_asks.kind`, and UI ask mapping; collapse the two policy-processor trees into `turn` (harness re-exports).
- **Connections:** wire `ConnectionStatus` canonical; `ReadyState` becomes a projection; type `configurationMap` with `ConfigurationValue`; generate `connectionListRowSchema` from spec columns.
- **Jobs:** one `JobStatus` enum aligned to `SessionTurnStatus`; generate `JobKind` from the job-class registry; `JobResolution` stays settlement-only.
- **Tool calls/results:** normalize `ToolCall` is wire canonical; `ToolOutcomeSnap` the single result envelope; pretty-mcp `RenderResult` becomes a view; migrate text-only denials into `refusalReason`.
- **Reasoning effort/usage:** one `REASONING_EFFORTS` in contract, re-exported everywhere (delete 4 copies); add a contract `TokenUsage` schema deriving expectation fields + `modelUsage` columns.
- **IDs:** branded types in contract `keys.ts`; keep epoch-ms (already true); brand `rowPairId` output.
- **General rule:** the repo already uses the right pattern in miniature — test-pinned mirrored lists (reasoning effort, `CLASS_IDS`) and the sqlite identity bridge. Promote that pattern from "tests catch drift" to "drift cannot compile": generate, don't mirror.

---

## 6. Runtime state, sync, lifecycle coherence

### 6.1 State flow

```
Daemon RPC commands → turn session-runtime (turn/src/session-runtime/runtime.ts)
→ SessionDocument extends DocumentContainer (harness-model/session/SessionPlexus.ts:27-68; model/container.ts:62)
  — mobx, single revision counter + #dirtyNodeRevisions
→ serialize rows-v1 (model/serialize.ts:150-167) → sqlite session_nodes (scope-plane/sqlite-database.ts)
→ lane-server.ts:18-35 (7 update lanes) → harness-peer provider.ts:256-260 shape/delta
→ web: dial.ts:83-100 mobx observables + LiveShape replicas; SessionPlexus per session (dial.ts:75,87)
→ tui: harness-sdk Client (RPC only; no scope-plane import)
scope-plane plane.ts commitScope CAS → tinybase (hermetic) OR electric (Postgres+Electric)
```

**Authority model: single-writer daemon by convention, not enforcement.** Verified: `SessionPlexus.connect` accepts `readOnly?: boolean` (`SessionPlexus.ts:130`) and never reads it; `container.ts` has no readOnly guard. Client-held session documents are fully writable mobx state. Merge semantics: per-row LWW, no field merge, no vector clocks; `commitNodeDelta` clears dirty only if `dirtyRev <= delta.revision` (`container.ts:388-408`); **reset clears all dirty tracking and takes `Math.max` revision** (`:724-728`, verified). `commitScope` uses CAS retry (`plane.ts:396-434`); electric `replaceIf` is atomic, but **`put` is unconditional `ON CONFLICT DO UPDATE`** (`electric/index.ts:81-87`, verified).

### 6.2 Ranked desync risks

1. **Writable client replicas + LWW reset (HIGH).** Two tabs hold writable SessionPlexus; a reconnect reset silently clobbers uncommitted local edits. No conflict surface exists.
2. **LiveShape partial-message merge (HIGH, partly INFERRED).** `live-shape.ts:326,345` shallow-merges `msg.value` onto `prev`; after a `must-refetch` buffer reset, a partial update with no `prev` becomes a full row, dropping fields. `postgres.ts:1-5` sets REPLICA IDENTITY FULL, suggesting awareness of the hazard.
3. **Electric `put` LWW without CAS (MEDIUM).** Only `replaceIf` callers get fencing; non-scope tables race under two writers.
4. **Provider offset resume across daemon restart (MEDIUM, INFERRED).** `provider.ts:101,224,256` resumes at `#nodeLaneOffset`; server-side offset semantics after restart unverified.
5. **Tinybase flush durability (MEDIUM).** "Atomic rename, not an fsync guarantee" (`tinybase/index.ts:24-26`) — fine for hermetic local plane, dangerous if reused as daemon store.
6. **JSON-face read-after-write lag (LOW, documented).** `json-record.ts:60-63`: set+get in one mobx action sees the previous parse.

### 6.3 Lifecycle, serialization, conventions

- **Turn lifecycle: coherent.** `docs/react-round-lifecycle.md` matches implementation (round-decision causes/gates, `REPAIR_ATTEMPTS=4`, THOUGHT=8/INTENT=2 budgets, `madeProgress` reset semantics, iterator ordering). Durability is well-fenced: `SessionCheckpoint` carries `incarnation` + fromRevision/revision (`durability.ts:17-31`); restart stamps "interrupted by restart; execution outcome unknown"; existing attempts never replayed; tests exercise fencing (`runtime.test.ts:468,658`).
- **Second durability format:** substrate persists Scheme teaching-state as one JSON blob per session (`session-store.ts:1-11`), last-wins replay, **no checkpoint/incarnation discipline** (INFERRED).
- **Serialization:** `rows-v1` tag, legacy embedded-tree still hydrated; **no numeric schema version, no migration hook in model**; migrations live in storage (`sqlite-migration.ts:21-35`). `record` state shallow-copied (nested structure shared); **no Date/Map/Set codecs** — lossy for any field holding them (INFERRED actual usage).
- **Conventions are minority-adopted:** `error-with-invariant` imported by only 10 files; the daemon uses tiny-invariant instead (245 calls). `DisposableClass` guard: 7 non-test adopters in an 85k-LOC daemon; guard is opt-in per method and must be re-applied on overrides. Async disposal concentrated in CLI/SDK, not the long-lived core.
- **Tests:** good coverage of sync planes, peer frames, durability fencing, packed restore. **Gaps:** no LiveShape reconnect/refetch test; no peer two-client/conflict/reconnect cases; no electric offset-resume test; no client read-only enforcement test (it doesn't exist); no Date/Map/Set round-trip test. Root vitest includes only substrate of packages-runtime; turbo.json declares no `test:visual`/`test:session-runtime` tasks despite root scripts invoking them.
- **Dead/duplicate:** `__research__` dirs excluded from gates; `harness/src/session/index.ts` is a 53-line compat re-export of turn/session; no feature-flag forks.

---

## 7. Prioritized remediation roadmap

**P0 — correctness & security seams**
1. Authenticate the daemon socket (peer-cred or 0600 token) + explicit socket mode (§3 G1).
2. Enforce `:readonly` at the admit/policy layer, or rename it to honest "no-file-writes" semantics; fail closed on unknown-tool input (`agent-runtime.ts:513`) (§3 G2).
3. Unify permission-mode vocabulary; fix wire default `"ask"` (§5.2 #2) — live bug class.
4. Parse at persistence/wire seams: `react-chunk.ts` JSON columns, `ControlFrame`, `state-store`, `well-known.ts` settings bag (§4.4).
5. Decide the client-replica authority model: enforce read-only or document single-writer; add the missing reconnect/conflict tests (§6.2).

**P1 — normalization (finish the stated rebuild)**
6. Session/turn/project `@column` binding to contract tables; generate rows + sync mirrors; delete Plexus remnants; migrate `mode:"act"` (§5.3).
7. Single policy taxonomy + one ApprovalDecision schema; collapse policy-processor trees (§5.3).
8. Connection status projection; JobStatus enum; single tool-outcome envelope; one REASONING_EFFORTS; TokenUsage wire schema (§5.3).
9. Branded IDs/timestamps/paths in contract (§4.6 #5).

**P2 — structural & type hygiene**
10. Re-enable `noImplicitAny` in purpose presets; progressive `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; type the model kernel's dynamic core (§4.6).
11. Resolve transcript↔web inversion (extract shared views or accept appendix status and rename); remove kernel→feature imports; wire the browser eslint config; extend packed-product to all forests (§2).
12. Shared adapter-core for `judgeWith`; dedupe aider≡continue (§2.4).
13. Serialization versioning + non-JSON codecs; pick one invariant convention; raise DisposableClass adoption in the daemon core (§6.3).
14. Plugin jail: realpath resolution; consider process isolation for plugins/workers long-term (§3 G4).

---

## 8. What is already right (keep)

Zero cycles; zero deep imports; exports discipline exact; pure L0 kernel; scope-plane node segregation; loopback + origin checks + remote-header stripping on the web door; symlink-aware file-tool and require jails; fail-closed auto-mode; policy self-protection; secrets out of config/Plexus; epoch-ms timestamps everywhere; coherent fenced turn lifecycle with durability tests; zod envelope parse total at the client link; the test-pinned-mirror and identity-bridge patterns (promote them to generation).

## 9. Follow-ups (INFERRED items worth proving)

- `/file` GET traversal body + CORS headers (`listen.ts:35-48`).
- Relay: `auth/dev.ts` production gating; machine-side tunnel bearer check; who sets `x-harness-remote=1` on the relay→daemon hop.
- Socket file mode under default umask (cross-user reachability).
- Plugin jail symlink escape (construct a proof in a test, don't ship an exploit).
- MCP `class:"write"` assignment site; transcript/log credential redaction.
- LiveShape partial-value behavior under Electric; provider offset semantics across daemon restart.
- Worker process model (in-process confirmation); `snapshotJson` round/message wire boundary.
- Date/Map/Set usage in domain record fields (serialization lossiness scope).