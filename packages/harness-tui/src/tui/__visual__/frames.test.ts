/** Visual goldens: SessionRoot → Tea → assemblePaintFrame → cell rows. */
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  admitSteer,
  AgentCallJob,
  AgentCallNotification,
  BotCallJob,
  CommandSpec,
  CompletionExpectation,
  KernelAgentRelation,
  ProgrammaticJob,
  publishKernelSeat,
  SessionOverview,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { ConnectionSpec, DriverSpec, reportRole } from "@inhuman.tools/plexus-expectations";
import { expect, test } from "vitest";

import { askCoverShortcuts } from "../ask-shortcuts.js";
import { Tea } from "../tea.js";
import {
  PRIOR_PROMPT,
  PRIOR_REPLY,
  defaultCommandSpec,
  collectNodeTexts,
  dumpTexts,
  preparePaint,
  hotkeyLabels,
  localClient,
  openTea,
  press,
  screenshot,
  sealedCompletion,
  seatTurn,
  seedConversation,
  talkingClient,
  typeText,
  waitDump,
  wrapTurn,
  type FrameDump,
  type TranscriptBlock,
} from "./_helpers.js";

const FOLLOW_PROMPT =
  "Also the session cookie survives the rotate. Should\n/logout clear it, or do we rotate the cookie name too?";
const FOLLOW_REPLY = "Cookie name stays. /logout already clears it; the 401\nwas the stale hash, not the cookie.";
const LIVE_THOUGHT = "The 401 is the old hash, not the session cookie.";
const LIVE_PARTIAL = "AuthForm still reads AUTH_SECRET from the module\nscope. I'll move the lookup into";
const THOUGHT_ONLY =
  "The module-scope AUTH_SECRET is captured when AuthForm\nloads. Request-time read would pick up the rotate.";
const EDIT_ASK_PROMPT = "The greeting constant in a.ts is stale. Change it to 2\nand keep the export name.";
const WRITE_ASK_PROMPT = "Add a.ts with the greeting constant set to 1\nso the rest of the module can import it.";
const ESC_DRAFT = "Also check whether the cookie name needs to rotate when AUTH_SECRET changes.";
const COVER_COMMENT = "keep the export";
const QUEUE_DRAFT = "Should /logout clear the session cookie too?";
const QUEUE_ROW = prompt.user`Also rotate the cookie name on logout.`;
const STEER_ROW = prompt.user`Keep AUTH_SECRET out of the module scope.`;

const CATALOG_ROWS = [
  "/connect",
  "/model",
  "/compact",
  "/rename",
  "/new",
  "/quit",
  "/agentic",
  "/background",
  "/rewind",
];

function pickerNames(frame: FrameDump): string[] {
  return frame.composer.picker.rows.map((row) => row.name ?? "");
}

function pickerSelected(frame: FrameDump): string | null {
  return frame.composer.picker.rows.find((row) => row.key === frame.composer.picker.selectedKey)?.name ?? null;
}

function flattenBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  return blocks.flatMap((block) => [block, ...(block.children ? flattenBlocks(block.children) : [])]);
}

function gutterKind(blocks: TranscriptBlock[], kind: string): boolean {
  return flattenBlocks(blocks).some((block) => {
    const gutter = block.gutter;
    return typeof gutter === "object" && gutter !== null && (gutter as { kind?: string }).kind === kind;
  });
}

test("empty shell — two sites, empty transcript, empty draft", () => {
  using ui = openTea();
  expect(ui).toMatchScreenshot("empty-shell");
});

test("sealed turn — head thought+speech, oldest-first", () => {
  using ui = openTea();
  const older = wrapTurn(sealedCompletion({ thought: null }));
  const newer = wrapTurn(
    sealedCompletion({
      prompt: FOLLOW_PROMPT,
      text: FOLLOW_REPLY,
      thought: null,
    }),
    older,
  );
  ui.client.sessionRoot.head = newer;
  expect(ui).toMatchScreenshot("two-prompts");

  ui.client.sessionRoot.head = wrapTurn(sealedCompletion());
  expect(ui).toMatchScreenshot("sealed-thought-speech");
});

test("live then seal — thought/speech then thought-only", () => {
  using ui = openTea();
  const completion = new CompletionExpectation({
    promptText: PRIOR_PROMPT,
    connectionId: "c",
  });
  ui.client.sessionRoot.head = wrapTurn(completion);
  const hub = completion.awareness;
  expect(hub).not.toBeNull();
  reportRole(hub!, completion.uuid, { text: LIVE_PARTIAL, thought: LIVE_THOUGHT });

  expect(ui).toMatchScreenshot("live-thought-speech");

  completion.succeed("settled", "", JSON.stringify({ text: PRIOR_REPLY, thought: LIVE_THOUGHT }), {
    result: { text: PRIOR_REPLY, thought: LIVE_THOUGHT },
  });
  expect(ui).toMatchScreenshot("sealed-after-live");
  const sealedTexts = dumpTexts(ui.dump().transcript);
  expect({
    thought: sealedTexts.includes("The 401 is the old hash"),
    partial: sealedTexts.includes("I'll move the lookup"),
  }).toEqual({ thought: true, partial: false });

  const thoughtOnly = sealedCompletion({
    text: "",
    thought: THOUGHT_ONLY,
  });
  thoughtOnly.responseText = "";
  ui.client.sessionRoot.head = wrapTurn(thoughtOnly);
  expect(ui).toMatchScreenshot("thought-only");
});

test("failed head — omnibox + transcript error", () => {
  using ui = openTea();
  ui.client.sessionRoot.head = wrapTurn(
    sealedCompletion({
      outcome: "failed",
      text: "",
      thought: null,
      endDetail: "openai-compat completion failed: 426 CLI version (none)",
    }),
  );
  expect(ui.dump().composer.hints).toEqual(["Enter: Resume the interrupted turn"]);
  expect(ui.dump().composer.annotationRole).toBe("");
  expect(
    ui
      .dump()
      .wait.flatMap((block) => block.texts)
      .join(""),
  ).toContain("openai-compat completion failed: 426");
  expect(ui).toMatchScreenshot("failed-head");
});

