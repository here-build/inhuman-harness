import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { connectError } from "./connect-error.js";
import { openUrlFieldType, parsePark, type ParkForm } from "./connect-park.js";
import type { ConnectStart } from "./provider-list.js";
import { Button, buttonVariants } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

export type Request = (method: string, params: unknown) => Promise<unknown>;

/**
 * Where a connect flow talks to the daemon: an open session's port, which also
 * points the session at what it connected, else the kernel's.
 */
export function connectPort(dial: {
  readonly sessionRpc: { request: Request } | null;
  readonly kernelRpc: { request: Request } | null;
}): Request | null {
  const port = dial.sessionRpc ?? dial.kernelRpc;
  return port == null ? null : (method, params) => port.request(method, params);
}

type Step =
  | { readonly phase: "starting" }
  | { readonly phase: "form"; readonly pending: string; readonly form: ParkForm }
  /** An answer is in flight: the browser leg (`opened`) waits on the person, the rest on the daemon. */
  | { readonly phase: "waiting"; readonly form: ParkForm }
  | { readonly phase: "sending"; readonly form: ParkForm }
  | { readonly phase: "error"; readonly summary: string; readonly detail: string | null };

type Answer =
  | { readonly kind: "accept" }
  | { readonly kind: "cancel" }
  | { readonly kind: "text"; readonly input: string }
  | { readonly kind: "opened"; readonly url: string };

/**
 * One `connect/adopt` flow, in the space the provider list had. The daemon
 * parks at each thing it needs from a person and the step paints that one
 * thing: a link, a field, a confirmation. An answer goes back as `ui/resolve`
 * and returns the next park or the end: `{ id }` connected, `{ ok: false }`
 * cancelled. A park the page cannot paint is finished in the terminal.
 */
