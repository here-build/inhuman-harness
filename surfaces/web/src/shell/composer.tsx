import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CLASS_LABELS, FileMutateToolJob, SessionTurn, ToolCallJob, isAtTip } from "@inhuman.tools/harness-model";
import { ToolBodyView } from "@inhuman.tools/harness-transcript";
import { toolSummary } from "@inhuman.tools/harness-transcript/tape-read";
import { toolLabel } from "@inhuman.tools/harness-transcript/tool-label";
import { toolReceipt, type ToolBody } from "@inhuman.tools/harness-transcript/tool-receipt";
import {
  ComposerBlock,
  AckBlock,
  adoptPictureFiles,
  clipboardImageFiles,
  turnVisualPayload,
  useSkillSlash,
} from "@inhuman.tools/harness-ui";
import { observer } from "mobx-react-lite";

import { ackCopy, answerRequest, choiceByKey, promptKind, storeChoices } from "./ack-prompt.js";
import { askHeading, askRisk, type AskAct } from "./ask-risk.js";
import { connectPort } from "./connect-step.js";
import { armCover, confirmCover, seatForAsk, throttleMs, type CoverSeat } from "./cover.js";
import { bindDraft, cloneDraftPicture, type DraftPicture } from "./draft-slot.js";
import { restoreMessages, restoreTarget } from "./edit-message.js";
import { turnIsLive } from "./light.js";
import { LinkNotice } from "./link-notice.js";
import { completionWires, naturalName, sessionModel, type ModelChoice } from "./model-choice.js";
import { ModelPicker } from "./model-picker.js";
import { admitStagedSession, peekSession, stagedAgents, takeSession } from "./new-session.js";
import { PermissionMode } from "./permission-mode.js";
import { ReasoningEffortPicker } from "./reasoning-effort.js";
import { SessionStatus } from "./session-status.js";
import { StageComposer } from "./stage-composer.js";
import { useDial } from "../client/context.js";

type DraftState = {
  draft: string;
  pictures: DraftPicture[];
  revision: number;
  /** Closes the gap before the `turn` RPC returns. The document has no in-flight bit. */
  sending: boolean;
  /** Keeps the connection and model writes from interleaving. The select still shows `kvs`. */
  choosing: boolean;
  /** The turn a Stop asked to cancel. The daemon writes `cancelRequested`; this paints it until the echo. */
  stopping: string;
  status: string;
};

export const Composer = observer(function ComposerView() {
  const dial = useDial();
  const drafts = useRef(new Map<string, DraftState>());
  const [, repaint] = useState(0);
  const session = dial.session;
  // The project page holds the field before a session exists. Overview does not.
  if (session == null) {
    if (dial.requestedTarget.kind === "project" && dial.kernel != null) {
      return <StageComposer path={dial.requestedTarget.path} />;
    }
    return null;
  }
  const sessionId = session.root.uuid;
  let state = drafts.current.get(sessionId);
  if (state == null) {
    state = { draft: "", pictures: [], revision: 0, sending: false, choosing: false, stopping: "", status: "" };
    drafts.current.set(sessionId, state);
  }
  return <SessionComposer state={state} refresh={() => repaint((value) => value + 1)} />;
});