test("failed wire — connection annotation", () => {
  using ui = openTea(talkingClient());
  const grok = new DriverSpec({
    name: "grok",
    description: "Grok subscription",
    importPath: "test:grok",
    abilityClaim: ["completion"],
    multiplicity: "add-by-default",
  });
  ui.client.kernelRoot.drivers = { grok };
  const connection = new ConnectionSpec({ driver: grok, name: "grok" });
  ui.client.kernelRoot.connections = { grok: connection };
  ui.client.sessionRoot.applyKvs([{ form: "kv-set", key: "connection", value: "grok" }]);
  connection.readyState = "failed";
  connection.error = "openai-compat completion failed: 403";
  expect(ui.dump().composer.annotationRole).toBe("");
  expect(
    ui
      .dump()
      .wait.flatMap((block) => block.texts)
      .join(""),
  ).toContain("openai-compat completion failed: 403");
  expect(ui).toMatchScreenshot("failed-wire");
});

test("status rail — local-endpoint name; model/provider", () => {
  using ui = openTea(talkingClient());
  const grok = new DriverSpec({
    name: "grok",
    description: "Grok subscription",
    importPath: "test:grok",
    abilityClaim: ["completion"],
    multiplicity: "add-by-default",
  });
  const openai = new DriverSpec({
    name: "openai-compat",
    description: "OpenAI-compatible",
    importPath: "test:openai",
    abilityClaim: ["completion"],
    multiplicity: "add-as-secondary",
  });
  const work = new ConnectionSpec({ driver: openai, name: "work" });
  work.live = { catalogName: "Ollama" };
  ui.client.kernelRoot.drivers = { grok, "openai-compat": openai };
  ui.client.kernelRoot.connections = {
    grok: new ConnectionSpec({ driver: grok, name: "grok" }),
    work,
  };
  expect(ui.dump().composer.statusItems).toEqual([]);
  expect(ui).toMatchScreenshot("status-idle");

  ui.client.sessionRoot.applyKvs([
    { form: "kv-set", key: "connection", value: "grok" },
    { form: "kv-set", key: "model", value: "grok-4" },
  ]);
  expect(ui.dump().composer.statusItems).toEqual(["grok-4", "grok"]);
  expect(ui).toMatchScreenshot("status-grok");

  ui.client.sessionRoot.applyKvs([
    { form: "kv-set", key: "connection", value: "work" },
    { form: "kv-set", key: "model", value: "llama3" },
  ]);
  expect(ui.dump().composer.statusItems).toEqual(["llama3", "Ollama"]);

  press(ui.tea, "Tab", { shift: true });
  expect(ui.dump().composer.statusItems).toEqual(["llama3", "Ollama", "auto ask-denies"]);
  press(ui.tea, "Tab", { shift: true });
  expect(ui.dump().composer.statusItems).toEqual(["llama3", "Ollama", "always approve"]);
  press(ui.tea, "Tab", { shift: true });
  expect(ui.dump().composer.statusItems).toEqual(["llama3", "Ollama"]);
});

test("slash catalog — paint, Tab/arrows, wrap, Esc arm, /compact", async () => {
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
  const open = await waitDump(
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
  expect(pickerNames(open)).toEqual(CATALOG_ROWS);
  expect(pickerSelected(open)).toBe("/connect");
  expect(ui).toMatchScreenshot("slash-catalog");

  press(ui.tea, "Tab", { shift: true });
  press(ui.tea, "ArrowDown");
  expect(pickerSelected(ui.dump())).toBe("/model");
  expect(ui).toMatchScreenshot("slash-catalog-model");
  press(ui.tea, "ArrowUp");
  expect(pickerSelected(ui.dump())).toBe("/connect");
  press(ui.tea, "Tab");
  expect(ui.dump().composer.draft).toBe("/connect ");

  press(ui.tea, "KillLineStart");
  press(ui.tea, "/");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "/model"));
  press(ui.tea, "ArrowUp");
  expect(pickerSelected(ui.dump())).toBe("/rewind");
  press(ui.tea, "ArrowDown");
  expect(pickerSelected(ui.dump())).toBe("/connect");

  press(ui.tea, "Escape");
  expect(ui.dump().composer.hints).toEqual(["Esc: clear"]);

  client.kernelRoot.commands = {
    ...client.kernelRoot.commands,
    go: new CommandSpec({
      verb: "go",
      description: "Go",
      body: `(harness/choice :choices (list (harness/choice :name "row")))`,
    }),
  };
  const withGo = await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "/go"));
  expect(pickerNames(withGo)).toEqual([
    "/connect",
    "/model",
    "/go",
    "/compact",
    "/rename",
    "/new",
    "/quit",
    "/agentic",
    "/background",
    "/rewind",
  ]);
});

