import {
  Component,
  createContext,
  type CSSProperties,
  Fragment,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CallJob,
  type ProgrammaticJob,
  type SessionOverview,
  type SessionPlexus,
  type SessionRoot,
  type SessionTurn,
} from "@inhuman.tools/harness-model";
import { isWorkflowLeafMeta } from "@inhuman.tools/harness-model/session";
import { IconBinaryTree2, IconInfoCircle, IconLoader2, IconX } from "@tabler/icons-react";
import { observer } from "mobx-react-lite";
import { createPortal } from "react-dom";

import { glanceOf, LOOK_VERB, lookSentences, sessionBeats } from "./session-beats.js";
import { useDial } from "../../harness-web-app/src/client/context.js";
import { Button } from "../../harness-web-app/src/components/ui/button.js";
import { glyph } from "../../harness-web-app/src/components/ui/glyph.js";
import { CodeView } from "../../harness-web-app/src/shell/code-view.js";
import { DiffView } from "../../harness-web-app/src/shell/diff-view.js";
import { canEditMessages, editMessage } from "../../harness-web-app/src/shell/edit-message.js";
import { type OpenFile, useFilePreview } from "../../harness-web-app/src/shell/file-sidebar.js";
import { LinkNotice } from "../../harness-web-app/src/shell/link-notice.js";
import { Markdown } from "../../harness-web-app/src/shell/markdown.js";
import { naturalName, wireName } from "../../harness-web-app/src/shell/model-choice.js";
import { projectNames } from "../../harness-web-app/src/shell/path.js";
import { readStoredVisual } from "../../harness-web-app/src/shell/picture-draft.js";
import { fileFace, readListParts } from "../../harness-web-app/src/shell/read-line.js";
import { ShellTerm } from "../../harness-web-app/src/shell/shell-term.js";
import {
  type AgentSpan,
  agentSpans,
  type ModelSpan,
  modelSpans,
  stickyBeats,
  type TapeBeat,
} from "../../harness-web-app/src/shell/tape-beats.js";
import { turnBeats } from "../../harness-web-app/src/shell/tape-live.js";
import {
  type AgentCell,
  agentCell,
  agentFace,
  type AgentState,
  type LookItem,
  type TapeBodyCell,
  type ToolBody,
  userPictureLine,
} from "../../harness-web-app/src/shell/tape-read.js";
import { toolLabel } from "../../harness-web-app/src/shell/tool-label.js";
import {
  outcomeOf,
  schemeHead,
  schemeSummary,
  type ToolOutcome,
} from "../../harness-web-app/src/shell/tool-receipt.js";
import { jobCells } from "../../harness-web-app/src/workflow/cell.js";
import { useWorkflowGraph } from "../../harness-web-app/src/workflow/use-workflow-graph.js";
import { WorkflowGraph } from "../../harness-web-app/src/workflow/workflow-graph.js";

/** The session whose tape this is. A program's graph is addressed by it. */
const SessionIdContext = createContext("");

class CellFence extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) return <p className="tool-empty">This part of the conversation could not be shown.</p>;
    return this.props.children;
  }
}

/** The verb in words, the object in mono, the wire name on the title. */
function ToolSummary({ summary }: { readonly summary: string }) {
  const gap = summary.indexOf(" ");
  const name = gap === -1 ? summary : summary.slice(0, gap);
  const object = gap === -1 ? "" : summary.slice(gap + 1);
  return (
    <span className="tool-summary" title={name}>
      {toolLabel(name)}
      {object === "" ? null : (
        <>
          {" "}
          <span className="mono">{object}</span>
        </>
      )}
    </span>
  );
}

function CellView({
  cell,
  onOpen,
  onEdit,
}: {
  readonly cell: TapeBodyCell;
  readonly onOpen: (file: OpenFile) => void;
  readonly onEdit?: () => void;
}) {
  if (cell.kind === "user") {
    const visuals = cell.visuals ?? [];
    return (
      <section className="tape-message tape-user" aria-label="Your message" data-copy={cell.text}>
        {cell.text === "" ? null : <p className="user-text">{cell.text}</p>}
        {visuals.length === 0 ? null : <UserPictures visuals={visuals} />}
        {onEdit == null ? null : (
          <button type="button" className="message-edit" onClick={onEdit}>
            Edit
          </button>
        )}
      </section>
    );
  }
  if (cell.kind === "speech") {
    return (
      <section className="tape-message tape-assistant" aria-label="Assistant message" data-copy={cell.text}>
        <div className="assistant-body">{cell.text === "" ? null : <Markdown text={cell.text} />}</div>
      </section>
    );
  }
  if (cell.kind === "reads") return <ReadLine cell={cell} onOpen={onOpen} />;
  if (cell.body.kind === "diff" || cell.body.kind === "shell" || cell.body.kind === "fail-line") {
    return <ToolBodyView body={cell.body} onOpen={onOpen} outcome={cell.outcome} />;
  }
  return (
    <details className="tape-tool">
      <summary>
        <ToolSummary summary={cell.summary} />
        <Outcome outcome={cell.outcome} />
      </summary>
      <Findable>
        {cell.program == null ? null : <GraphButton program={cell.program} />}
        <ToolBodyView body={cell.body} />
        {cell.nested == null || cell.nested.length === 0
          ? null
          : cell.nested
              .filter((inner): inner is TapeBodyCell => inner.kind !== "round" && inner.kind !== "progress")
              .map((inner) => (
                <CellFence key={inner.id}>
                  <CellView cell={inner} onOpen={onOpen} />
                </CellFence>
              ))}
      </Findable>
    </details>
  );
}

