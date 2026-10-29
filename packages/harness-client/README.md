# `@inhuman.tools/harness-client`

Typed client for the inhuman harness daemon, generated from
[`@inhuman.tools/harness-contract`](https://www.npmjs.com/package/@inhuman.tools/harness-contract).
It works over any transport that implements the four-member `Transport` interface.

```sh
npm install @inhuman.tools/harness-client
npm install ws   # only for the Node entry point
```

## Node, over the daemon's unix socket

```ts
import { createHarnessClient } from "@inhuman.tools/harness-client";
import { connectUnixSocket } from "@inhuman.tools/harness-client/node";

const transport = await connectUnixSocket({
  socketPath: "<kernel>/daemon.sock",
  target: { host: "session", sessionId },
});
const client = createHarnessClient({ transport, onPark: (form) => ui.answer(form) });
await client.session.kv.set({ key: "model", value: "m", scope: "session" });
```

## Browser or React Native

Use `connectWebSocket(url)` from the main entry. `harnessUpgradePath(target)`
builds the path part of the URL.

## Notes

- A method that can park returns a UI form instead of its result. `onPark`
  receives it; see the contract's spec for `ui/resolve`.
- Aborting a call with an `AbortSignal` rejects locally. There is no wire
  cancel, so the daemon keeps working on it.

The full wire description is in the
[contract spec](https://github.com/here-build/inhuman-harness/tree/main/packages/harness-contract/spec).

MIT