test("/connect picker — rows, health, dim remainder, identity, same-name keys", async () => {
  const client = localClient();
  const openai = new DriverSpec({
    name: "openai-compat",
    description: "OpenAI-compatible",
    importPath: "test:openai",
    abilityClaim: ["completion"],
    multiplicity: "add-as-secondary",
  });
  client.kernelRoot.drivers = { "openai-compat": openai };
  client.kernelRoot.connections = { work: new ConnectionSpec({ driver: openai, name: "Work" }) };
  client.kernelRoot.commands = { connect: defaultCommandSpec("connect") };
  seedConversation(client);
  using ui = openTea(client);

  typeText(ui.tea, "/connect");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "Work"));
  expect(ui).toMatchScreenshot("connect-wired");
  press(ui.tea, "Tab");
  expect(ui).toMatchScreenshot("connect-tab-work");

  press(ui.tea, "KillLineStart");
  client.kernelRoot.commands = {
    connect: new CommandSpec({
      verb: "connect",
      body: `(harness/choice :choices (list
               (harness/choice :name "openrouter"
                 :health-status 'failed
                 :health-annotation "openai-compat handshake failed: 401")
               (harness/choice :name "openai")
               (harness/choice :name "chatgpt")))`,
    }),
  };
  typeText(ui.tea, "/connect");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "openrouter"));
  expect(ui).toMatchScreenshot("connect-health");

  press(ui.tea, "KillLineStart");
  client.kernelRoot.commands = {
    connect: new CommandSpec({
      verb: "connect",
      body: `(harness/choice :choices (list
               (harness/choice :name "openrouter")
               (harness/choice :name "openai")
               (harness/choice :name "chatgpt")))`,
    }),
  };
  typeText(ui.tea, "/connect");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "openai"));
  expect(ui).toMatchScreenshot("connect-filter-open");

  press(ui.tea, "ArrowDown");
  expect(ui).toMatchScreenshot("connect-filter-openai");
  typeText(ui.tea, " o");
  expect(ui).toMatchScreenshot("connect-type-o");
  ui.tea.handle({ kind: "input_events", events: [{ key: "Backspace" }, { key: "c" }] });
  expect(ui).toMatchScreenshot("connect-type-c");
  press(ui.tea, "Backspace");
  expect(ui).toMatchScreenshot("connect-backspace");

  press(ui.tea, "KillLineStart");
  client.kernelRoot.commands = {
    connect: new CommandSpec({
      verb: "connect",
      body: `(harness/choice :choices (list
               (harness/choice :name "OpenAI")
               (harness/choice :name "OpenAI")))`,
    }),
  };
  typeText(ui.tea, "/connect");
  const twins = await waitDump(
    ui.dump,
    (frame) => frame.composer.picker.rows.filter((row) => row.name === "OpenAI").length === 2,
  );
  expect(ui).toMatchScreenshot("connect-twins");
  expect(twins.composer.picker.rows.map((row) => row.key)).toEqual(["choice:0:OpenAI", "choice:1:OpenAI"]);
});

test("overlay confirm — drop confirm chrome", async () => {
  const client = localClient();
  client.request = async (method) => {
    if (method === "connect/drop") {
      return { form: "ui", pending: "p1", body: '(harness/confirm :title "Remove work?")' };
    }
    return { ok: true };
  };
  client.kernelRoot.commands = {
    go: new CommandSpec({
      verb: "go",
      body: `(harness/choice :choices (list
               (harness/choice :name "row"
                 :action (list (harness/action 'connect/drop :params (dict :id "work"))))))`,
    }),
  };
  seedConversation(client);
  using ui = openTea(client);
  typeText(ui.tea, "/go");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "row"));
  press(ui.tea, "Enter");
  await waitDump(
    ui.dump,
    (frame) =>
      frame.composer.draft.includes("Remove work?") ||
      frame.composer.texts.some((line) => line.includes("Remove work?")),
  );
  expect(ui).toMatchScreenshot("overlay-confirm");
  press(ui.tea, "Escape");
  await waitDump(
    ui.dump,
    (frame) =>
      frame.composer.interactive &&
      !frame.composer.draft.includes("Remove work?") &&
      !frame.composer.texts.some((line) => line.includes("Remove work?")),
  );
  expect(ui).toMatchScreenshot("overlay-confirm-dismissed");
}, 20_000);

test("overlay input — Base URL / instructional / auth wait / busy dim", async () => {
  const client = localClient();
  let parks = 0;
  let release!: () => void;
  let held: Promise<void> | undefined;
  client.request = async (method) => {
    if (method === "connect/adopt" || method === "connect/login") {
      parks += 1;
      if (parks === 1) return { form: "ui", pending: "p2", body: '(harness/input :name "Base URL")' };
      if (parks === 2) {
        return {
          form: "ui",
          pending: "p-id",
          body: `(harness/open-url :url "https://docs.github.com/apps" :name "OAuth client ID" :description "This authorization server has no dynamic registration. Create an OAuth or GitHub App with callback http://127.0.0.1/callback, then paste the client ID." :input 'text)`,
        };
      }
      return {
        form: "ui",
        pending: "p-url",
        body: `(harness/open-url :url "https://openrouter.ai/auth?code_challenge=abc" :description "Authorize OpenRouter in the browser" :input 'password)`,
      };
    }
    if (method === "ui/resolve") {
      if (held !== undefined) await held;
      return { ok: true };
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
  const opened: string[] = [];
  seedConversation(client);
  using ui = openTea(client, {
    open: (url) => {
      opened.push(url);
    },
  });

  typeText(ui.tea, "/go");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "row"));
  press(ui.tea, "Enter");
  await waitDump(ui.dump, (frame) => frame.composer.placeholder.includes("Base URL"));
  expect(ui).toMatchScreenshot("overlay-base-url");

  typeText(ui.tea, "http://x");
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  press(ui.tea, "Enter");
  await waitDump(ui.dump, (frame) => frame.composer.interactive === false);
  expect(ui).toMatchScreenshot("overlay-busy");
  release();
  await waitDump(ui.dump, (frame) => frame.composer.interactive !== false);
  press(ui.tea, "KillLineStart");

  typeText(ui.tea, "/go");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "row"));
  press(ui.tea, "Enter");
  await waitDump(ui.dump, (frame) =>
    frame.composer.picker.rows.some((row) => (row.description ?? row.name ?? "").includes("no dynamic registration")),
  );
  expect(ui).toMatchScreenshot("overlay-instructional");
  expect(opened).toEqual([]);
  press(ui.tea, "Escape");
  await waitDump(
    ui.dump,
    (frame) =>
      frame.composer.interactive &&
      !frame.composer.picker.rows.some((row) => (row.href ?? "").includes("docs.github.com")),
  );
  press(ui.tea, "KillLineStart");

  typeText(ui.tea, "/go");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "row"));
  press(ui.tea, "Enter");
  await waitDump(ui.dump, (frame) =>
    frame.composer.picker.rows.some((row) => (row.description ?? row.name ?? "").includes("Authorize OpenRouter")),
  );
  expect(opened).toEqual([]);
  // The daemon holds the callback; the answer stays in flight until the browser lands there.
  held = new Promise<void>(() => undefined);
  press(ui.tea, "Enter");
  await waitDump(ui.dump, (frame) => frame.composer.draft === "Waiting for the browser…");
  expect(ui).toMatchScreenshot("overlay-auth-wait");
  expect(opened).toHaveLength(1);
  const openedUrl = new URL(opened[0]!);
  expect({ origin: openedUrl.origin, challenge: openedUrl.searchParams.get("code_challenge") }).toEqual({
    origin: "https://openrouter.ai",
    challenge: "abc",
  });
}, 20_000);