type UserVisual = NonNullable<Extract<TapeBodyCell, { kind: "user" }>["visuals"]>[number];

function UserPictures({ visuals }: { readonly visuals: readonly UserVisual[] }) {
  return (
    <div className="user-pictures">
      {visuals.map((visual, index) => (
        <UserPicture key={visual.id} visual={visual} index={index} />
      ))}
    </div>
  );
}

/** Bytes come from `turn/visual`. The identity line never becomes a remote fetch. */
const UserPicture = observer(function UserPictureView({
  visual,
  index,
}: {
  readonly visual: UserVisual;
  readonly index: number;
}) {
  const dial = useDial();
  const [bytes, setBytes] = useState<string | null>(null);
  const [mime, setMime] = useState(visual.mime);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const rpc = dial.sessionRpc;
    if (rpc == null) {
      setFailed(true);
      setBytes(null);
      return;
    }
    let cancelled = false;
    setFailed(false);
    setBytes(null);
    const load = async (): Promise<void> => {
      try {
        const read = readStoredVisual(await rpc.request("turn/visual", { id: visual.id }));
        if (cancelled) return;
        if (read?.id !== visual.id) {
          setFailed(true);
          return;
        }
        setMime(read.mime);
        setBytes(read.bytesBase64);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [dial.sessionRpc, visual.id]);
  const label = userPictureLine(index, visual);
  const src = bytes == null ? null : `data:${mime};base64,${bytes}`;
  return (
    <figure className="user-picture" title={label}>
      {failed ? <p className="user-picture-miss">The picture could not be loaded.</p> : null}
      {src == null ? null : (
        <>
          <button type="button" className="user-picture-open" aria-label={label} onClick={() => setOpen(true)}>
            <img alt="" src={src} />
          </button>
          {open ? <PicturePreview url={src} label={label} onClose={() => setOpen(false)} /> : null}
        </>
      )}
    </figure>
  );
});

function PicturePreview({
  url,
  label,
  onClose,
}: {
  readonly url: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const [node, setNode] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (node == null || node.open) return;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
  }, [node]);
  return (
    <dialog
      ref={setNode}
      className="picture-preview"
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <img src={url} alt={label} />
    </dialog>
  );
}

function Findable({ children }: { readonly children: ReactNode }) {
  return (
    <div className="tool-disclosure" data-hidden="until-found">
      {children}
    </div>
  );
}

/** A run of read-family calls: one sentence per verb, in call order. Each item opens what it saw. */
function ReadLine({
  cell,
  onOpen,
}: {
  readonly cell: Extract<TapeBodyCell, { kind: "reads" }>;
  readonly onOpen: (file: OpenFile) => void;
}) {
  const sentences = lookSentences(cell.items);
  return (
    <div className="read-lines">
      {sentences.map((items) => (
        <LookSentence key={items[0]!.id} items={items} onOpen={onOpen} />
      ))}
    </div>
  );
}

function LookSentence({
  items,
  onOpen,
}: {
  readonly items: readonly LookItem[];
  readonly onOpen: (file: OpenFile) => void;
}) {
  const locales = typeof navigator === "undefined" ? undefined : navigator.languages;
  const parts = readListParts(
    items.map((item) => item.label),
    locales,
  );
  let at = -1;
  return (
    <p className="read-line">
      {LOOK_VERB[items[0]!.verb]}{" "}
      {parts.map((part, index) => {
        if (part.kind === "text") return <span key={index}>{part.text}</span>;
        at += 1;
        const item = items.at(at);
        return item == null ? null : <LookTarget item={item} key={item.id} onOpen={onOpen} />;
      })}
    </p>
  );
}

