import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "storybook/test";

import { conversation, fresh } from "./scenes.js";
import { sessionStage, StoryApp } from "./story-app.js";
import { type ConnectScripts, PROJECT, WIRES, worldOf } from "./world.js";
import { connectError } from "../shell/connect-error.js";
import { projectHref } from "../shell/path.js";

const meta = {
  title: "Onboarding",
  component: StoryApp,
} satisfies Meta<typeof StoryApp>;

export default meta;
type Story = StoryObj<typeof meta>;

/*
 * The daemon's parks, as its drivers send them: one `harness/…` call in a
 * Scheme string. Authorize links are each provider's real endpoint with the
 * callback the daemon injects; the PKCE values are fixed, so Open reaches the
 * real sign-in page, and the story's own script finishes the flow.
 */
const scheme = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const authorize = (endpoint: string, params: Readonly<Record<string, string>>) => {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};
const PKCE = { code_challenge: "story-challenge", code_challenge_method: "S256" } as const;
const OIDC = (clientId: string, scope: string) => ({
  response_type: "code",
  client_id: clientId,
  scope,
  ...PKCE,
  state: "story-state",
});
const REDIRECT_PASTE = "Browser on another machine? Paste the address it ended on";
const OPEN = (url: string, hint: string, paste = "") =>
  `(harness/open-url :url ${scheme(url)} :description ${scheme(hint)}${paste === "" ? "" : ` :name ${scheme(paste)} :input 'password`})`;
const CHATGPT_SIGN_IN = OPEN(
  authorize("https://auth.openai.com/oauth/authorize", {
    ...OIDC("app_EMoamEEZ73f0CkXaXp7hrann", "openid profile email offline_access"),
    originator: "codex_cli_rs",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    redirect_uri: "http://localhost:1455/auth/callback",
  }),
  "Authorize ChatGPT in the browser",
  REDIRECT_PASTE,
);
const GROK_SIGN_IN = OPEN(
  authorize("https://auth.x.ai/oauth2/authorize", {
    ...OIDC("b1a00492-073a-47ea-816f-4c329264a828", "openid profile email offline_access grok-cli:access api:access"),
    redirect_uri: "http://127.0.0.1:53682/callback",
  }),
  "Authorize Grok in the browser",
  REDIRECT_PASTE,
);
const OPENROUTER_SIGN_IN = OPEN(
  authorize("https://openrouter.ai/auth", {
    ...PKCE,
    key_label: "Harness",
    callback_url: "http://127.0.0.1:53683/callback",
  }),
  "Authorize OpenRouter in the browser",
  "Or paste an OpenRouter key",
);
const KEY = (what: string) => `(harness/input :name "API key" :description "${what} API key" :secret #t)`;
const URL_FIELD = `(harness/input :name "Base URL" :description "OpenAI-compatible endpoint")`;
const OPTIONAL_KEY = `(harness/input :name "API key" :description "Optional. Empty to skip." :secret #t)`;

const chatgpt = WIRES.find((wire) => wire.id === "chatgpt");
if (chatgpt == null) throw new Error("the fixture lists no ChatGPT wire");

const scripts: ConnectScripts = {
  chatgpt: [CHATGPT_SIGN_IN, { after: 300, next: { done: "chatgpt", wire: chatgpt } }],
  openrouter: [OPENROUTER_SIGN_IN, { after: 300, next: { done: "chatgpt", wire: chatgpt } }],
  "openai-compat:Groq": [KEY("Groq"), { done: "chatgpt", wire: chatgpt }],
  "openai-compat:OpenAI-compatible": [URL_FIELD, OPTIONAL_KEY, { done: "chatgpt", wire: chatgpt }],
  "openai-compat:DeepSeek": [{ fail: "connect ECONNREFUSED 127.0.0.1:7788" }],
  "openai-compat:Mistral": [
    '(harness/confirm :title "Replace Mistral" :description "A Mistral connection exists. Replace it?")',
  ],
  "openai-compat:Together": ['(harness/notice :message "Together needs a terminal step")'],
  // Answers, but the kernel never lists the connection: the page holds on its landing line.
  "openai-compat:Cerebras": [KEY("Cerebras"), { done: "cerebras" }],
  // The daemon never answers the first call.
  "openai-compat:Fireworks": [{ hang: true }],
  grok: [GROK_SIGN_IN, { hang: true }],
};

