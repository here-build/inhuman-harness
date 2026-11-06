import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  admitSteer,
  CommandSpec,
  CompletionExpectation,
  SessionSystemPrompt,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { formatShellCommandReady } from "@inhuman.tools/harness-sdk/text";
import { reportRole } from "@inhuman.tools/plexus-expectations";
import { bootSyntax } from "@inhuman.tools/quickdraw/widgets";
import { beforeAll, test } from "vitest";

import { approveLaw } from "./approve.js";
import {
  localClient,
  openTea,
  press,
  PRIOR_PROMPT,
  seedConversation,
  seatTurn,
  typeText,
  waitDump,
  wrapTurn,
} from "../__visual__/_helpers.js";

// The speech line must not contain the command, or the law matches the prompt.
const SHELL_PROMPT = "Show me what's still dirty in the TUI.";
const LIVE_THOUGHT = "The 401 is the old hash, not the session cookie.";
const LIVE_PARTIAL = "AuthForm still reads AUTH_SECRET from the module\nscope. I'll move the lookup into";
const QUEUE_DRAFT = "Should /logout clear the session cookie too?";
const QUEUE_ROW = prompt.user`Also rotate the cookie name on logout.`;
const STEER_ROW = prompt.user`Keep AUTH_SECRET out of the module scope.`;

beforeAll(async () => {
  await bootSyntax("dark");
  await formatShellCommandReady("git status --short");
});

test("overlay placeholder", async () => {
  const client = localClient();
  client.request = async (method) => {
    if (method === "connect/adopt" || method === "connect/login") {
      return { form: "ui", pending: "p2", body: '(harness/input :name "Base URL")' };
    }
    return { ok: true };
  };
  client.kernelRoot.commands = {
    go: new CommandSpec({
      verb: "go",
      body: `(harness/choice :choices (list
               (harness/choice :name "row"
                 :action (list (harness/action 'connect/adopt :params (dict :driver "local"))))))`,
    }),
  };
  seedConversation(client);
  using ui = openTea(client);
  typeText(ui.tea, "/go");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "row"));
  press(ui.tea, "Enter");
  await waitDump(ui.dump, (frame) => frame.composer.placeholder.includes("Base URL"));
  await approveLaw("overlay-base-url", ui.tea, {
    runs: [{ text: "Base URL", role: "muted", ink: "ghost", dim: false }],
  });
});

test("shell ask stack", async () => {
  const leaf = new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    argsJson: '{"command":"git status --short"}',
    policyResult: "ask",
  });
  const client = localClient();
  client.sessionRoot.head = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: SHELL_PROMPT,
    doneWork: [leaf],
    queue: [],
  });
  client.kernelRoot.approvalAskThrottleMs = 0;
  using ui = openTea(client);
  await approveLaw("shell-ask", ui.tea, {
    runs: [{ text: "git status --short" }, { text: "run command" }],
  });
});

test("numbered queue", async () => {
  const client = localClient();
  const completion = new CompletionExpectation({
    promptText: PRIOR_PROMPT,
    connectionId: "c",
  });
  const turn = wrapTurn(completion);
  client.sessionRoot.head = turn;
  const hub = completion.awareness;
  if (hub === null) throw new Error("completion has no awareness");
  reportRole(hub, completion.uuid, { text: LIVE_PARTIAL, thought: LIVE_THOUGHT });
  using ui = openTea(client);
  typeText(ui.tea, QUEUE_DRAFT);
  admitSteer(client.sessionRoot, STEER_ROW, turn.uuid);
  admitQueue(client.sessionRoot, QUEUE_ROW, turn.uuid);
  press(ui.tea, "Escape");
  press(ui.tea, "Escape");
  await approveLaw("steer-queue", ui.tea, {
    runs: [{ text: QUEUE_ROW }],
  });
});

test("slash hover commits", async () => {
  const client = localClient();
  client.kernelRoot.commands = {
    connect: new CommandSpec({
      verb: "connect",
      description: "Manage provider connections",
      source: "connect.scm",
      body: "",
    }),
    model: new CommandSpec({
      verb: "model",
      description: "Session model",
      source: "model.scm",
      body: "",
    }),
    compact: new CommandSpec({ verb: "compact", description: "plugin shadow" }),
  };
  seedConversation(client);
  using ui = openTea(client);
  press(ui.tea, "/");
  await waitDump(
    ui.dump,
    (frame) =>
      frame.composer.picker.rows.some((row) => row.name === "/connect") &&
      frame.composer.picker.rows.some((row) => row.name === "/compact") &&
      frame.composer.picker.rows.some((row) => row.name === "/new") &&
      frame.composer.picker.rows.some((row) => row.name === "/quit") &&
      frame.composer.picker.rows.some((row) => row.name === "/agentic") &&
      frame.composer.picker.rows.some((row) => row.name === "/background") &&
      frame.composer.picker.rows.some((row) => row.name === "/rewind"),
  );
  await approveLaw("slash-catalog", ui.tea, {
    runs: [{ text: "/connect" }],
  });
});

// The cell of the row is not known until the dump can name hits.
test.todo("slash click posts activate");