function LookTarget({ item, onOpen }: { readonly item: LookItem; readonly onOpen: (file: OpenFile) => void }) {
  const scope =
    item.scope === undefined ? null : (
      <>
        {" in "}
        <span className="mono">{item.scope}</span>
      </>
    );
  if (item.outcome === "failed") {
    return (
      <span className="look-target">
        <span className="read-path" data-failed="">
          {item.label}
        </span>
        {scope}
        <FailInfo detail={item.text ?? "The call failed."} />
      </span>
    );
  }
  const binary = item.verb === "read" && fileFace(item.path) === "binary";
  // A file opens from disk without the bytes; a listing or matches exist only as the result.
  const missing = item.text == null && (item.verb !== "read" || item.label.endsWith("/"));
  if (missing && item.outcome === "ok" && item.verb !== "read") {
    return (
      <span className="look-target">
        <span className="mono">{item.label}</span>
        {scope}
        <span className="text-subtle"> (no matches)</span>
      </span>
    );
  }
  return (
    <span className="look-target">
      <button
        className="read-path"
        disabled={binary || missing}
        type="button"
        title={binary ? `${item.path} (binary)` : item.verb === "read" ? item.path : undefined}
        onClick={() =>
          onOpen({
            path: item.path,
            label: item.verb === "read" ? item.label : `${LOOK_VERB[item.verb]} ${item.label}`,
            ...(item.text == null ? {} : { text: item.text }),
          })
        }
      >
        {item.label}
      </button>
      {scope}
      {item.outcome === "live" ? <Outcome outcome="live" /> : null}
    </span>
  );
}

export function Outcome({ outcome }: { readonly outcome: ToolOutcome }) {
  if (outcome === "ok") return null;
  if (outcome === "live") {
    return (
      <span className="tool-outcome" data-outcome="live" role="status">
        <IconLoader2 className="tool-spinner" {...glyph} aria-label="in progress" />
      </span>
    );
  }
  return (
    <span className="tool-outcome label" data-outcome="failed">
      failed
    </span>
  );
}

function FailLine({
  body,
  onOpen,
}: {
  readonly body: Extract<ToolBody, { kind: "fail-line" }>;
  readonly onOpen?: (file: OpenFile) => void;
}) {
  const path =
    body.label === "" ? null : onOpen == null ? (
      <span className="read-path">{body.label}</span>
    ) : (
      <button
        className="read-path"
        type="button"
        title={body.path}
        onClick={() => onOpen({ path: body.path, label: body.label })}
      >
        {body.label}
      </button>
    );
  return (
    <p className="fail-line">
      Failed to {body.verb}
      {path == null ? null : <> {path}</>} <FailInfo detail={body.detail} />
    </p>
  );
}

/** Long enough to cross the gap onto the tip. The tip is in the top layer, so the button's box does not contain it. */
const TIP_HIDE_MS = 120;

/** Why a call failed, one hover or focus away. A popover, so the tape's scrollport cannot clip it. */
function FailInfo({ detail }: { readonly detail: string }) {
  const tipId = useId();
  const anchor = `--fail-${tipId.replaceAll(/[^\w-]/g, "")}`;
  const tip = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const show = (): void => {
    clearTimeout(hideTimer.current);
    const node = tip.current;
    if (node?.matches(":popover-open") === false) node.showPopover();
  };
  const hide = (): void => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const node = tip.current;
      const button = trigger.current;
      const focused = document.activeElement;
      if (
        node == null ||
        node.matches(":hover") ||
        node.contains(focused) ||
        button?.matches(":hover") === true ||
        focused === button
      ) {
        return;
      }
      if (node.matches(":popover-open")) node.hidePopover();
    }, TIP_HIDE_MS);
  };
  return (
    <span className="fail-info" style={{ "--fail-anchor": anchor } as CSSProperties}>
      <button
        ref={trigger}
        type="button"
        aria-label="Why this failed"
        aria-describedby={tipId}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <IconInfoCircle {...glyph} aria-hidden />
      </button>
      <span
        className="fail-info-bubble"
        id={tipId}
        popover="manual"
        role="tooltip"
        ref={tip}
        onPointerEnter={show}
        onPointerLeave={hide}
      >
        {detail}
      </span>
    </span>
  );
}

/** One receipt renderer for the tape and the ask cover. */
export function ToolBodyView({
  body,
  outcome = "ok",
  onOpen,
  expanded = false,
}: {
  readonly body: ToolBody;
  readonly outcome?: ToolOutcome;
  readonly onOpen?: (file: OpenFile) => void;
  readonly expanded?: boolean;
}) {
  if (body.kind === "fail-line") return <FailLine body={body} onOpen={onOpen} />;
  if (body.kind === "empty") return <p className="tool-empty">No result yet.</p>;
  if (body.kind === "text") {
    return (
      <pre className="tool-body">
        <code>{body.text}</code>
      </pre>
    );
  }
  if (body.kind === "markdown") {
    return (
      <div className="tool-pad">
        <Markdown text={body.text} />
      </div>
    );
  }
  if (body.kind === "code") {
    return (
      <div className="tool-pad">
        <CodeView lang={body.lang} text={body.text} />
      </div>
    );
  }
  if (body.kind === "diff") {
    return (
      <div className="tool-pad">
        <DiffView lineStart={body.lineStart} newText={body.newText} oldText={body.oldText} path={body.path} />
        {outcome === "ok" ? null : <Outcome outcome={outcome} />}
      </div>
    );
  }
  if (body.kind === "shell") return <ShellTerm body={body} expanded={expanded} outcome={outcome} />;
  return (
    <div className="tool-parts">
      {body.parts.map((part, index) =>
        part.kind === "text" ? (
          <pre className="tool-body" key={index}>
            <code>{part.text}</code>
          </pre>
        ) : part.kind === "markdown" ? (
          <Markdown key={index} text={part.text} />
        ) : (
          <CodeView key={index} lang={part.lang} text={part.text} />
        ),
      )}
    </div>
  );
}