const SessionComposer = observer(function SessionComposerView({
  state,
  refresh,
}: {
  readonly state: DraftState;
  readonly refresh: () => void;
}) {
  const dial = useDial();
  const session = dial.session;
  const running = <T extends { readonly uuid: string; readonly cutOff: boolean }>(turn: T | null): turn is T =>
    turnIsLive(turn) && turn.uuid !== state.stopping;
  const openTurn = session?.root.findRunningTurn() ?? null;
  const live = running(openTurn) ? openTurn : null;
  const ask = live?.approvalHead ?? null;
  const askId = ask?.uuid ?? null;
  const waitMs = throttleMs(dial.kernel?.root.approvalAskThrottleMs);
  const [comment, setComment] = useState("");
  const [remember, setRemember] = useState({ leafId: "", key: "" });
  const [seat, setSeat] = useState<CoverSeat>(() =>
    session == null
      ? { phase: "inert", leafId: null }
      : seatForAsk({ phase: "draft", leafId: null }, askId, state.draft.trim() === "", waitMs),
  );
  const draftRef = useRef(state.draft);
  draftRef.current = state.draft;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const fieldRef = useRef<HTMLDivElement>(null);
  const adoptDrop = useCallback(
    (files: readonly File[]) => {
      void adoptPictureFiles(state, files, true, () => refreshRef.current());
    },
    [state],
  );
  const draftInputRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const deciding = useRef(false);
  const decideRef = useRef<(allow: boolean) => void>(() => undefined);

  useEffect(() => {
    if (session == null) return;
    return bindDraft(session.root.uuid, {
      state,
      refresh: () => refreshRef.current(),
      focus: () => draftInputRef.current?.focus(),
    });
  }, [session, state]);

  useEffect(() => {
    const open = session;
    const id = open?.root.sessionId;
    const rpc = dial.sessionRpc;
    if (open == null || id == null || rpc == null || dial.attaching || dial.session !== open) return;
    if (peekSession(id) == null) return;
    const run = { cancelled: false };
    const timer = setTimeout(() => {
      if (run.cancelled || dial.session !== open || dial.sessionRpc !== rpc || dial.attaching) return;
      const payload = takeSession(id);
      if (payload == null) return;
      const box = state;
      let placed = false;
      if (box.draft.trim() === "") {
        box.draft = payload.prompt;
        placed = true;
      }
      if (box.pictures.length === 0 && payload.pictures.length > 0) {
        box.pictures = payload.pictures.map(cloneDraftPicture);
        placed = true;
      }
      if (placed) box.revision += 1;
      const revision = box.revision;
      box.sending = true;
      box.status = "";
      refreshRef.current();
      void (async () => {
        try {
          const outcome = await admitStagedSession(
            open.root.agent.spec,
            rpc,
            payload,
            stagedAgents(dial.kernel?.root.bots, dial.project?.root.bots),
          );
          if (run.cancelled) return;
          if (!outcome.ok) {
            box.status = outcome.status;
            return;
          }
          if (box.revision === revision) {
            box.draft = "";
            box.pictures = [];
          }
          if (outcome.status !== "") box.status = outcome.status;
        } catch (error) {
          if (!run.cancelled)
            box.status = error instanceof Error ? error.message : "Could not send. Your draft is saved.";
        } finally {
          if (!run.cancelled) {
            box.sending = false;
            refreshRef.current();
          }
        }
      })();
    }, 0);
    return () => {
      run.cancelled = true;
      clearTimeout(timer);
    };
  }, [session, state, dial, dial.sessionRpc, dial.attaching, dial.session]);

  useEffect(() => {
    setComment("");
    setSeat((previous) =>
      session == null
        ? { phase: "inert", leafId: null }
        : seatForAsk(previous, askId, draftRef.current.trim() === "", waitMs),
    );
  }, [askId, session, waitMs]);

  // A picker torn down while open never toggles closed.
  useEffect(() => () => dial.look([]), [dial]);

  useEffect(() => {
    if (seat.phase !== "cover_throttled") return;
    const leafId = seat.leafId;
    const timer = setTimeout(
      () => setSeat((current) => (current.leafId === leafId ? armCover(current) : current)),
      waitMs,
    );
    return () => clearTimeout(timer);
  }, [seat.phase, seat.leafId, waitMs]);

  // A line that is down or redialing takes no writes; the notice above says why.
  const unavailable = session == null || dial.attaching || dial.sessionRpc == null || dial.link != null;
  const covered = ask != null;
  const armed = ask != null && confirmCover(seat, ask.uuid);
  const hasBody = state.draft.trim() !== "" || state.pictures.length > 0;
  const canSend = !unavailable && !covered && live == null && !state.sending && hasBody;
  const canStop = !unavailable && !covered && live != null;
  const episodeHead = session?.root.head ?? null;
  const restoreId =
    episodeHead instanceof SessionTurn && session != null ? restoreTarget(episodeHead, session.root.tip) : null;
  const canRestore = restoreId != null && !unavailable && !covered && live == null && !state.sending;
  // An interrupted head at the tip: Enter on an empty draft resumes the loop, as in the TUI.
  const canResume =
    !hasBody &&
    !unavailable &&
    !covered &&
    live == null &&
    !state.sending &&
    episodeHead instanceof SessionTurn &&
    episodeHead.lastTurnIncomplete &&
    isAtTip(episodeHead, session.root.tip);
  const slash = useSkillSlash({
    scope: session?.root.uuid ?? "",
    rows: session?.root.skills ?? [],
    value: state.draft,
    disabled: unavailable || covered || state.sending,
    fieldRef: draftInputRef,
    onChange: (value) => {
      state.draft = value;
      state.revision += 1;
      refresh();
    },
  });

  async function restore(): Promise<void> {
    if (session == null || !(episodeHead instanceof SessionTurn) || !canRestore) return;
    await restoreMessages(dial, episodeHead, session.root.tip);
    refresh();
  }

  async function send(): Promise<void> {
    const rpc = dial.sessionRpc;
    // This mutable, session-local guard closes the gap before React repaints.
    // A live turn is not steered or queued: pictures stay in the draft.
    if (session == null || dial.session !== session || dial.attaching || rpc == null || state.sending) return;
    if (running(session.root.findRunningTurn())) return;
    if (state.draft.trim() === "" && state.pictures.length === 0) return;
    const prompt = state.draft;
    const pictures = state.pictures.map(cloneDraftPicture);
    const revision = state.revision;
    state.sending = true;
    state.status = "";
    refresh();
    try {
      const visuals = turnVisualPayload(pictures);
      const result = await rpc.request("turn", visuals.length === 0 ? { prompt } : { prompt, visuals });
      if (state.revision === revision) {
        if (isOk(result)) {
          state.draft = "";
          state.pictures = [];
        } else {
          state.draft = prompt;
          state.pictures = pictures;
          state.status = "Message was not accepted. Your draft is saved.";
        }
      } else if (!isOk(result)) state.status = "Message was not accepted. Your draft is saved.";
    } catch (error) {
      if (state.revision === revision) {
        state.draft = prompt;
        state.pictures = pictures;
      }
      state.status = error instanceof Error ? error.message : "Could not send. Your draft is saved.";
    } finally {
      state.sending = false;
      refresh();
    }
  }

  async function resume(): Promise<void> {
    const rpc = dial.sessionRpc;
    if (session == null || dial.session !== session || rpc == null || !canResume) return;
    state.sending = true;
    state.status = "";
    refresh();
    try {
      const result = await rpc.request("turn", { prompt: "", kind: "continue" });
      if (!isOk(result)) state.status = "Resume was not accepted.";
    } catch (error) {
      state.status = error instanceof Error ? error.message : "Could not resume the turn.";
    } finally {
      state.sending = false;
      refresh();
    }
  }

  async function stop(): Promise<void> {
    const rpc = dial.sessionRpc;
    const turn = session?.root.findRunningTurn() ?? null;
    if (session == null || dial.session !== session || dial.attaching || rpc == null || !running(turn)) return;
    state.status = "";
    state.stopping = turn.uuid;
    refresh();
    try {
      const result = await rpc.request("turn/cancel", { turnId: turn.uuid });
      if (!isOk(result)) {
        state.stopping = "";
        state.status = "Stop was not accepted.";
      }
    } catch (error) {
      state.stopping = "";
      state.status = error instanceof Error ? error.message : "Could not stop the turn.";
    }
    refresh();
  }

  /** The daemon applies the answer; this only names the ask it saw. */
  async function writeApprove(allow: boolean): Promise<void> {
    const rpc = dial.sessionRpc;
    if (deciding.current || unavailable || rpc == null || dial.session !== session || ask == null) return;
    const head = session.root.findRunningTurn()?.approvalHead;
    if (head == null || head.humanApprove != null || !confirmCover(seat, head.uuid) || head.uuid !== ask.uuid) return;
    deciding.current = true;
    const note = comment.trim();
    setComment("");
    setSeat({ phase: "draft", leafId: null });
    try {
      const sent = answerRequest({
        kind: promptKind(head),
        sessionId: session.root.sessionId,
        jobId: head.uuid,
        yes: allow,
        comment: note,
        remember: remember.leafId === head.uuid ? choiceByKey(choices, remember.key) : null,
      });
      const result = await rpc.request(sent.method, sent.params);
      if (!isOk(result)) state.status = "Decision was not accepted.";
    } catch (error) {
      state.status = error instanceof Error ? error.message : "Could not send the decision.";
    } finally {
      deciding.current = false;
    }
    refresh();
  }

  /**
   * Allow this call, and from now on let the judge decide every call of its classes (here: this
   * session, or every session in the project). The override goes in first so the next call sees it.
   */
  async function writeAlwaysAuto(scope: "session" | "project"): Promise<void> {
    const rpc = dial.sessionRpc;
    if (deciding.current || unavailable || rpc == null || dial.session !== session || ask == null) return;
    const classes = ask instanceof ToolCallJob ? ask.policyClasses : [];
    if (classes.length === 0) return;
    try {
      for (const id of classes) await rpc.request("policy/class-mode", { class: id, mode: "auto", scope });
    } catch (error) {
      state.status = error instanceof Error ? error.message : "Could not change the class mode.";
      refresh();
      return;
    }
    await writeApprove(true);
  }

  async function choose(next: ModelChoice): Promise<void> {
    const rpc = dial.sessionRpc;
    const open = session;
    if (open == null || dial.session !== open || dial.attaching || rpc == null || state.choosing) return;
    const baselineConnection = sessionKv(open.root, "connection");
    const baselineModel = sessionKv(open.root, "model");
    if (next.connection === baselineConnection && next.model === baselineModel) return;
    state.choosing = true;
    state.status = "";
    refresh();
    try {
      const connectionResult = await rpc.request("kv/set", {
        key: "connection",
        value: next.connection,
        remember: true,
      });
      if (!isOk(connectionResult)) {
        state.status = "Model was not changed.";
        return;
      }
      const modelResult = await rpc.request("kv/set", {
        key: "model",
        value: next.model,
        remember: true,
      });
      if (!isOk(modelResult)) state.status = "Connection changed, but the model was not.";
    } catch (error) {
      state.status = error instanceof Error ? error.message : "Could not change the model.";
    } finally {
      state.choosing = false;
      refresh();
    }
  }

  function onDraftKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (slash.onKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canResume) void resume();
      else if (!covered) void send();
    }
    if (event.key === "Escape" && canStop) {
      event.preventDefault();
      void stop();
    }
  }

  const showStop = !hasBody && canStop;
  const showEnter = hasBody;
  const pictureHold =
    live != null && state.pictures.length > 0 ? "A picture stays in the draft while a turn is in progress." : "";
  const notice = state.status !== "" ? state.status : pictureHold;

  const shown = sessionModel(session?.root);
  const wires = completionWires(dial.kernel?.root.connections);
  const projectPath = session?.root.path ?? "";
  const act = ask instanceof ToolCallJob ? toAct(ask, projectPath) : null;
  const risk = act == null ? { destructive: false, phrase: "" } : askRisk(act);
  const heading = act == null ? "Pending action" : askHeading(act, toolLabel);
  const summary = ask instanceof ToolCallJob ? summaryBeside(ask, projectPath) : null;
  const kind = ask == null ? "ask" : promptKind(ask);
  const copy = ackCopy(kind, ask?.policyResult === "deny");
  const choices = ask == null || kind === "ask" ? [] : storeChoices(ask.ackOptions, { bot: botSession(dial) });
  // Offered on a plain ask that the floor classed; an acknowledgement is a flag, not a class mode.
  const alwaysAutoClasses = ask instanceof ToolCallJob && kind === "ask" ? ask.policyClasses : [];
  decideRef.current = (allow) => {
    void writeApprove(allow);
  };

  // The cover takes the draft out of the tab order. The heading is where focus lands,
  // again when the card arms, so a screen reader announces the request.
  useEffect(() => {
    if (!covered) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [covered, armed, askId]);

  useEffect(() => {
    if (!armed) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.isComposing || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key !== "Enter" && event.key !== "Backspace") return;
      event.preventDefault();
      decideRef.current(event.key === "Enter");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  return (
    <ComposerBlock
      hidden={dial.kernel == null}
      topNotices={
        <>
          {dial.kernel == null ? null : <LinkNotice />}
          <SessionStatus session={session?.root ?? null} />
        </>
      }
      notice={notice}
      canRestore={canRestore}
      onRestore={() => {
        void restore();
      }}
      wrapDraftInert
      cover={
        ask == null
          ? null
          : {
              leafId: ask.uuid,
              headingRef,
              heading,
              isAck: kind !== "ask",
              kicker: copy.kicker,
              summary,
              lede: copy.lede,
              proposedOperation: ask instanceof ToolCallJob ? <AskReceipt ask={ask} projectPath={projectPath} /> : null,
              ackBlock:
                kind === "ask" ? null : (
                  <AckBlock
                    flags={ask.ackFlags}
                    choices={choices}
                    remember={remember.leafId === ask.uuid ? remember.key : ""}
                    disabled={unavailable || !armed}
                    onRemember={(key) => setRemember({ leafId: ask.uuid, key })}
                  />
                ),
              comment: seat.leafId === ask.uuid ? comment : "",
              disabled: unavailable || !armed,
              armed,
              copyYes: copy.yes,
              copyNo: copy.no,
              destructive: risk.destructive,
              riskPhrase: risk.phrase,
              alwaysAutoLabels: alwaysAutoClasses.map((id) => CLASS_LABELS[id].toLowerCase()),
              onCommentChange: setComment,
              onDeny: () => {
                void writeApprove(false);
              },
              onAllow: () => {
                void writeApprove(true);
              },
              onAlwaysAuto: (scope) => {
                void writeAlwaysAuto(scope);
              },
            }
      }
      fieldRef={draftInputRef}
      pillRef={fieldRef}
      dropEnabled={!covered && session != null}
      onDropFiles={adoptDrop}
      pictures={state.pictures}
      picturesDisabled={session == null || covered || state.sending}
      onRemovePicture={(key) => {
        state.pictures = state.pictures.filter((picture) => picture.key !== key);
        state.revision += 1;
        refresh();
      }}
      onPickPictures={(files) => {
        void adoptPictureFiles(state, files, true, refresh);
      }}
      slashMenu={slash.menu}
      slashFieldProps={slash.fieldProps}
      draftLabel="Message draft"
      draftDisabled={session == null}
      draftPlaceholder={
        canResume
          ? "Interrupted · Enter to resume, or type a message"
          : session?.root.head == null
            ? "Ask or describe a change · / for skills"
            : "Message · / for skills"
      }
      draft={state.draft}
      onDraftChange={(value, element) => {
        state.draft = value;
        slash.track(element);
        state.revision += 1;
        refresh();
      }}
      onDraftKeyDown={onDraftKey}
      onDraftPaste={(event) => {
        const files = clipboardImageFiles(event.clipboardData);
        if (files.length === 0) return;
        if (event.clipboardData.getData("text/plain") === "") event.preventDefault();
        void adoptPictureFiles(state, files, false, refresh);
      }}
      showSend={showEnter}
      canSend={canSend}
      onSend={() => {
        void send();
      }}
      showResume={canResume}
      onResume={() => {
        void resume();
      }}
      showStop={showStop}
      onStop={() => {
        void stop();
      }}
      lane={
        session == null ? null : (
          <>
            {wires.length === 0 ? (
              <span className="truncate text-sm font-strong text-ink">
                {shown.model.trim() === "" ? "None" : naturalName(shown.model)}
              </span>
            ) : (
              <ModelPicker
                wires={wires}
                current={shown}
                request={connectPort(dial)}
                disabled={unavailable || state.choosing}
                onChoose={(choice) => {
                  void choose(choice);
                }}
                onLook={(connectionIds, driverNames) => dial.look(connectionIds, driverNames)}
              />
            )}
            <ReasoningEffortPicker
              model={shown}
              wires={wires}
              agentEffort={session.root.agent?.spec?.reasoningEffort ?? null}
              disabled={unavailable || state.choosing}
            />
          </>
        )
      }
      footer={session == null ? null : <PermissionMode />}
    />
  );
});