type KernelOptions = NonNullable<NonNullable<Parameters<typeof worldOf>[1]>["kernel"]>;
/** A fresh session in a world with nothing connected. */
const world = (kernel: KernelOptions = {}) =>
  sessionStage(fresh, { kernel: { wires: [], ...kernel }, connect: scripts });

const root = (canvas: HTMLElement) => within(canvas.ownerDocument.body);
const tile = (canvas: HTMLElement, name: string) =>
  waitFor(() => {
    const found = [...canvas.ownerDocument.querySelectorAll<HTMLElement>("button.tile")].find(
      (node) => node.querySelector(".tile-name")?.textContent === name,
    );
    if (found == null) throw new Error(`no tile ${name}`);
    return found;
  });
const connect = async (canvas: HTMLElement, name: string) => {
  await userEvent.click(await tile(canvas, name));
};
/** Click Open without leaving the story: the link's own navigation is held back. */
const open = async (canvas: HTMLElement) => {
  canvas.ownerDocument.addEventListener("click", (event) => event.preventDefault(), { once: true });
  await userEvent.click(await root(canvas).findByRole("link", { name: "Open" }));
};

/** Nothing is connected: the page is the one task. Plans you pay for are large, the long tail small; no local server yet. */
export const Splash: Story = {
  args: { stage: world() },
};

/** The daemon found servers answering on this machine; they appear live, marked, while the page is open. */
export const LocalServers: Story = {
  args: {
    stage: world({
      local: [
        { name: "Ollama", port: 11_434 },
        { name: "LM Studio", port: 1234 },
      ],
    }),
  },
};

/** Typing filters the API-key providers; Enter takes the only match. */
export const Search: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await userEvent.type(await root(canvasElement).findByLabelText("Search providers that take an API key"), "mi");
  },
};

/** Nothing matches the filter. */
export const SearchEmpty: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await userEvent.type(await root(canvasElement).findByLabelText("Search providers that take an API key"), "zzz");
    await root(canvasElement).findByText("No provider matches.");
  },
};

/** A provider that takes a key: one labeled, secret field, in place of the grid. */
export const ApiKey: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "Groq");
    await root(canvasElement).findByLabelText("API key");
  },
};

/** A provider that signs in through the browser: a link, then Cancel. */
export const Browser: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "OpenRouter");
    await root(canvasElement).findByRole("link", { name: "Open" });
  },
};

/** Opening the link: the step waits for the browser and can still be cancelled. */
export const BrowserWaiting: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "Grok");
    await open(canvasElement);
    await root(canvasElement).findByText("Waiting for the browser…");
  },
};

/** Sign-in finished: the connection lands and the workspace takes the page. */
export const BrowserDone: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "OpenRouter");
    await open(canvasElement);
    await waitFor(() => {
      if (canvasElement.ownerDocument.querySelector(".composer") == null) throw new Error("still on the splash");
    });
  },
};

/** A browser on another machine cannot reach the daemon's callback: paste the address it ended on instead. */
export const BrowserPaste: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "ChatGPT");
    const field = await root(canvasElement).findByLabelText(REDIRECT_PASTE);
    if (!(field instanceof HTMLInputElement) || field.type !== "url") throw new Error("redirect paste should be a url");
  },
};

/** A custom endpoint asks for its address, then an optional key. */
export const CustomEndpoint: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "OpenAI-compatible");
    await userEvent.type(await root(canvasElement).findByLabelText("Base URL"), "http://127.0.0.1:8080/v1{Enter}");
    await root(canvasElement).findByText("Optional. Empty to skip.");
  },
};

/** Cancel leaves the flow and returns to the grid, focus on the tile it started from. */
export const Cancelled: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "Groq");
    await userEvent.click(await root(canvasElement).findByRole("button", { name: "Cancel" }));
    const groq = await tile(canvasElement, "Groq");
    await waitFor(() => {
      if (canvasElement.ownerDocument.activeElement !== groq) throw new Error("focus did not return");
    });
  },
};

/** The daemon could not start the flow: the reason and a retry. */
export const Failed: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "DeepSeek");
    const copy = connectError("DeepSeek", "connect ECONNREFUSED 127.0.0.1:7788");
    await root(canvasElement).findByText(copy.summary);
    await userEvent.click(await root(canvasElement).findByText("Details"));
    await root(canvasElement).findByText(copy.detail ?? "");
  },
};