function TitleNote({ beat }: { readonly beat: TapeBeat }) {
  if (beat.mark == null) return null;
  const titled = beat.mark.title !== "";
  return (
    <aside className="progress-mark side-note">
      {titled ? (
        <h3 className="progress-title" id={`${beat.id}-title`}>
          {beat.mark.title}
        </h3>
      ) : null}
      {beat.mark.description === "" ? null : <p className="progress-description">{beat.mark.description}</p>}
      {beat.mark.items.length === 0 ? null : (
        <ul className="progress-items">
          {beat.mark.items.map((item) => (
            <li key={item.id}>
              <span className="progress-item-label">{item.label}</span>
              {item.detail === "" ? null : <span className="progress-item-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function ThoughtNotes({ beat }: { readonly beat: TapeBeat }) {
  return (
    // The fold only shows on a narrow page; beside a wide one the reasoning is always laid out.
    <details className="beat-thoughts side-note">
      <summary>Reasoning</summary>
      {beat.thoughts.map((thought) => (
        <aside className="tape-thought" key={thought.id}>
          <Markdown text={thought.text} />
        </aside>
      ))}
    </details>
  );
}

/**
 * A spawned agent, said as its status: who, on which model, doing what, how it
 * is going. The worker's transcript is behind it, not in it.
 */
function AgentNote({ cell, glance }: { readonly cell: AgentCell; readonly glance: SessionOverview | null }) {
  const face = agentFace(cell, glance);
  const [peeking, setPeeking] = useState(false);
  return (
    <>
      <button
        type="button"
        className="agent-note"
        data-state={face.state}
        aria-haspopup="dialog"
        // A call the daemon has not interned yet has no session to open.
        disabled={cell.sessionId === ""}
        onClick={() => setPeeking(true)}
      >
        <span className="agent-who">
          <span className="agent-name">{face.name}</span>
          {face.model === "" ? null : <span className="mono text-muted">{naturalName(face.model)}</span>}
        </span>
        <span className="agent-task">{face.task}</span>
        {face.status === "" ? null : (
          <span className="agent-status">
            <span>{face.status}</span>
          </span>
        )}
      </button>
      {/* Out of the lane: a note's slot is a positioned, click-through box, and its anchors are the page's. */}
      {peeking ? createPortal(<AgentPeek cell={cell} onClose={() => setPeeking(false)} />, document.body) : null}
    </>
  );
}

type Peeked = { readonly plexus: SessionPlexus } | "failed" | null;

/**
 * The note opened up: a modal that keeps the note's bar down its edge. Leaving plays the exit
 * transition before the owner lets go of whatever it held open.
 */
function PeekDialog({
  dialogRef,
  className,
  state,
  who,
  title,
  status,
  onClose,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly className?: string;
  readonly state: AgentState;
  readonly who: ReactNode;
  readonly title: string;
  readonly status: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const whoId = useId();
  const titleId = useId();
  useEffect(() => {
    dialogRef.current?.showModal();
  }, [dialogRef]);
  return (
    <dialog
      ref={dialogRef}
      className={className === undefined ? "agent-peek" : `agent-peek ${className}`}
      data-state={state}
      aria-labelledby={`${whoId} ${titleId}`}
      // React carries a nested peek's close up the component tree, through the portal.
      // The room is released once the exit transition has played, not as it starts.
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        const closing = event.currentTarget;
        const settling = closing.getAnimations().map(async (animation) => {
          try {
            await animation.finished;
          } catch {
            // A cancelled animation still lets the peek finish closing.
          }
        });
        void (async () => {
          for (const animation of settling) await animation;
          onClose();
        })();
      }}
      // Only the backdrop is the dialog itself; every visible part is a child.
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <header className="agent-peek-header">
        <div className="agent-peek-title">
          <p className="agent-peek-who" id={whoId}>
            {who}
          </p>
          <h2 id={titleId}>{title}</h2>
          {status === "" ? null : <p className="agent-peek-status">{status}</p>}
        </div>
        <form method="dialog">
          <Button variant="ghost" type="submit" className="agent-peek-close" aria-label="Close">
            <IconX {...glyph} aria-hidden />
          </Button>
        </form>
      </header>
      {children}
    </dialog>
  );
}

/** The agent's own session in a modal, read as any transcript is. The room is never seated and has no port. */
const AgentPeek = observer(function AgentPeekView({
  cell,
  onClose,
}: {
  readonly cell: AgentCell;
  readonly onClose: () => void;
}) {
  const dial = useDial();
  const preview = useFilePreview();
  const dialog = useRef<HTMLDialogElement>(null);
  const tape = useRef<HTMLDivElement>(null);
  const [peeked, setPeeked] = useState<Peeked>(null);
  useEffect(() => {
    // The transcript takes focus, not Close: arrows scroll it, Escape still closes.
    tape.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let release: (() => void) | null = null;
    void (async () => {
      try {
        const opened = await dial.peek(cell.sessionId, abort.signal);
        if (abort.signal.aborted) {
          opened.release();
          return;
        }
        release = opened.release;
        setPeeked({ plexus: opened.plexus });
      } catch {
        if (!abort.signal.aborted) setPeeked("failed");
      }
    })();
    return () => {
      abort.abort();
      release?.();
    };
  }, [dial, cell.sessionId]);
  const face = agentFace(cell, glanceOf(dial, cell.sessionId));
  const root = peeked == null || peeked === "failed" ? null : peeked.plexus.root;
  const beats = root == null ? [] : sessionBeats(root);
  return (
    <PeekDialog
      dialogRef={dialog}
      state={face.state}
      who={
        <>
          <span className="label">{face.name}</span>
          {face.model === "" ? null : <span className="mono">{naturalName(face.model)}</span>}
        </>
      }
      title={face.task}
      status={face.status}
      onClose={onClose}
    >
      <div ref={tape} className="tape agent-peek-tape" tabIndex={-1}>
        <div className="transcript">
          {peeked === "failed" ? (
            <p className="transcript-empty transcript-column">This agent's session could not be opened.</p>
          ) : root == null ? (
            <p className="transcript-empty transcript-column" role="status">
              Opening the agent's session…
            </p>
          ) : beats.length === 0 ? (
            <p className="transcript-empty transcript-column">Nothing yet.</p>
          ) : (
            <SessionTimeline
              beats={beats}
              root={root}
              // The file pane sits behind the modal; open the file there.
              onOpen={(file) => {
                dialog.current?.close();
                preview.open(file);
              }}
            />
          )}
        </div>
        <div className="anchor" />
      </div>
    </PeekDialog>
  );
});

/** A program's graph is one click inside its disclosure. Not in the summary: that is already a button. */
function GraphButton({ program }: { readonly program: ProgrammaticJob }) {
  const sessionId = useContext(SessionIdContext);
  const [open, setOpen] = useState(false);
  if (sessionId === "") return null;
  return (
    <>
      <Button variant="ghost" className="tool-graph" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <IconBinaryTree2 {...glyph} aria-hidden />
        Graph
      </Button>
      {open
        ? createPortal(
            <WorkflowPeek program={program} sessionId={sessionId} onClose={() => setOpen(false)} />,
            document.body,
          )
        : null}
    </>
  );
}

const PROGRAM_STATUS: Readonly<Record<ToolOutcome, string>> = { live: "running", ok: "done", failed: "failed" };

/** A program's dataflow in a modal: the daemon's graph, each card as the session's own job says it is. An agent card opens that agent. */
const WorkflowPeek = observer(function WorkflowPeekView({
  program,
  sessionId,
  onClose,
}: {
  readonly program: ProgrammaticJob;
  readonly sessionId: string;
  readonly onClose: () => void;
}) {
  const dial = useDial();
  const dialog = useRef<HTMLDialogElement>(null);
  const { graph, done } = useWorkflowGraph(sessionId, program);
  const [picked, setPicked] = useState<AgentCell | null>(null);
  const cells = useMemo(
    () =>
      graph === null
        ? undefined
        : jobCells(
            graph,
            () => program.toolCalls,
            (id) => glanceOf(dial, id),
          ),
    [graph, program, dial],
  );
  const outcome = outcomeOf(program.completed, program.outcomeSnap);
  return (
    <PeekDialog
      dialogRef={dialog}
      className="workflow-peek"
      state={outcome}
      who={<span className="label">workflow</span>}
      title={schemeHead(program) || schemeSummary(program)}
      status={PROGRAM_STATUS[outcome]}
      onClose={onClose}
    >
      {graph === null ? (
        <p className="transcript-empty transcript-column" role="status">
          {done ? "No graph was kept for this run." : "Opening the graph…"}
        </p>
      ) : (
        <WorkflowGraph
          graph={graph}
          {...(cells === undefined ? {} : { cells })}
          onPick={(leaf) => {
            const jobId = isWorkflowLeafMeta(leaf.meta) ? leaf.meta.jobId : undefined;
            const job = program.toolCalls.find((inner) => inner.uuid === jobId);
            if (job instanceof CallJob && job.workerSessionId.trim() !== "") setPicked(agentCell(job));
          }}
        />
      )}
      {picked === null
        ? null
        : createPortal(<AgentPeek cell={picked} onClose={() => setPicked(null)} />, document.body)}
    </PeekDialog>
  );
});

type BeatPart = "body" | "title" | "thoughts" | "agent";

type TimelineItem = {
  readonly id: string;
  readonly row: number;
  readonly titleEnd: number;
  readonly thoughtsEnd: number;
  readonly mark: TapeBeat["mark"];
  readonly modelSpan: ModelSpan | null;
  readonly thoughts: readonly unknown[];
  readonly agentSpans: readonly AgentSpan[];
};

/** Which model and connection ran a span of rounds. It rests at the span's end and holds to the bottom. */
function ModelNote({ span, wire }: { readonly span: ModelSpan; readonly wire: string }) {
  return (
    <aside className="model-note side-note">
      <span className="mono">{naturalName(span.model)}</span>
      <span className="text-muted">{wire}</span>
    </aside>
  );
}

/**
 * The panes own annotation order; only the center column sizes the timeline.
 * The left lane holds two kinds at once: progress holds to the top of its
 * span, the model to the bottom of its own.
 */
function TimelineLayout<T extends TimelineItem>({
  beats,
  renderBeat,
  nameWire,
  live,
}: {
  readonly beats: readonly T[];
  /** `agent` names the call; the other parts are the beat's own. */
  readonly renderBeat: (beat: T, part: BeatPart, agent?: string) => ReactNode;
  readonly nameWire: (connection: string) => string;
  /** The composer's selector stands for this span; its note shows only once the choice moves on. */
  readonly live?: { readonly model: string; readonly connection: string };
}) {
  const spans = beats.filter((beat) => beat.modelSpan != null);
  const last = spans.at(-1)?.modelSpan;
  const shown =
    live != null && last?.model === live.model && last.connection === live.connection ? spans.slice(0, -1) : spans;
  const models = shown.map((beat) => {
    const span = beat.modelSpan;
    if (span == null) return null;
    return (
      <li
        className="annotation-slot side-left model-slot"
        key={`${beat.id}:model`}
        style={
          {
            "--beat-row": beat.row,
            "--model-last-row": span.lastRow,
            "--beat-anchor": `--beat-${beat.row}`,
            "--note-anchor": `--model-note-${beat.row}`,
            "--previous-note": "0px",
            "--annotation-end": `anchor(--beat-${span.lastRow} bottom)`,
          } as CSSProperties
        }
      >
        <ModelNote span={span} wire={nameWire(span.connection)} />
      </li>
    );
  });
  // Agents rest at the end of their span and hold to the bottom, stacked by level.
  // The group is only a box on a narrow page, where a round's agents follow it.
  // Agents that ended in one round rest together at its end; every agent still out
  // shares the tape's end, so they are one stack held to the bottom.
  const rests = new Map<string, { key: string; from: number; end: number | null; members: [T, string][] }>();
  for (const beat of beats) {
    for (const span of beat.agentSpans) {
      const key = span.lastRow == null ? "out" : String(span.lastRow);
      const rest = rests.get(key) ?? { key, from: beat.row, end: span.lastRow, members: [] };
      rest.members.push([beat, span.id]);
      rests.set(key, rest);
    }
  }
  const stacks = [...rests.values()].sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity));
  const thoughtRows = beats.filter((beat) => beat.thoughts.length > 0).map((beat) => beat.row);
  const after = (anchor: string): string => `calc(anchor(${anchor} bottom) + var(--note-gap))`;
  const floorOf = (floors: readonly string[]): string =>
    floors.length === 0 ? "0px" : floors.length === 1 ? floors[0] : `max(${floors.join(", ")})`;
  // A rest clears the reasoning and the stack above it, so no two notes share one.
  const stackFloor = (index: number): string => {
    const stack = stacks[index];
    const row = thoughtRows.findLast((at) => at >= stack.from && at <= (stack.end ?? beats.length));
    const floors = [
      ...(row === undefined ? [] : [after(`--right-note-${row}`)]),
      ...(index === 0 ? [] : [after(`--agents-${stacks[index - 1].key}`)]),
    ];
    return floorOf(floors);
  };
  const thoughtFloor = (row: number, previous: number | null): string => {
    const stack = stacks.findLast((item) => item.end != null && item.end < row);
    const floors = [
      ...(previous == null ? [] : [after(`--right-note-${previous}`)]),
      ...(stack == null || (previous != null && stack.end! < previous) ? [] : [after(`--agents-${stack.key}`)]),
    ];
    return floorOf(floors);
  };
  const agents = stacks.map(
    (stack, index) =>
      [
        // Rest order: a stack rests at its round's bottom, after the reasoning that opens that round.
        (stack.end ?? Infinity) * 2 + 1,
        <li
          className="annotation-slot side-right agent-slot"
          data-out={stack.end == null ? "" : undefined}
          key={`agents:${stack.key}`}
          style={
            {
              "--beat-row": stack.end ?? beats.length,
              "--beat-anchor": `--beat-${stack.from}`,
              "--note-anchor": `--agents-${stack.key}`,
              "--previous-note": stackFloor(index),
              "--annotation-end": stack.end == null ? "0px" : `anchor(--beat-${stack.end} bottom)`,
            } as CSSProperties
          }
        >
          <div className="agent-stack side-note">
            {stack.members.map(([beat, id]) => (
              <Fragment key={id}>{renderBeat(beat, "agent", id)}</Fragment>
            ))}
          </div>
        </li>,
      ] as const,
  );
  const pane = (side: "left" | "right") => {
    const notes = beats.filter((beat) => (side === "left" ? beat.mark != null : beat.thoughts.length > 0));
    return (
      <aside
        className={`side-pane side-${side}`}
        aria-label={side === "left" ? "Progress annotations" : "Reasoning annotations"}
      >
        <ol className="side-notes" role="list">
          {/* An anchor resolves only for notes after it, so the right lane lists in rest order. */}
          {[
            ...notes.map((beat, index) => {
              const previous = index === 0 ? null : notes[index - 1];
              const end = side === "left" ? beat.titleEnd : beat.thoughtsEnd;
              return [
                beat.row * 2,
                <li
                  className={`annotation-slot side-${side}`}
                  key={beat.id}
                  style={
                    {
                      "--beat-row": beat.row,
                      "--beat-anchor": `--beat-${beat.row}`,
                      "--note-anchor": `--${side}-note-${beat.row}`,
                      "--previous-note":
                        side === "right"
                          ? thoughtFloor(beat.row, previous?.row ?? null)
                          : previous == null
                            ? "0px"
                            : `calc(anchor(--${side}-note-${previous.row} bottom) + var(--note-gap))`,
                      "--annotation-end": end > beats.length ? "0px" : `anchor(--beat-${end} top)`,
                    } as CSSProperties
                  }
                >
                  {renderBeat(beat, side === "left" ? "title" : "thoughts")}
                </li>,
              ] as const;
            }),
            ...(side === "left" ? [] : agents),
          ]
            .sort((a, b) => a[0] - b[0])
            .map(([, node]) => node)}
          {side === "left" ? models : null}
        </ol>
      </aside>
    );
  };
  return (
    <div className="timeline">
      <div className="timeline-main">
        {beats.map((beat) => (
          <Fragment key={beat.id}>{renderBeat(beat, "body")}</Fragment>
        ))}
      </div>
      {pane("left")}
      {pane("right")}
    </div>
  );
}

function BeatSection({
  beat,
  row,
  onOpen,
  onEdit,
}: {
  readonly beat: TapeBeat;
  readonly row: number;
  readonly onOpen: (file: OpenFile) => void;
  readonly onEdit?: (cellId: string) => void;
}) {
  return (
    <section
      aria-labelledby={beat.mark == null || beat.mark.title === "" ? undefined : `${beat.id}-title`}
      className="beat"
      style={{ "--beat-row": row, "--beat-anchor": `--beat-${row}` } as CSSProperties}
    >
      <div className="beat-body">
        {beat.cells.map((cell) => (
          <CellFence key={cell.id}>
            <CellView
              cell={cell}
              onOpen={onOpen}
              {...(onEdit == null || cell.kind !== "user" ? {} : { onEdit: () => onEdit(cell.id) })}
            />
          </CellFence>
        ))}
      </div>
    </section>
  );
}

export function BeatTimeline({
  beats,
  onOpen,
}: {
  readonly beats: readonly TapeBeat[];
  readonly onOpen: (file: OpenFile) => void;
}) {
  return (
    <TimelineLayout
      beats={stickyBeats(
        agentSpans(
          modelSpans(beats).map((beat) => ({
            ...beat,
            agents: beat.agents.map((agent) => ({ ...agent, live: agent.outcome === "live" })),
          })),
        ),
      )}
      nameWire={(connection) => connection}
      renderBeat={(beat, part, agent) =>
        part === "agent" ? (
          <AgentNote cell={beat.agents.find((item) => item.id === agent)!} glance={null} />
        ) : part === "title" ? (
          <TitleNote beat={beat} />
        ) : part === "thoughts" ? (
          <ThoughtNotes beat={beat} />
        ) : (
          <BeatSection beat={beat} row={beat.row} onOpen={onOpen} />
        )
      }
    />
  );
}

const LiveBeat = observer(function LiveBeatView({
  turn,
  projectPath,
  beatId,
  row,
  part,
  agent,
  onOpen,
}: {
  readonly turn: SessionTurn;
  readonly projectPath: string;
  readonly beatId: string;
  readonly row: number;
  readonly part: BeatPart;
  readonly agent?: string;
  readonly onOpen: (file: OpenFile) => void;
}) {
  const dial = useDial();
  const beat = turnBeats(turn, projectPath).find((item) => item.id === beatId);
  const editable = canEditMessages(dial);
  if (beat == null) return null;
  if (part === "agent") {
    const cell = beat.agents.find((item) => item.id === agent);
    if (cell == null) return null;
    return <AgentNote cell={cell} glance={glanceOf(dial, cell.sessionId)} />;
  }
  if (part === "title") return <TitleNote beat={beat} />;
  if (part === "thoughts") return <ThoughtNotes beat={beat} />;
  return (
    <BeatSection
      beat={beat}
      onOpen={onOpen}
      row={row}
      {...(editable
        ? {
            onEdit: (cellId: string) => {
              if (cellId === `${turn.uuid}:user`) void editMessage(dial, turn);
            },
          }
        : {})}
    />
  );
});

/**
 * The daemon is not up yet. Most connects land before anything shows; past a
 * beat the column draws its first lines where the greeting will sit, and only
 * a long wait says why. CSS alone: no timer outlives the mount.
 */
function Connecting() {
  return (
    <section className="transcript-empty transcript-column connecting" role="status">
      <span className="visually-hidden">Connecting to the harness daemon</span>
      <span className="connecting-lines" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <p className="connecting-hint">Waiting for the local daemon.</p>
    </section>
  );
}

/** One session's timeline, live. The open session and a peeked agent read the same way. */
function SessionTimeline({
  beats,
  root,
  live,
  onOpen,
}: {
  readonly beats: ReturnType<typeof sessionBeats>;
  readonly root: SessionRoot;
  readonly live?: { readonly model: string; readonly connection: string };
  readonly onOpen: (file: OpenFile) => void;
}) {
  const dial = useDial();
  return (
    <SessionIdContext.Provider value={root.sessionId}>
      <TimelineLayout
        beats={beats}
        nameWire={(connection) => wireName(dial.kernel?.root.connections[connection], connection)}
        {...(live == null ? {} : { live })}
        renderBeat={(beat, part, agent) => (
          // A beat that cannot render costs that beat, not the session.
          <CellFence>
            <LiveBeat
              agent={agent}
              beatId={beat.id}
              onOpen={onOpen}
              projectPath={root.path}
              row={beat.row}
              part={part}
              turn={beat.turn}
            />
          </CellFence>
        )}
      />
    </SessionIdContext.Provider>
  );
}

export const Tape = observer(function TapeView() {
  const dial = useDial();
  const preview = useFilePreview();
  const root = dial.session?.root ?? null;
  const project = dial.project?.root ?? null;
  const kvs: Readonly<Record<string, string | undefined>> = root?.kvs ?? {};
  const laid = root == null ? [] : sessionBeats(root);
  return (
    <div className="transcript">
      {root == null && dial.kernel == null ? (
        // Before the first kernel the notice is the page; after it, it sits by the composer.
        dial.link == null ? (
          <Connecting />
        ) : (
          <section className="transcript-empty transcript-column">
            <LinkNotice />
          </section>
        )
      ) : root == null ? (
        <WorkspaceHome dial={dial} project={project} />
      ) : laid.length === 0 ? (
        // Nothing to title yet. The page names where the work happens; the composer is the rest.
        <section className="transcript-fresh transcript-column" aria-label="New conversation">
          <h2>
            {root.title.trim() === ""
              ? (projectNames(Object.keys(dial.kernel?.root.projects ?? {})).get(root.path) ?? root.path)
              : root.title}
          </h2>
          {/* Break only between segments. `<wbr>` adds no character, so a copied path stays exact. */}
          <p className="mono">
            {root.path.split("/").map((segment, index) => (
              <Fragment key={index}>
                {index === 0 ? null : (
                  <>
                    /<wbr />
                  </>
                )}
                {segment}
              </Fragment>
            ))}
          </p>
        </section>
      ) : (
        <SessionTimeline
          beats={laid}
          live={{ model: kvs.model ?? "", connection: kvs.connection ?? "" }}
          onOpen={preview.open}
          root={root}
        />
      )}
    </div>
  );
});

/** Overview, or the selected project when no session is open. The route wins over a room that has not committed. */
const WorkspaceHome = observer(function WorkspaceHomeView({
  dial,
  project,
}: {
  readonly dial: ReturnType<typeof useDial>;
  readonly project: { readonly path: string; readonly sessions: Readonly<Record<string, string>> } | null;
}) {
  const routed = dial.requestedTarget;
  const routedPath = routed.kind === "project" || routed.kind === "project-session" ? routed.path : null;
  const path = routedPath ?? project?.path ?? null;
  if (path == null) {
    return (
      <section className="transcript-empty transcript-column">
        <h2>Your workspace</h2>
        <p>Pick a project from the tabs below. + Add is for adding a project.</p>
      </section>
    );
  }
  const known = Object.keys(dial.kernel?.root.projects ?? {});
  const name = projectNames(known.includes(path) ? known : [...known, path]).get(path) ?? path;
  const sessions = project?.path === path ? project.sessions : (dial.projects.get(path)?.root.sessions ?? {});
  return (
    <section className="transcript-empty transcript-column">
      <h2>{name}</h2>
      <p className="mono empty-project-path">{path}</p>
      <p>
        {Object.keys(sessions).length === 0
          ? "Write the first message below. The session starts when you send it."
          : "Open a session, or write a first message below to start another."}
      </p>
    </section>
  );
});
