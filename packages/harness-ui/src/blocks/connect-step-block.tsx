import { useEffect, useId, useRef, useState } from "react";

import { Button, buttonVariants } from "../primitives/button.js";
import { Disclosure, DisclosurePanel, FieldButton, Link, TextField, type TextFieldProps } from "../primitives/index.js";

/** Transport or credential classification of a provider connection failure. */
export type FailureKind = "auth" | "connection";

/** Normalized operator-facing summary for a connect or auth error. */
export interface ConnectFailure {
  readonly kind: FailureKind;
  readonly summary: string;
  /** The daemon's own line when the summary replaces it. */
  readonly detail: string | null;
}

/** Parsed interactive step form yielded by a parked `connect/adopt` or `connect/login` RPC. */
export type ConnectParkForm =
  | {
      readonly kind: "open-url";
      readonly url: string;
      readonly description: string;
      readonly paste: string;
      readonly input: "password" | "text" | null;
    }
  | { readonly kind: "input"; readonly name: string; readonly description: string; readonly secret: boolean }
  | { readonly kind: "confirm"; readonly name: string; readonly description: string }
  | { readonly kind: "unknown" };

/** Parameters required to initiate or reauthorize a completion connection. */
export interface ConnectStepStart {
  /** Existing connection id to reauthorize instead of adopting a new connection. */
  readonly reconnect?: string;
  readonly driver: string;
  readonly name: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** Generic JSON-RPC transport function used by connect steps. */
export type ConnectRpcRequest = (method: string, params: unknown) => Promise<unknown>;

const AUTH_STATUS = /(?:^|\D)40[13](?:\D|$)/;
const TIMEOUT = /\b(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b|\btimed?\s*out\b/i;
const REFUSED = /\bECONNREFUSED\b|connection refused/i;

/** Formats a daemon connection/auth failure into an actionable operator message. */
export function connectError(provider: string, message: string): ConnectFailure {
  const name = provider.trim() === "" ? "The provider" : provider.trim();
  const line = message.trim();
  if (line === "") return { kind: "connection", summary: `Couldn’t connect to ${name}.`, detail: null };
  const { kind, summary } = summaryFor(name, line);
  return { kind, summary, detail: summary === line ? null : line };
}

function summaryFor(name: string, line: string): { readonly kind: FailureKind; readonly summary: string } {
  if (AUTH_STATUS.test(line)) return { kind: "auth", summary: "The key was refused. Reconnect." };
  if (TIMEOUT.test(line)) return { kind: "connection", summary: `No answer from ${name}.` };
  if (REFUSED.test(line)) {
    return { kind: "connection", summary: `${name} didn’t answer on this machine. Check it’s running, then retry.` };
  }
  return { kind: "connection", summary: line };
}

/** Chooses HTML input type for redirect URLs vs pasted tokens/passwords in OAuth browser steps. */
export function openUrlFieldType(paste: string, input: "password" | "text" | null): "url" | "password" | "text" {
  if (paste !== "" && isRedirectAddress(paste)) return "url";
  if (input === "password") return "password";
  return "text";
}

function isRedirectAddress(paste: string): boolean {
  return /\b(?:address|url)\b/i.test(paste) && !/\b(?:key|token|secret|password)\b/i.test(paste);
}

type StepState =
  | { readonly phase: "starting" }
  | { readonly phase: "form"; readonly pending: string; readonly form: ConnectParkForm }
  | { readonly phase: "waiting"; readonly form: ConnectParkForm }
  | { readonly phase: "sending"; readonly form: ConnectParkForm }
  | { readonly phase: "error"; readonly summary: string; readonly detail: string | null };

type ParkAnswer =
  | { readonly kind: "accept" }
  | { readonly kind: "cancel" }
  | { readonly kind: "text"; readonly input: string }
  | { readonly kind: "opened"; readonly url: string };

export interface ConnectStepBlockProps {
  readonly start: ConnectStepStart;
  readonly request: ConnectRpcRequest;
  readonly parsePark?: (body: string) => Promise<ConnectParkForm>;
  readonly onDone: (id: string) => void;
  readonly onCancel: () => void;
}

async function fallbackParsePark(): Promise<ConnectParkForm> {
  return { kind: "unknown" };
}

/**
 * Pure multi-step provider connection / reauthorization wizard powered by injected RPC & park parser callbacks.
 */
export function ConnectStepBlock({
  start,
  request,
  parsePark = fallbackParsePark,
  onDone,
  onCancel,
}: ConnectStepBlockProps) {
  const [step, setStep] = useState<StepState>({ phase: "starting" });
  const root = useRef<HTMLDivElement>(null);
  const call = useRef(0);
  const held = useRef<string | null>(null);
  const mounted = useRef(false);
  const started = useRef(false);
  const latest = useRef({ request, parsePark, onDone, onCancel, start });
  latest.current = { request, parsePark, onDone, onCancel, start };

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
      const form = await latest.current.parsePark(park.body);
      if (stale()) return drop(park.pending);
      held.current = park.pending;
      setStep({ phase: "form", pending: park.pending, form });
      return;
    }
    held.current = null;
    const currentStart = latest.current.start;
    const id = idOf(result) ?? (currentStart.reconnect != null && isSuccess(result) ? currentStart.reconnect : null);
    if (id != null) latest.current.onDone(id);
    else if (isRefusal(result)) latest.current.onCancel();
    else {
      setStep({
        phase: "error",
        ...connectError(currentStart.name, "The daemon gave an answer this page does not know."),
      });
    }
  }