/** A question the page can answer: accept or cancel. */
export const Confirm: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "Mistral");
    await root(canvasElement).findByRole("button", { name: "Accept" });
  },
};

/** A step the page cannot paint is finished in the terminal. */
export const UnknownForm: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "Together");
    await root(canvasElement).findByText(/Finish this in the terminal/);
  },
};

/** The splash on a phone: clusters stack at 16px gutters, no sideways scroll. */
export const Phone: Story = {
  args: { stage: world({ local: [{ name: "Ollama", port: 11_434 }] }) },
  globals: { viewport: { value: "mobile2", isRotated: false } },
};

/** The step on a phone. */
export const PhoneStep: Story = {
  args: { stage: world() },
  globals: { viewport: { value: "mobile2", isRotated: false } },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "ChatGPT");
    await root(canvasElement).findByLabelText(REDIRECT_PASTE);
  },
};

/** The same page in the dark scheme. */
export const Dark: Story = {
  args: { stage: world({ local: [{ name: "Ollama", port: 11_434 }] }) },
  globals: { scheme: "dark" },
};

/** The splash does not depend on the route: here, a project's index. */
export const ProjectRoute: Story = {
  args: {
    stage: () => ({ dial: worldOf([], { kernel: { wires: [] }, connect: scripts }), at: projectHref(PROJECT) }),
  },
};

/** And the workspace root, where it finds no composer to hide behind. */
export const WorkspaceRoute: Story = {
  args: { stage: () => ({ dial: worldOf([], { kernel: { wires: [] }, connect: scripts }), at: "/" }) },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "Groq");
    await root(canvasElement).findByLabelText("API key");
  },
};

/** With a provider connected, another is one row away in the model picker. */
export const AddProvider: Story = {
  args: { stage: sessionStage(conversation, { connect: scripts }) },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /^Model:/ }));
    const add = await waitFor(() => {
      const found = [...canvasElement.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent === "Add a provider",
      );
      if (found == null) throw new Error("no row");
      return found;
    });
    await userEvent.click(add);
  },
};

/** The first call is out and the daemon has not answered yet. */
export const Connecting: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "Fireworks");
    await root(canvasElement).findByText("Connecting…");
  },
};

/** The daemon made the connection; the page holds until the kernel lists it, then gives way. */
export const Landing: Story = {
  args: { stage: world() },
  play: async ({ canvasElement }) => {
    await connect(canvasElement, "Cerebras");
    await userEvent.type(await root(canvasElement).findByLabelText("API key"), "csk-test{Enter}");
    await root(canvasElement).findByText("Connected. Opening your workspace…");
  },
};

/** The line to the daemon dropped while the splash is up: the notice sits under the heading, the tiles wait. */
export const Reconnecting: Story = {
  args: { stage: sessionStage(fresh, { kernel: { wires: [] }, connect: scripts, link: { kind: "reconnecting" } }) },
  play: async ({ canvasElement }) => {
    await root(canvasElement).findByText(/Reconnecting to the daemon/);
    const groq = await tile(canvasElement, "Groq");
    if (!(groq as HTMLButtonElement).disabled) throw new Error("tiles should wait for the line");
  },
};

/** The kernel is readable but no port to write through is bound yet: every tile waits, disabled. */
export const NoPort: Story = {
  args: { stage: sessionStage(fresh, { kernel: { wires: [] }, connect: scripts, portless: true }) },
  play: async ({ canvasElement }) => {
    const groq = await tile(canvasElement, "Groq");
    if (!(groq as HTMLButtonElement).disabled) throw new Error("tiles should wait for a port");
  },
};

/** "Add a provider" runs the same step inside the picker, in place of its list. */
export const AddProviderStep: Story = {
  args: { stage: sessionStage(conversation, { connect: scripts }) },
  play: async (context) => {
    await AddProvider.play?.(context);
    const groq = await waitFor(() => {
      const found = [...context.canvasElement.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent.startsWith("Groq"),
      );
      if (found == null) throw new Error("no Groq row");
      return found;
    });
    await userEvent.click(groq);
    await root(context.canvasElement).findByLabelText("API key");
  },
};