test("notice on fire reject", async () => {
  const client = localClient();
  client.request = async () => {
    throw new Error("connect/adopt: grok is not adoptable yet");
  };
  client.kernelRoot.commands = {
    go: new CommandSpec({
      verb: "go",
      body: `(harness/choice :choices (list
               (harness/choice :name "row"
                 :action (list (harness/action 'connect/adopt :params (dict :driver "grok"))))))`,
    }),
  };
  seedConversation(client);
  using ui = openTea(client);
  typeText(ui.tea, "/go");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "row"));
  press(ui.tea, "Enter");
  await waitDump(ui.dump, (frame) => frame.composer.draft.includes("connect/adopt: grok is not adoptable yet"));
  expect(ui).toMatchScreenshot("notice-reject");
  press(ui.tea, "Enter");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "row"));
  expect(ui).toMatchScreenshot("notice-dismissed");
});

function recapHints(tea: Tea): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    const rec = node as { kind?: string; recap?: boolean; recapHotkeys?: unknown; children?: unknown[] };
    if (rec.kind === "speech" && rec.recap === true) {
      for (const item of Array.isArray(rec.recapHotkeys) ? rec.recapHotkeys : []) {
        const hotkey = item as { key?: string; action?: string };
        if (typeof hotkey.key === "string" && typeof hotkey.action === "string") {
          out.push(`${hotkey.key}: ${hotkey.action}`);
        }
      }
    }
    for (const child of rec.children ?? []) visit(child);
  };
  visit(tea.paintRoot);
  return out;
}

test("empty Esc — idle rewind hint, live cancel does not traverse", () => {
  using idle = openTea(talkingClient());
  press(idle.tea, "Escape");
  expect(idle.dump().composer.hints).toEqual(["Esc: Rewind history"]);
  press(idle.tea, "Escape");
  // LATEST_PLACE: the peel lands on the head, which is also the tip. The
  // omnibox seats at the rim with an empty input — the rollback hint moves
  // off the box and onto the in-tape recap (no scroll-down hint: nothing is
  // newer than the head).
  expect({
    draft: idle.dump().composer.draft,
    hints: idle.dump().composer.hints,
    recap: recapHints(idle.tea),
  }).toEqual({ draft: "", hints: [], recap: ["Enter: Rollback here"] });

  const client = localClient();
  liveTalkingHead(client);
  using live = openTea(client);
  press(live.tea, "Escape");
  expect({
    hints: live.dump().composer.hints,
    cancelRequested: live.client.sessionRoot.head?.cancelRequested === true,
  }).toEqual({
    hints: ["Esc: cancel current turn"],
    cancelRequested: false,
  });
  press(live.tea, "Escape");
  expect({
    hints: live.dump().composer.hints,
    cancelRequested: live.client.sessionRoot.head?.cancelRequested === true,
  }).toEqual({
    hints: [],
    cancelRequested: true,
  });
});

test("double-Esc — arm / disarm / clear", () => {
  using ui = openTea(talkingClient());
  typeText(ui.tea, ESC_DRAFT);
  press(ui.tea, "Escape");
  expect({
    draft: ui.dump().composer.draft,
    hints: ui.dump().composer.hints,
  }).toEqual({
    draft: ESC_DRAFT,
    hints: ["Esc: clear"],
  });
  expect(ui).toMatchScreenshot("esc-armed");

  press(ui.tea, "x");
  expect(ui.dump().composer.hints).toEqual([]);
  press(ui.tea, "Escape");
  press(ui.tea, "Escape");
  expect({
    draft: ui.dump().composer.draft,
    hints: ui.dump().composer.hints,
  }).toEqual({
    draft: "",
    hints: [],
  });
  expect(ui).toMatchScreenshot("esc-cleared");
});

function liveTalkingHead(client: ReturnType<typeof localClient>): SessionTurn {
  const completion = new CompletionExpectation({
    promptText: PRIOR_PROMPT,
    connectionId: "c",
  });
  const turn = wrapTurn(completion);
  client.sessionRoot.head = turn;
  const hub = completion.awareness;
  reportRole(hub!, completion.uuid, { text: LIVE_PARTIAL, thought: LIVE_THOUGHT });
  return turn;
}

test("busy turn — queue hint, deck extender, slash owns the stack", async () => {
  const client = localClient();
  client.kernelRoot.commands = {
    connect: new CommandSpec({
      verb: "connect",
      description: "Manage provider connections",
      source: "connect.scm",
      body: "",
    }),
    compact: new CommandSpec({ verb: "compact", description: "Compact conversation context" }),
  };
  const turn = liveTalkingHead(client);
  using ui = openTea(client);
  typeText(ui.tea, QUEUE_DRAFT);
  const drafting = ui.dump();
  expect({
    draft: drafting.composer.draft,
    hints: drafting.composer.hints,
  }).toEqual({
    draft: QUEUE_DRAFT,
    hints: ["Enter: queue message"],
  });
  admitSteer(client.sessionRoot, STEER_ROW, turn.uuid);
  admitQueue(client.sessionRoot, QUEUE_ROW, turn.uuid);
  press(ui.tea, "Escape");
  press(ui.tea, "Escape");
  const prepared = preparePaint(ui.tea);
  const deck = ui.dump();
  const deckTexts = deck.composer.texts.join("\n");
  const body = prepared.tapeNode;
  const bodyKids = body !== null && "children" in body && Array.isArray(body.children) ? body.children : [];
  const userBlocks = bodyKids.filter((child) => "key" in child && String(child.key).endsWith(":speech-user"));
  const steerText = collectNodeTexts(userBlocks.at(-1)).join(" ");
  expect({
    draft: deck.composer.draft,
    hints: deck.composer.hints,
    glyphs: deck.composer.glyphs,
    steerInDeck: deckTexts.includes(STEER_ROW),
    steerOnTape: steerText.includes("Keep AUTH") && steerText.includes("module scope"),
    queue: deckTexts.includes(QUEUE_ROW),
  }).toEqual({
    draft: "",
    hints: ["Enter: steer first", "Esc: retract last queued"],
    glyphs: ["1"],
    steerInDeck: false,
    steerOnTape: true,
    queue: true,
  });
  expect(ui).toMatchScreenshot("steer-queue-deck");

  typeText(ui.tea, "/");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "/compact"));
  const slash = ui.dump();
  const slashTexts = slash.composer.texts.join("\n");
  expect({
    queueHint: slash.composer.hints.some((hint) => hint.includes("queue message") || hint.includes("steer first")),
    steer: slashTexts.includes(STEER_ROW),
    queue: slashTexts.includes(QUEUE_ROW),
  }).toEqual({
    queueHint: false,
    steer: false,
    queue: false,
  });
});

