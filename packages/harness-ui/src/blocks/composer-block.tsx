import {
  useId,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { IconCornerDownLeft, IconPlayerPlayFilled, IconPlayerStopFilled } from "@tabler/icons-react";

import { PictureChipsBlock, PictureDropSurface, type DraftPicture } from "./attachments.js";
import { SkillSlashMenuBlock, type SkillSlashMenuModel } from "./skill-slash-menu.js";
import { Button } from "../primitives/button.js";
import { fieldGlyph, glyph } from "../primitives/glyph.js";
import { Textarea } from "../primitives/input.js";
import { useVoice } from "../voice/index.js";

const fieldActionClass =
  "absolute right-2 bottom-2 inline-flex size-8 min-h-0 p-0 items-center justify-center rounded-sm text-ink hover:bg-hover disabled:opacity-40 pointer-coarse:right-1 pointer-coarse:bottom-1 pointer-coarse:size-12";

/** Approval cover card presentation model rendered over the inactive draft field. */
export interface ApprovalCoverView {
  readonly leafId: string;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly heading: string;
  readonly isAck: boolean;
  readonly kicker?: string;
  readonly summary?: string | null;
  readonly lede?: string;
  readonly proposedOperation?: ReactNode;
  readonly ackBlock?: ReactNode;
  readonly comment: string;
  readonly disabled: boolean;
  readonly armed: boolean;
  readonly submitting?: boolean;
  readonly copyYes: string;
  readonly copyNo: string;
  readonly destructive?: boolean;
  readonly riskPhrase?: string;
  readonly alwaysAutoLabels?: readonly string[];
  readonly onCommentChange: (value: string) => void;
  readonly onDeny: () => void;
  readonly onAllow: () => void;
  readonly onAlwaysAuto?: (scope: "session" | "project") => void;
}

export interface ComposerBlockProps {
  readonly hidden?: boolean;
  readonly topNotices?: ReactNode;
  readonly notice: string;
  readonly canRestore?: boolean;
  readonly onRestore?: () => void;
  readonly cover?: ApprovalCoverView | null;
  readonly wrapDraftInert?: boolean;
  readonly fieldRef: RefObject<HTMLTextAreaElement | null>;
  readonly pillRef: RefObject<HTMLDivElement | null>;
  readonly dropEnabled: boolean;
  readonly onDropFiles: (files: readonly File[]) => void;
  readonly pictures: readonly DraftPicture[];
  readonly picturesDisabled: boolean;
  readonly onRemovePicture: (key: string) => void;
  readonly onPickPictures: (files: readonly File[]) => void;
  readonly slashMenu: SkillSlashMenuModel | null;
  readonly slashFieldProps?: Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange" | "onKeyDown" | "onPaste">;
  readonly draftLabel?: string;
  readonly draftPlaceholder?: string;
  readonly draftDisabled?: boolean;
  readonly draft: string;
  readonly onDraftChange: (value: string, element: HTMLTextAreaElement) => void;
  readonly onDraftKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onDraftPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly showSend: boolean;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly showResume?: boolean;
  readonly onResume?: () => void;
  readonly showStop?: boolean;
  readonly onStop?: () => void;
  readonly lane?: ReactNode;
  readonly footer?: ReactNode;
}

/**
 * Pure session & staged composer surface with optional approval cover, image drop zone, slash menu, and model lane.
 */
export function ComposerBlock({
  hidden = false,
  topNotices,
  notice,
  canRestore = false,
  onRestore,
  cover = null,
  wrapDraftInert = false,
  fieldRef,
  pillRef,
  dropEnabled,
  onDropFiles,
  pictures,
  picturesDisabled,
  onRemovePicture,
  onPickPictures,
  slashMenu,
  slashFieldProps,
  draftLabel,
  draftPlaceholder,
  draftDisabled = false,
  draft,
  onDraftChange,
  onDraftKeyDown,
  onDraftPaste,
  showSend,
  canSend,
  onSend,
  showResume = false,
  onResume,
  showStop = false,
  onStop,
  lane,
  footer,
}: ComposerBlockProps) {
  const voice = useVoice();
  const formRef = useRef<HTMLFormElement>(null);
  const draftId = useId();
  const noticeId = useId();
  const covered = cover != null;

  useLayoutEffect(() => {
    const form = formRef.current;
    const field = pillRef.current;
    if (form == null || field == null) return;
    const apply = () => {
      if (field.closest(".visually-hidden") != null) return;
      const height = field.offsetHeight;
      if (height < 8) return;
      form.style.setProperty("--composer-input-h", `${height}px`);
    };
    apply();
    if (typeof ResizeObserver !== "function") return;
    const resize = new ResizeObserver(apply);
    resize.observe(field);
    return () => resize.disconnect();
  }, [pillRef]);

  const draftSurface = (
    <PictureDropSurface fieldRef={pillRef} enabled={dropEnabled} onDrop={onDropFiles}>
      <PictureChipsBlock
        disabled={picturesDisabled}
        pictures={pictures}
        onRemove={onRemovePicture}
        onPick={onPickPictures}
      />
      <SkillSlashMenuBlock menu={slashMenu} />
      <Textarea
        {...slashFieldProps}
        ref={fieldRef}
        id={draftId}
        aria-label={draftLabel ?? voice.composer.promptLabel}
        aria-describedby={noticeId}
        className="composer-draft rounded-none border-0 bg-transparent px-4 py-3 pr-12 text-base pointer-coarse:py-4 pointer-coarse:pr-14"
        disabled={draftDisabled}
        placeholder={draftPlaceholder ?? voice.composer.promptPlaceholder}
        rows={1}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value, event.currentTarget)}
        onKeyDown={onDraftKeyDown}
        onPaste={onDraftPaste}
      />
      {showSend ? (
        <Button
          variant="ghost"
          type="button"
          aria-label={voice.composer.sendLabel}
          className={fieldActionClass}
          disabled={!canSend}
          onClick={onSend}
        >
          <IconCornerDownLeft {...fieldGlyph} aria-hidden />
        </Button>
      ) : null}
      {showResume && onResume != null ? (
        <Button
          variant="ghost"
          type="button"
          aria-label="Resume interrupted turn"
          title="Resume interrupted turn"
          className={fieldActionClass}
          onClick={onResume}
        >
          <IconPlayerPlayFilled {...glyph} aria-hidden />
        </Button>
      ) : null}
      {showStop && onStop != null ? (
        <Button
          variant="ghost"
          type="button"
          aria-label={voice.composer.stopLabel}
          className={fieldActionClass}
          onClick={onStop}
        >
          <IconPlayerStopFilled {...glyph} aria-hidden />
        </Button>
      ) : null}
    </PictureDropSurface>
  );

  return (
    <form
      ref={formRef}
      className="composer sticky bottom-0 z-10"
      hidden={hidden}
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="composer-column">
        {topNotices}
        <output
          id={noticeId}
          className={notice === "" ? "block text-sm text-muted" : "mb-2 block text-sm text-muted"}
          role="status"
        >
          {notice}
        </output>
        {canRestore && onRestore != null ? (
          <p className="composer-restore">
            <span>Later messages are set aside.</span>
            <Button variant="ghost" onClick={onRestore}>
              Restore
            </Button>
          </p>
        ) : null}
        {cover == null ? null : <ApprovalCoverCard cover={cover} />}
        {wrapDraftInert ? (
          <div className={covered ? "visually-hidden" : undefined} inert={covered}>
            {draftSurface}
          </div>
        ) : (
          draftSurface
        )}
      </div>
      {lane == null ? null : (
        <div className="composer-lane">
          <div className="composer-picks">{lane}</div>
        </div>
      )}
      {footer}
    </form>
  );
}

