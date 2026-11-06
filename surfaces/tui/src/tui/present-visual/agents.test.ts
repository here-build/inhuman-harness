/** qd present: closed agents meter, open drawer, sneak-peek. */
import {
  AgentCallJob,
  BotCallJob,
  KernelAgentRelation,
  ProgrammaticJob,
  publishKernelSeat,
  SessionOverview,
  SessionPlexus,
  SessionSystemPrompt,
  SuccessfulOutcome,
} from "@inhuman.tools/harness-model";
import { test } from "vitest";

import { approve, approveLaw } from "./approve.js";
import {
  localClient,
  openTea,
  press,
  PRIOR_PROMPT,
  sealedCompletion,
  seatTurn,
  wrapTurn,
} from "../__visual__/_helpers.js";

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

test("closed meter", async () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  await approveLaw("agents-meter", ui.tea, {
    runs: [
      { text: "←: overview", role: "foreground", ink: "secondary", dim: false },
      { text: "2× QA", role: "foreground", ink: "rising", dim: false },
    ],
  });
});

test("open drawer", async () => {
  const client = localClient();
  seedAgentsDrawer(client);
  using ui = openTea(client);
  press(ui.tea, "ArrowLeft");
  await approve("agents-drawer", ui.tea);
});

test("sneak peek", async () => {
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
  await approve("agents-preview", ui.tea);
});