test("/model remainder chrome — typed-id hint", async () => {
  const client = localClient();
  client.request = async () => ({ ok: true });
  client.kernelRoot.commands = {
    model: new CommandSpec({
      verb: "model",
      body: `(harness/choice :action (list
               (harness/action 'kv/set :name "Set model"
                 :params (dict :key "model" :value ""))))`,
    }),
  };
  seedConversation(client);
  using ui = openTea(client);
  typeText(ui.tea, "/model grok-4");
  await waitDump(ui.dump, (frame) => frame.composer.hints.join("\n").includes("Set model"));
  expect(ui).toMatchScreenshot("model-remainder");
});

test("connect.scm identity / funds / health", async () => {
  const client = localClient();
  const grok = new DriverSpec({
    name: "grok",
    description: "Grok subscription",
    importPath: "test:grok",
    abilityClaim: ["completion"],
    multiplicity: "add-by-default",
  });
  const grokWire = new ConnectionSpec({ driver: grok, name: "grok" });
  grokWire.live = {
    catalogName: "Grok",
    identity: { displayName: "User", plan: "super_grok_heavy" },
  };
  const openai = new DriverSpec({
    name: "openai-compat",
    description: "OpenAI-compatible",
    importPath: "test:openai",
    abilityClaim: ["completion"],
    multiplicity: "add-as-secondary",
  });
  const work = new ConnectionSpec({ driver: openai, name: "work" });
  work.live = {
    catalogName: "OpenRouter",
    keyMask: "sk-or-...999",
    account: {
      identity: { shortName: "ada", name: "ada" },
      identityDetail: { shortName: "ada", name: "ada", kind: "key", key: { mask: "sk-or-...999" } },
      balance: { balance: "74.75", currency: { code: "USD", symbol: "$" } },
    },
  };
  const openrouter = new DriverSpec({
    name: "openrouter",
    description: "OpenRouter",
    importPath: "test:openrouter",
    abilityClaim: ["completion"],
    multiplicity: "add-by-default",
  });
  const failed = new ConnectionSpec({ driver: openrouter, name: "openrouter" });
  failed.readyState = "failed";
  failed.error = "openai-compat handshake failed: 401";
  client.kernelRoot.drivers = { grok, "openai-compat": openai, openrouter };
  client.kernelRoot.connections = { grok: grokWire, work, openrouter: failed };
  client.kernelRoot.commands = { connect: defaultCommandSpec("connect") };
  seedConversation(client);
  using ui = openTea(client);
  typeText(ui.tea, "/connect");
  await waitDump(ui.dump, (f) => f.composer.picker.rows.some((row) => row.name === "Grok"));
  expect(ui).toMatchScreenshot("connect-identity");
});

/** One-line edit. Display width still fits a split pane at Tea's 80-col default. */
function askTurn(): { turn: SessionTurn; leaf: SystemToolJob } {
  const leaf = new SystemToolJob({
    toolCallId: "call_1",
    name: "edit_file",
    argsJson: JSON.stringify({
      path: "a.ts",
      old_string: "export const a = 1;\n",
      new_string: "export const a = 2;\n",
    }),
    policyResult: "ask",
  });
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: EDIT_ASK_PROMPT,
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  return { turn, leaf };
}

const LONG_COVER_FILE = "generated-super-califragilistic-expialidocious-component-module.ts";

function askCoverTurn(name: "edit_file" | "write_file", path: string): { turn: SessionTurn; leaf: SystemToolJob } {
  const leaf = new SystemToolJob({
    toolCallId: "call_1",
    name,
    argsJson: JSON.stringify(
      name === "edit_file"
        ? {
            path,
            old_string: "export const a = 1;\n",
            new_string: "export const a = 2;\n",
          }
        : { path, content: "export const a = 1;\n" },
    ),
    policyResult: "ask",
  });
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: name === "edit_file" ? EDIT_ASK_PROMPT : WRITE_ASK_PROMPT,
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  return { turn, leaf };
}

function editHunk(path: string): string {
  return JSON.stringify({
    path,
    old_string: "export const a = 1;\n",
    new_string: "export const a = 2;\n",
  });
}

const ASK_QUEUE_PROMPT =
  "Patch AuthForm, login, session, and the cookie helper\nin that order. I'll confirm each write.";