export function ConnectStep({
  start,
  request,
  onDone,
  onCancel,
}: {
  readonly start: ConnectStart;
  readonly request: Request;
  readonly onDone: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>({ phase: "starting" });
  const root = useRef<HTMLDivElement>(null);
  /** The latest call; an older one that lands late is ignored. */
  const call = useRef(0);
  /** The park the daemon is holding for us, if any. */
  const held = useRef<string | null>(null);
  const mounted = useRef(false);
  const started = useRef(false);
  const latest = useRef({ request, onDone, onCancel });
  latest.current = { request, onDone, onCancel };

  /** Tell the daemon to drop a park (aborting a sign-in in flight). Its reply no longer matters. */
  const drop = (pending: string): void => {
    latest.current.request("ui/resolve", { pending, kind: "cancel" }).catch(() => undefined);
  };
  const release = (): void => {
    const pending = held.current;
    held.current = null;
    if (pending != null) drop(pending);
  };

  async function advance(result: unknown, mine: number): Promise<void> {
    const park = parkOf(result);
    if (park != null) {
      const stale = (): boolean => mine !== call.current || !mounted.current;
      if (stale()) return drop(park.pending);
      const form = await parsePark(park.body);
      if (stale()) return drop(park.pending);
      held.current = park.pending;
      setStep({ phase: "form", pending: park.pending, form });
      return;
    }
    held.current = null;
    const id = idOf(result);
    if (id != null) latest.current.onDone(id);
    else if (isRefusal(result)) latest.current.onCancel();
    else setStep({ phase: "error", ...connectError(start.name, "The daemon gave an answer this page does not know.") });
  }

  function run(send: () => Promise<unknown>): void {
    const mine = (call.current += 1);
    void (async () => {
      try {
        const result = await send();
        if (mine !== call.current) {
          const late = parkOf(result);
          if (late != null) drop(late.pending);
          return;
        }
        await advance(result, mine);
      } catch (error) {
        if (mine !== call.current) return;
        release();
        setStep({
          phase: "error",
          ...connectError(start.name, error instanceof Error ? error.message : "Could not connect."),
        });
      }
    })();
  }

  const begin = (): void => {
    setStep({ phase: "starting" });
    run(() => request("connect/adopt", start));
  };

  function answer(pending: string, form: ParkForm, reply: Answer): void {
    setStep({ phase: reply.kind === "opened" ? "waiting" : "sending", form });
    run(() => request("ui/resolve", { pending, ...reply }));
  }

  function cancel(): void {
    call.current += 1;
    release();
    onCancel();
  }

  useEffect(() => {
    mounted.current = true;
    // Strict mode replays effects on one instance: the flow starts once.
    if (!started.current) {
      started.current = true;
      begin();
    }
    return () => {
      mounted.current = false;
      release();
    };
  }, []);

  // Focus follows the step: its first control, or Cancel while the daemon waits.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("[data-first]")?.focus();
  }, [step.phase]);

  // Cancel takes focus when it is the only thing to do: nothing to fill, only waiting or the terminal.
  const cancelFirst = step.phase === "form" ? step.form.kind === "unknown" : step.phase !== "error";
  return (
    <div
      ref={root}
      className="connect-step"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Esc leaves the flow, not the picker; the next Esc closes that.
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
    >
      <h2 className="connect-title">{start.name}</h2>
      {step.phase === "starting" ? <Pending>Connecting…</Pending> : null}
      {step.phase === "form" ? (
        <Form form={step.form} onAnswer={(reply) => answer(step.pending, step.form, reply)} />
      ) : null}
      {step.phase === "waiting" ? <Pending>Waiting for the browser…</Pending> : null}
      {step.phase === "sending" ? <Pending>Connecting…</Pending> : null}
      {step.phase === "error" ? (
        <div className="link-notice" role="status">
          <span className="link-glyph" data-needs aria-hidden />
          <div className="link-text">
            <span>{step.summary}</span>
            {step.detail == null ? null : (
              <details className="connect-detail">
                <summary>Details</summary>
                <p className="mono text-sm">{step.detail}</p>
              </details>
            )}
          </div>
          <Button variant="secondary" data-first onClick={begin}>
            Retry
          </Button>
        </div>
      ) : null}
      <div className="connect-actions">
        <Button variant="secondary" data-first={cancelFirst ? "" : undefined} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Pending({ children }: { readonly children: string }) {
  return (
    <p className="link-notice" data-waiting="" role="status">
      <span className="link-glyph" data-waiting="" aria-hidden />
      <span className="link-text">{children}</span>
    </p>
  );
}

function Form({ form, onAnswer }: { readonly form: ParkForm; readonly onAnswer: (reply: Answer) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  /** A pasted key is never empty; a prompted field may be (an optional key, a code the browser already carried). */
  const submit = (): void => {
    if (text !== "" || form.kind === "input") onAnswer({ kind: "text", input: text });
  };
  const enter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  switch (form.kind) {
    case "open-url":
      return (
        <>
          {form.description === "" ? null : <p className="connect-note">{form.description}</p>}
          <a
            className={buttonVariants()}
            data-first
            href={form.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onAnswer({ kind: "opened", url: form.url })}
          >
            Open
          </a>
          {form.paste ? (
            <div className="connect-field">
              <label htmlFor={`${id}-paste`}>{form.paste}</label>
              <div className="connect-row">
                <Input
                  id={`${id}-paste`}
                  type={openUrlFieldType(form.paste, form.input)}
                  autoComplete="off"
                  spellCheck={false}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={enter}
                />
                <Button disabled={text === ""} onClick={submit}>
                  Connect
                </Button>
              </div>
            </div>
          ) : null}
        </>
      );
    case "input":
      return (
        <div className="connect-field">
          <label htmlFor={`${id}-input`}>{form.name}</label>
          {form.description === "" ? null : (
            <p className="connect-note" id={`${id}-note`}>
              {form.description}
            </p>
          )}
          <div className="connect-row">
            <Input
              id={`${id}-input`}
              data-first
              type={form.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={form.description === "" ? undefined : `${id}-note`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={enter}
            />
            <Button onClick={submit}>Connect</Button>
          </div>
        </div>
      );
    case "confirm":
      return (
        <>
          <p className="connect-note">{form.description === "" ? form.name : form.description}</p>
          <Button data-first onClick={() => onAnswer({ kind: "accept" })}>
            Accept
          </Button>
        </>
      );
    case "unknown":
      return (
        <p className="connect-note">
          Finish this in the terminal: <code>/connect</code>
        </p>
      );
  }
}

function parkOf(result: unknown): { readonly pending: string; readonly body: string } | null {
  if (typeof result !== "object" || result == null) return null;
  const { form, pending, body } = result as Record<string, unknown>;
  return form === "ui" && typeof pending === "string" && typeof body === "string" ? { pending, body } : null;
}

function idOf(result: unknown): string | null {
  const id = typeof result === "object" && result != null ? (result as Record<string, unknown>).id : undefined;
  return typeof id === "string" && id !== "" ? id : null;
}

function isRefusal(result: unknown): boolean {
  return typeof result === "object" && result != null && (result as Record<string, unknown>).ok === false;
}