  function run(send: () => Promise<unknown>): void {
    const mine = (call.current += 1);
    void (async () => {
      try {
        const result = await send();
        if (mine !== call.current || !mounted.current) {
          const late = parkOf(result);
          if (late != null) drop(late.pending);
          return;
        }
        await advance(result, mine);
      } catch (error) {
        if (mine !== call.current || !mounted.current) return;
        release();
        setStep({
          phase: "error",
          ...connectError(latest.current.start.name, error instanceof Error ? error.message : "Could not connect."),
        });
      }
    })();
  }

  const begin = (): void => {
    setStep({ phase: "starting" });
    const currentStart = latest.current.start;
    const req = latest.current.request;
    run(() =>
      currentStart.reconnect == null
        ? req("connect/adopt", currentStart)
        : req("connect/login", { id: currentStart.reconnect }),
    );
  };

  function answer(pending: string, form: ConnectParkForm, reply: ParkAnswer): void {
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
    if (!started.current) {
      started.current = true;
      begin();
    }
    return () => {
      mounted.current = false;
      release();
    };
  }, []);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("[data-first]")?.focus();
  }, [step.phase]);

  const cancelFirst = step.phase === "form" ? step.form.kind === "unknown" : step.phase !== "error";
  return (
    <div
      ref={root}
      className="connect-step"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
    >
      <h2 className="text-xl leading-[26px]">{start.name}</h2>
      {step.phase === "starting" ? <Pending>Connecting…</Pending> : null}
      {step.phase === "form" ? (
        <ParkStepForm form={step.form} onAnswer={(reply) => answer(step.pending, step.form, reply)} />
      ) : null}
      {step.phase === "waiting" ? <Pending>Waiting for the browser…</Pending> : null}
      {step.phase === "sending" ? <Pending>Connecting…</Pending> : null}
      {step.phase === "error" ? (
        <div className="link-notice" role="status">
          <span className="link-glyph" data-needs aria-hidden />
          <div className="link-text">
            <span>{step.summary}</span>
            {step.detail == null ? null : (
              <Disclosure className="connect-detail border-0 p-0">
                <FieldButton slot="trigger" className="min-h-0 justify-start border-0 p-0 text-sm">
                  Details
                </FieldButton>
                <DisclosurePanel className="connect-detail-panel px-0 py-1 mono text-sm">{step.detail}</DisclosurePanel>
              </Disclosure>
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

function ParkStepForm({
  form,
  onAnswer,
}: {
  readonly form: ConnectParkForm;
  readonly onAnswer: (reply: ParkAnswer) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const submit = (): void => {
    if (text !== "" || form.kind === "input") onAnswer({ kind: "text", input: text });
  };
  const enter: NonNullable<TextFieldProps["onKeyDown"]> = (event) => {
    event.continuePropagation();
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  switch (form.kind) {
    case "open-url":
      return (
        <>
          {form.description === "" ? null : <p className="connect-note">{form.description}</p>}
          <Link
            isCommand
            className={`${buttonVariants()} no-underline`}
            data-first
            href={form.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onAnswer({ kind: "opened", url: form.url })}
          >
            Open
          </Link>
          {form.paste ? (
            <div className="connect-field">
              <div className="connect-row items-end">
                <TextField
                  id={`${id}-paste`}
                  label={form.paste}
                  className="min-w-0 flex-1"
                  type={openUrlFieldType(form.paste, form.input)}
                  autoComplete="off"
                  spellCheck={false}
                  value={text}
                  onChange={setText}
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
          {form.description === "" ? null : (
            <p className="connect-note" id={`${id}-note`}>
              {form.description}
            </p>
          )}
          <div className="connect-row items-end">
            <TextField
              id={`${id}-input`}
              label={form.name}
              className="min-w-0 flex-1"
              ref={(node) => {
                node?.setAttribute("data-first", "");
              }}
              type={form.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={form.description === "" ? undefined : `${id}-note`}
              value={text}
              onChange={setText}
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

function isSuccess(result: unknown): boolean {
  return typeof result === "object" && result != null && (result as Record<string, unknown>).ok === true;
}