export type StageComposerBlockProps = Omit<
  ComposerBlockProps,
  "canRestore" | "onRestore" | "cover" | "wrapDraftInert" | "showResume" | "onResume" | "showStop" | "onStop"
>;

/** Convenience alias for pre-session stage composers built on {@link ComposerBlock}. */
export function StageComposerBlock(props: StageComposerBlockProps) {
  return <ComposerBlock {...props} wrapDraftInert={false} />;
}

function ApprovalCoverCard({ cover }: { readonly cover: ApprovalCoverView }) {
  const headingId = useId();
  const commentId = useId();
  const decisionHelpId = useId();

  return (
    <section className="mb-3 rounded-md border border-edge bg-raised p-3" aria-labelledby={headingId}>
      <div className="mb-3 min-w-0">
        <h3
          ref={cover.headingRef}
          id={headingId}
          tabIndex={-1}
          className="composer-ask font-heading text-base font-strong break-words text-balance"
        >
          {cover.heading}
        </h3>
        {!cover.isAck || cover.kicker == null ? null : (
          <p className="ack-kicker text-sm font-strong text-warning">{cover.kicker}</p>
        )}
        {cover.summary == null ? null : <p className="mono mt-1 text-sm break-words text-muted">{cover.summary}</p>}
      </div>
      {!cover.isAck || cover.lede == null ? null : <p className="mb-3 text-sm text-muted">{cover.lede}</p>}
      {cover.proposedOperation}
      {cover.ackBlock}
      <label htmlFor={commentId} className="mb-1 block text-sm text-ink">
        Approval comment <span className="text-muted">(optional)</span>
      </label>
      <Textarea
        key={cover.leafId}
        id={commentId}
        aria-label="Approval comment"
        aria-describedby={decisionHelpId}
        placeholder="Optional comment"
        rows={2}
        disabled={cover.disabled}
        value={cover.comment}
        onChange={(event) => cover.onCommentChange(event.target.value)}
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p id={decisionHelpId} className="text-sm text-muted" aria-live="polite">
          {cover.submitting
            ? "Sending decision…"
            : cover.armed
              ? `Choose ${cover.copyYes} or ${cover.copyNo} explicitly. Your draft is kept.`
              : "A new request appeared. Decisions unlock after a short pause."}
          {cover.submitting || cover.riskPhrase == null || cover.riskPhrase === "" ? null : ` ${cover.riskPhrase}`}
          {cover.armed && !cover.submitting ? <ShortcutKeys yes={cover.copyYes} no={cover.copyNo} /> : null}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={cover.disabled} onClick={cover.onDeny}>
            {cover.copyNo}
          </Button>
          <Button variant={cover.destructive ? "danger" : "default"} disabled={cover.disabled} onClick={cover.onAllow}>
            {cover.copyYes}
          </Button>
        </div>
      </div>
      {cover.alwaysAutoLabels == null || cover.alwaysAutoLabels.length === 0 || cover.onAlwaysAuto == null ? null : (
        <div className="always-auto" role="group" aria-label="Always auto">
          <span className="text-muted">
            Allow, then let auto decide every “{cover.alwaysAutoLabels.join(", ")}” call:
          </span>
          <Button variant="secondary" disabled={cover.disabled} onClick={() => cover.onAlwaysAuto?.("session")}>
            Always auto · this session
          </Button>
          <Button variant="secondary" disabled={cover.disabled} onClick={() => cover.onAlwaysAuto?.("project")}>
            Always auto · this project
          </Button>
        </div>
      )}
    </section>
  );
}

function ShortcutKeys({ yes, no }: { readonly yes: string; readonly no: string }) {
  const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return (
    <span
      className="composer-keys"
      aria-label={
        apple ? `Command Enter: ${yes}. Command Backspace: ${no}.` : `Control Enter: ${yes}. Control Backspace: ${no}.`
      }
    >
      <span aria-hidden="true">
        {apple ? (
          <>
            {" "}
            <kbd>⌘</kbd>
            <kbd>↩</kbd> {yes} · <kbd>⌘</kbd>
            <kbd>⌫</kbd> {no}
          </>
        ) : (
          <>
            {" "}
            <kbd>Ctrl</kbd> <kbd>Enter</kbd> {yes} · <kbd>Ctrl</kbd> <kbd>Backspace</kbd> {no}
          </>
        )}
      </span>
    </span>
  );
}