/**
 * The proposed operation, painted as the tape will paint it: a diff, a terminal, or the arguments.
 * An observer, so a diff against a prior held in a blob fills in when the text lands.
 */
export const AskReceipt = observer(function AskReceiptView({
  ask,
  projectPath,
}: {
  readonly ask: ToolCallJob;
  readonly projectPath: string;
}) {
  const body = toolReceipt(ask, [], projectPath);
  return (
    <div className="ask-receipt mb-3" aria-label="Proposed operation">
      {body.kind === "empty" ? (
        <pre className="tool-body">
          <code>{JSON.stringify(ask.args, null, 2)}</code>
        </pre>
      ) : (
        <ToolBodyView body={body} expanded />
      )}
    </div>
  );
});

function isOk(result: unknown): boolean {
  return typeof result === "object" && result != null && "ok" in result && result.ok === true;
}

function toAct(ask: ToolCallJob, projectPath: string): AskAct {
  return {
    name: ask.name,
    args: ask.args,
    projectPath,
    existed: ask instanceof FileMutateToolJob ? ask.existed : null,
  };
}

/** The mono line stays only when the receipt has no body that already shows the command or path. */
function summaryBeside(ask: ToolCallJob, projectPath: string): string | null {
  if (receiptShowsAct(toolReceipt(ask, [], projectPath), ask.args)) return null;
  const summary = toolSummary(ask).trim();
  return summary === "" ? null : summary;
}

function receiptShowsAct(body: ToolBody, args: ToolCallJob["args"]): boolean {
  if (body.kind !== "empty") return true;
  // An empty tool body still prints its arguments, so that pre is the receipt.
  if (args == null) return false;
  return Object.values(args).some((value) => value != null && value !== "");
}

/** Missing keys and the navigation fixture's bare root both read as empty. */
function sessionKv(root: { readonly kvs?: Readonly<Record<string, string>> } | null | undefined, key: string): string {
  return root?.kvs?.[key] ?? "";
}

/** A bot's own session may remember at bot scope: its name is in a roster that points at this session. */
function botSession(dial: ReturnType<typeof useDial>): boolean {
  const id = dial.session?.root.sessionId;
  if (id == null || id === "") return false;
  const rosters = [dial.kernel?.root.botsRoster, dial.project?.root.botsRoster];
  return rosters.some((roster) => roster != null && Object.values(roster).includes(id));
}