function askQueueTurn(): { turn: SessionTurn; asked: SystemToolJob } {
  const tapeApplied = new SystemToolJob({
    toolCallId: "e1",
    name: "edit_file",
    argsJson: editHunk("src/AuthForm.ts"),
    humanApprove: true,
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const tapeApplying = new SystemToolJob({
    toolCallId: "e2",
    name: "edit_file",
    argsJson: editHunk("src/login.ts"),
    humanApprove: true,
    approvalComment: COVER_COMMENT,
  });
  const diffPin = new SystemToolJob({
    toolCallId: "e3",
    name: "edit_file",
    argsJson: editHunk("src/session.ts"),
    policyResult: "ask",
  });
  const unpaintedQueued = new SystemToolJob({
    toolCallId: "e4",
    name: "edit_file",
    argsJson: editHunk("src/cookie.ts"),
  });
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: ASK_QUEUE_PROMPT,
    permissionMode: "manual",
    doneWork: [tapeApplied, tapeApplying, diffPin],
    queue: [unpaintedQueued],
  });
  turn.pushChild(tapeApplied);
  turn.pushChild(tapeApplying);
  turn.pushChild(diffPin);
  turn.pushChild(unpaintedQueued);
  return { turn, asked: diffPin };
}

function mountAskQueue() {
  const client = localClient();
  client.kernelRoot.approvalAskThrottleMs = 0;
  client.sessionRoot.permissionMode = "manual";
  const mounted = askQueueTurn();
  client.sessionRoot.head = mounted.turn;
  return { client, ...mounted };
}

test("ask queue: tape stops at the pointer; pin holds the Diff", () => {
  const { client } = mountAskQueue();
  using ui = openTea(client);
  const frame = ui.dump();
  const tape = dumpTexts(frame.transcript);
  const pin = frame.ask.flatMap((block) => block.texts).join("");
  expect({
    annotation: frame.composer.annotation,
    hints: frame.composer.hints,
    tape: {
      auth: tape.includes("src/AuthForm.ts"),
      login: tape.includes("src/login.ts"),
      comment: tape.includes(COVER_COMMENT),
      session: tape.includes("src/session.ts"),
      cookie: tape.includes("src/cookie.ts"),
      spinner: gutterKind(frame.transcript, "spinner"),
      askGlyph: flattenBlocks(frame.transcript).some((block) => {
        const gutter = block.gutter;
        return typeof gutter === "object" && gutter !== null && (gutter as { glyph?: string }).glyph === "?";
      }),
    },
    pin: {
      wire: pin.includes("edit_file"),
      hunk: pin.includes("export const a = 2"),
      cursor: pin.includes("▌"),
    },
  }).toEqual({
    annotation: "edit **src/session.ts**",
    hints: hotkeyLabels(askCoverShortcuts({ comment: false })),
    tape: {
      auth: true,
      login: true,
      comment: true,
      session: false,
      cookie: false,
      spinner: true,
      askGlyph: false,
    },
    pin: { wire: false, hunk: true, cursor: true },
  });
  expect(ui).toMatchScreenshot("ask-queue");
  typeText(ui.tea, COVER_COMMENT);
  expect(ui.dump().composer.hints).toEqual(hotkeyLabels(askCoverShortcuts({ comment: true })));
  expect(ui).toMatchScreenshot("ask-queue-comment");
});

test("ask cover shadows a frozen draft and swaps Enter/Esc hints", () => {
  const client = localClient();
  client.kernelRoot.approvalAskThrottleMs = 0;
  using ui = openTea(client);
  typeText(ui.tea, "keep me");
  ui.client.sessionRoot.head = askTurn().turn;
  const asked = ui.dump();
  const askedPin = asked.ask.flatMap((block) => block.texts).join("");
  expect({
    placeholder: asked.composer.placeholder,
    interactive: asked.composer.interactive,
    annotation: asked.composer.annotation,
    hints: asked.composer.hints,
    askWire: askedPin.includes("edit_file"),
    askHunk: askedPin.includes("export const a = 2"),
  }).toEqual({
    placeholder: "",
    interactive: true,
    annotation: "edit **a.ts**",
    hints: hotkeyLabels(askCoverShortcuts({ comment: false })),
    askWire: false,
    askHunk: true,
  });
  expect(ui).toMatchScreenshot("ask-cover");
  typeText(ui.tea, COVER_COMMENT);
  const commented = ui.dump();
  expect({
    interactive: commented.composer.interactive,
    draft: commented.composer.draft,
    hints: commented.composer.hints,
    parked: ui.tea.draft.draft,
  }).toEqual({
    interactive: true,
    draft: COVER_COMMENT,
    hints: hotkeyLabels(askCoverShortcuts({ comment: true })),
    parked: "keep me",
  });
  expect(ui).toMatchScreenshot("ask-cover-comment");
});

test("ask cover affix-clips an ultra-long filename", () => {
  const client = localClient();
  client.kernelRoot.approvalAskThrottleMs = 0;
  using ui = openTea(client);
  ui.client.sessionRoot.head = askCoverTurn("edit_file", LONG_COVER_FILE).turn;
  expect(ui.dump().composer.annotation).toBe(`edit **${LONG_COVER_FILE}**`);
  expect(ui).toMatchScreenshot("ask-cover-long-edit");
  typeText(ui.tea, COVER_COMMENT);
  expect(ui.dump().composer.hints).toEqual(hotkeyLabels(askCoverShortcuts({ comment: true })));
});

/** Scroll 0 + tall tape: the squeezed peek sits on the clip floor over
 *  speech. Void after the short split lines must stay empty — not tape
 *  glyphs, not a surface slab. */
