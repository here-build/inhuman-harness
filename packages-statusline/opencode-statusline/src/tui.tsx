import { createRefresher } from "./refresher.js";

/** The slice of OpenCode's `@opencode/plugin/tui` Context this plugin uses (anomalyco/opencode, packages/plugin/src/tui/context.ts). */
interface TuiContext {
  readonly location: { readonly directory: string } | undefined;
  readonly theme: { readonly text: { readonly muted: unknown } };
  readonly data: {
    on(type: string, handler: () => void): () => void;
    location: { default(): { readonly directory: string } };
  };
  readonly storage: {
    memory<Value extends object>(
      key: string,
      options: { readonly initial: Value },
    ): readonly [Readonly<Value>, (mutation: (draft: Value) => void) => void];
  };
  readonly ui: {
    slot(claim: { append: "prompt.footer.status"; render: () => unknown }): () => void;
  };
}

// Events after which the working tree may have changed.
const REFRESH_ON = [
  "vcs.branch.updated",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.tool.success",
  "session.tool.failed",
  "session.shell.ended",
] as const;

export default {
  id: "inhuman.statusline",
  setup(context: TuiContext) {
    const [state, update] = context.storage.memory("clause", { initial: { text: "" } });
    const dir = context.location?.directory ?? context.data.location.default().directory;
    const refresher = createRefresher({
      dir,
      onChange: (text) => update((draft) => void (draft.text = text)),
    });
    const stops = REFRESH_ON.map((type) => context.data.on(type, () => void refresher.refresh()));
    stops.push(
      context.ui.slot({
        append: "prompt.footer.status",
        render: () => (state.text ? <text fg={context.theme.text.muted}>{state.text}</text> : null),
      }),
    );
    void refresher.refresh();
    return () => {
      for (const stop of stops) stop();
      refresher.stop();
    };
  },
};
