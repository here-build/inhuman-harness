# Layer 5.1 (Node 10): iOS Mobile App Migration (`branch: ios-app-wip`)

**DAG Position**: Layer 5.1 (Depends on Node 5 `@inhuman.tools/harness-model` and Node 8 Web/Client `Dial` & `harness-transcript`)  
**Target Branch & Package**: `ios-app-wip` $\rightarrow$ `packages/harness-ios-app` (`@inhuman.tools/harness-ios-app`)

---

## 1. Current Architecture on `ios-app-wip`

In `packages/harness-ios-app` (React Native 0.87 + native Swift/Obj-C bridge in `ios/Inhuman/`):
1. **Dependencies (`package.json`)**: Depends on `@here.build/plexus`, `yjs`, `y-websocket`, `@inhuman.tools/harness-model`, and `@inhuman.tools/harness-transcript`.
2. **Connection & Sync (`src/dial-context.tsx`, `src/daemon.tsx`)**: Wraps the app in `DialProvider` using `Dial` from `../../harness-web-app/src/client/dial.js`.
3. **Device Persistence (`src/doc-cache.ts`, `src/doc-log.ts`, `src/host.ts`, `ios/Inhuman/HarnessHost.m`)**:
   - `deviceDocCache()` implements `DocCache` by encoding Yjs `Uint8Array` updates into length-prefixed binary records (`doc-log.ts`), base64-encoding them, and calling the native iOS bridge (`native.read(key)`, `native.append(key, b64)`, `native.replace(key, b64)`, `native.drop(key)`).
4. **Screens & Lists (`src/roster.tsx`, `src/sessions.tsx`, `src/projects.tsx`, `src/session.tsx`, `src/transcript.tsx`, `src/attention.ts`, `src/bell.tsx`)**:
   - Native navigation stacks (`react-navigation/native-stack`, `ios/Inhuman/HarnessViews.swift`) observe `KernelRoot` and `SessionRoot` via `mobx-react-lite` to render the project/session lists, attention bells, and session transcript.

---

## 2. Migration Plan for `packages/harness-ios-app`

### 2.1 Native Device Cache Simplification (`src/doc-cache.ts`, `src/doc-log.ts`, `ios/Inhuman/HarnessHost.m`)
- **Delete `src/doc-log.ts`**: We no longer append binary Yjs `Uint8Array` update frames or base64-encode length-prefixed byte streams on every token.
- **Update `src/doc-cache.ts`**:
  - Stores UTF-8 JSON snapshots keyed by `session:${sessionId}` (`{ revision: number, snapshot: SerializedSessionDocument }`) and `roster:recent` (cached `SessionSummaryRecord[]` rows for instant cold launch when offline or reconnecting).
  - Uses `native.read(key)`, `native.replace(key, jsonString)`, and `native.drop(key)` on the existing `HarnessHost.m` bridge (removing the need for `native.append` and binary log compaction).

### 2.2 Roster, Projects & Attention Screens (`src/roster.tsx`, `src/sessions.tsx`, `src/projects.tsx`, `src/attention.ts`, `src/bell.tsx`)
- Replace `KernelRoot` full-document iteration with the `LiveShape` lanes exposed by the updated `Dial` (Node 8):
  - `dial.activeSessions` and `dial.recentSessions(50)` drive `sessions.tsx`, `roster.tsx`, and `projects.tsx`.
  - `dial.pendingAsks` drives `attention.ts` and `bell.tsx` (eliminating the need to hydrate every running `SessionPlexus` on the phone just to check if a session is waiting for an `ask`/`ack` approval!).

### 2.3 Active Session & Transcript View (`src/session.tsx`, `src/transcript.tsx`, `src/composer.tsx`)
- `dial.attachSession(sessionId)` returns the `SessionDocument`-backed handle.
- If the phone backgrounds and reconnects, `dial.attachSession` sends `sinceRevision: doc.revision`, catching up via lightweight JSON patches over the single WebSocket without re-downloading the full session or performing Yjs state-vector merges on the mobile CPU.

### 2.4 Dependency Cleanup (`packages/harness-ios-app/package.json`)
- **Remove**: `@here.build/plexus`, `yjs`, `y-websocket`.
- **Add**: `@inhuman.tools/model: "workspace:^"`.

---

## 3. Verification Criteria for Layer 5.1 (Node 10)

- [ ] `packages/harness-ios-app` builds cleanly in Metro and Xcode with zero `yjs`, `y-websocket`, or `@here.build/plexus` imports.
- [ ] Cold launch on iOS renders cached session roster immediately from `HarnessHost` storage and syncs `active_sessions`, `recent_sessions`, and `pending_asks` over a single WebSocket.
- [ ] Backgrounding and foregrounding the iOS app during a streaming turn resumes seamlessly from `sinceRevision` with zero duplicate or dropped messages.
- [ ] All unit tests in `packages/harness-ios-app` (`directory.test.ts`, `drafts.test.ts`, cache tests) pass.