test("ask Diff peek casts transparent over scrolled tape", () => {
  let tail: SessionSystemPrompt | SessionTurn = new SessionSystemPrompt();
  for (const i of [0, 1, 2, 3]) {
    const prior = wrapTurn(
      sealedCompletion({
        prompt: `Pass ${i}. ${PRIOR_PROMPT}`,
        text: `Pass ${i}. ${PRIOR_REPLY}`,
        thought: null,
      }),
      tail,
    );
    prior.reducerExited = true;
    tail = prior;
  }
  const leaf = new SystemToolJob({
    toolCallId: "call_1",
    name: "edit_file",
    argsJson: JSON.stringify({
      path: "a.ts",
      old_string: "export const a = 1;\n",
      new_string: "export const a = 2;\n",
    }),
    policyResult: "ask",
  });
  const turn = seatTurn({
    turnTail: tail,
    prompt: EDIT_ASK_PROMPT,
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  const client = localClient();
  client.kernelRoot.approvalAskThrottleMs = 0;
  using ui = openTea(client);
  ui.client.sessionRoot.head = turn;
  const pin = ui
    .dump()
    .ask.flatMap((block) => block.texts)
    .join("");
  expect({ hunk: pin.includes("export const a = 2") }).toEqual({ hunk: true });
  expect(screenshot(ui.tea, { atBottom: false, scroll: 0 })).toMatchScreenshot("ask-cover-over-tape");
});

test("tall ask Diff scrolls in the tape; last rows sit on the composer", () => {
  const oldLines = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`);
  const newLines = oldLines.map((line, i) => line.replace(`= ${i};`, `= ${i + 1};`));
  const leaf = new SystemToolJob({
    toolCallId: "call_1",
    name: "edit_file",
    argsJson: JSON.stringify({
      path: "src/values.ts",
      old_string: `${oldLines.join("\n")}\n`,
      new_string: `${newLines.join("\n")}\n`,
    }),
    policyResult: "ask",
  });
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: EDIT_ASK_PROMPT,
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  const client = localClient();
  client.kernelRoot.approvalAskThrottleMs = 0;
  using ui = openTea(client);
  ui.client.sessionRoot.head = turn;
  const pin = ui
    .dump()
    .ask.flatMap((block) => block.texts)
    .join("");
  expect({ v19: pin.includes("v19"), twenty: pin.includes("20") }).toEqual({
    v19: true,
    twenty: true,
  });
  expect(ui).toMatchScreenshot("ask-cover-tall-edit");
  expect(screenshot(ui.tea, { atBottom: false, scroll: 0 })).toMatchScreenshot("ask-cover-tall-edit-top");
});

test("first-ask throttle paints ask chrome while the draft stays live", () => {
  const now = 1_000;
  const client = localClient();
  client.kernelRoot.approvalAskThrottleMs = 2_000;
  using ui = openTea(client, { now: () => now });
  typeText(ui.tea, "still looking at AuthForm");
  ui.client.sessionRoot.head = askTurn().turn;
  expect(ui).toMatchScreenshot("ask-throttle");
});

test("session title — idle then ask wins", async () => {
  const client = talkingClient();
  client.kernelRoot.approvalAskThrottleMs = 0;
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
  client.sessionRoot.manualTitle = "Auth refactor";
  using ui = openTea(client);
  expect({
    annotation: ui.dump().composer.annotation,
    annotationRole: ui.dump().composer.annotationRole,
  }).toEqual({
    annotation: "Auth refactor",
    annotationRole: "",
  });
  expect(ui).toMatchScreenshot("session-title-idle");

  press(ui.tea, "/");
  await waitDump(ui.dump, (frame) => frame.composer.picker.rows.some((row) => row.name === "/connect"));
  expect({
    title: ui.dump().composer.annotation,
    description: ui.dump().composer.texts.some((text) => text.includes("Manage provider connections")),
  }).toEqual({
    title: "Auth refactor",
    description: true,
  });

  press(ui.tea, "Escape");
  press(ui.tea, "Escape");
  await waitDump(
    ui.dump,
    (frame) => frame.composer.draft === "" && !frame.composer.picker.rows.some((row) => row.name === "/connect"),
  );
  ui.client.sessionRoot.head = askTurn().turn;
  expect(ui.dump().composer.annotation).toBe("edit **a.ts**");
  expect(ui).toMatchScreenshot("session-title-ask");
});

function seedAgentsDrawer(client: ReturnType<typeof localClient>): void {
  const nestedA = new BotCallJob({
    toolCallId: "call-qa-a",
    name: "agent__send",
    argsJson: JSON.stringify({ spec: "qa", message: "check a" }),
    workerSessionId: "w-qa-a",
  });
  const nestedB = new BotCallJob({
    toolCallId: "call-qa-b",
    name: "agent__send",
    argsJson: JSON.stringify({ spec: "qa", message: "check b" }),
    workerSessionId: "w-qa-b",
  });
  const bag = new ProgrammaticJob({
    toolCallId: "bag-qa",
    background: true,
    argsJson: JSON.stringify({ expr: "(parallel)", description: "Fan out QA checks" }),
  });
  bag.pushInvocation(nestedA);
  bag.pushInvocation(nestedB);
  const explore = new AgentCallJob({
    toolCallId: "call-explore",
    name: "agent__ask",
    argsJson: JSON.stringify({ spec: "explore", message: "map the repo" }),
    workerSessionId: "w-explore",
  });
  const chief = new BotCallJob({
    toolCallId: "call-chief",
    name: "agent__send",
    argsJson: JSON.stringify({ spec: "chief", message: "steer" }),
    workerSessionId: "w-chief",
    completed: true,
    outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("steered") }),
  });
  client.sessionRoot.botsRoster.chief = "w-chief";
  client.kernelRoot.sessions["w-chief"] = new SessionOverview({
    specName: "chief",
    recipeScope: "session",
    keepAlive: true,
  });
  client.kernelRoot.sessions["w-explore"] = new SessionOverview({
    specName: "explore",
    title: "Explore",
    status: "mapping the repo",
    model: "haiku",
    lastPrompt: "map the repo",
    midMotion: true,
    oneShot: true,
  });
  client.kernelRoot.sessions["w-qa-a"] = new SessionOverview({
    specName: "qa",
    recipeScope: "session",
    status: "checking a",
    model: "haiku",
    midMotion: true,
  });
  client.kernelRoot.sessions["w-qa-b"] = new SessionOverview({
    specName: "qa",
    recipeScope: "session",
    status: "needs you",
    unfinished: "ask",
    askLine: "confirm shell command?",
    asking: true,
  });
  client.kernelRoot.sessions["w-scout"] = new SessionOverview({
    specName: "quick-search",
    status: "citing matching paths",
    midMotion: true,
    oneShot: true,
  });
  client.kernelRoot.agentCalls["rel-scout"] = new KernelAgentRelation({
    callerSessionId: "w-explore",
    workerSessionId: "w-scout",
    spec: "quick-search",
    oneShot: true,
  });
  client.sessionRoot.head = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: PRIOR_PROMPT,
    doneWork: [bag, explore, chief],
    queue: [],
  });
  client.projectRoot.sessions.s = "";
  client.projectRoot.sessions["s-auth"] = "";
  client.projectRoot.sessions["s-docs"] = "";
  client.projectRoot.sessions["s-park"] = "";
  client.projectRoot.sessions["s-watch"] = "";
  client.projectRoot.sessions["s-quiet"] = "";
  client.projectRoot.sessions["s-empty"] = "";
  client.kernelRoot.sessions.s = new SessionOverview({
    title: "Password rotate",
    model: "grok",
    lastMessageAt: 60,
    status:
      "The login form still posts the previous password hash after I rotate AUTH_SECRET. Check AuthForm and /login.",
  });
  client.kernelRoot.sessions["s-auth"] = new SessionOverview({
    title: "Auth refactor",
    model: "sonnet",
    lastMessageAt: 50,
    asking: true,
    unfinished: "ask",
    status: "cookie rotate",
    lastPrompt: "rotate the cookie name too?",
    askLine: "confirm shell command?",
  });
  client.kernelRoot.sessions["s-docs"] = new SessionOverview({
    title: "Docs pass",
    model: "haiku",
    lastMessageAt: 40,
    resident: true,
    midMotion: true,
    openTurn: true,
    openToolCount: 1,
  });
  client.kernelRoot.sessions["s-park"] = new SessionOverview({
    title: "Parked leftover",
    model: "opus",
    lastMessageAt: 30,
    openTurn: true,
  });
  client.kernelRoot.sessions["s-watch"] = new SessionOverview({
    title: "Comment watch",
    model: "haiku",
    lastMessageAt: 20,
    resident: true,
    periodArmed: true,
  });
  client.kernelRoot.sessions["s-quiet"] = new SessionOverview({
    title: "Quiet conversation",
    model: "grok",
    lastMessageAt: 10,
    lastPrompt: "Write a long recap of every auth path in the login form and the cookie rotate.",
    status:
      "The login form still posts the previous password hash after I rotate AUTH_SECRET. Check AuthForm and /login. Then rotate the cookie name too so the stale hash cannot come back.",
  });
  client.kernelRoot.sessions["s-empty"] = new SessionOverview({
    lastMessageAt: 99,
  });
  publishKernelSeat(client.kernelPlexus.awareness, "s-auth");
}

function focusAgents(ui: ReturnType<typeof openTea>, key: string): void {
  for (let i = 0; i < 24; i++) {
    if (
      ui.tea.paintRoot.children.some(
        (child) => child.kind === "agents" && (child as { focusKey?: string }).focusKey === key,
      )
    ) {
      return;
    }
    press(ui.tea, "j");
  }
}

test("agents compact meter — live calls, no drawer", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  expect(ui).toMatchScreenshot("agents-compact-live");
});

test("agents drawer — open overlay", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  expect(ui).toMatchScreenshot("agents-drawer-small");
});

test("agents drawer — dive-wide recap", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  focusAgents(ui, "session:s-auth");
  expect(ui).toMatchScreenshot("agents-drawer-dive");
});

test("agents drawer — current session has no peek", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  focusAgents(ui, `session:${client.sessionId}`);
  expect(ui).toMatchScreenshot("agents-drawer-current");
});

test("agents drawer — long description clamps in the peek", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  focusAgents(ui, "session:s-quiet");
  expect(ui).toMatchScreenshot("agents-drawer-clamp");
});

test("agents drawer — nested subagent focused", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  focusAgents(ui, "call:rel-scout");
  expect(ui).toMatchScreenshot("agents-subagent-nested");
});

test("agents drawer — subagent ask plaque", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  focusAgents(ui, "call:call-qa-b");
  expect(ui).toMatchScreenshot("agents-subagent-ask");
});

test("agents drawer — hover rich subagent plaque", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  const explore = client.agentCalls.find((call) => call.toolCallId === "call-explore");
  if (explore == null) throw new Error("missing explore call");
  explore.notifications.push(new AgentCallNotification({ message: "found AuthForm" }));
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  ui.tea.handle({ kind: "agents_hover", key: "call:call-explore:name" });
  ui.tea.flushPaint();
  expect(ui).toMatchScreenshot("agents-subagent-rich");
});

test("agents drawer — subagent sneak-peek overlay", () => {
  const client = localClient();
  seedAgentsDrawer(client);
  const worker = SessionPlexus.create("w-explore", "/tmp/p");
  worker.root.head = wrapTurn(
    sealedCompletion({
      prompt: "map the repo",
      text: [
        "Auth lives in saas/server and the cookie rotate is in AuthForm.",
        "The login form still posts the previous password hash after I rotate AUTH_SECRET.",
        "Check AuthForm and /login. Then rotate the cookie name too so the stale hash cannot come back.",
        "Module-scope AUTH_SECRET is captured when AuthForm loads; request-time read would pick up the rotate.",
        "Cookie name stays. /logout already clears it; the 401 was the stale hash, not the cookie.",
        "Also keep the session cookie on rotate so the stale hash cannot come back through /login.",
        "AuthForm still reads AUTH_SECRET from the module scope. Move the lookup into the handler.",
        "The 401 is the old hash, not the session cookie. Rotate the secret and keep the cookie name.",
        "Write a recap of every auth path in the login form and the cookie rotate.",
        "Do not leave the previous password hash in the form after AUTH_SECRET changes.",
      ].join("\n\n"),
      thought: null,
    }),
  );
  client.adoptPeek(worker);
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  ui.tea.handle({ kind: "activate", key: "call:call-explore" });
  ui.tea.flushPaint();
  expect(ui).toMatchScreenshot("agents-drawer-preview");
});

test("agents empty — idle named bot does not occupy chrome", () => {
  const client = localClient();
  client.sessionRoot.botsRoster.chief = "w-chief";
  using ui = openTea(client);
  expect(ui).toMatchScreenshot("agents-empty");
});
