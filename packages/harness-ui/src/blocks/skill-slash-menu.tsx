import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";

import { NativePopover, Text } from "../primitives/index.js";
import { useVoice } from "../voice/index.js";

/** One skill candidate exposed by the slash-completion menu. */
export interface SkillSlashRow {
  readonly name: string;
  readonly invoke?: string;
  readonly description?: string;
  readonly location?: string;
}

export function skillInvoke(row: SkillSlashRow): string {
  return row.invoke != null && row.invoke !== "" ? row.invoke : row.name;
}

export function skillSlashToken(value: string, start: number, end = start): string | null {
  if (start !== end || start < 1) return null;
  const token = /^\/(\S*)/.exec(value);
  if (token == null || start > token[0].length) return null;
  // Once arguments exist, Enter is the ordinary send action, even if the caret moved back.
  if (value.slice(token[0].length).trim() !== "") return null;
  return token[1];
}

export function matchingSkills(rows: readonly SkillSlashRow[], token: string): SkillSlashRow[] {
  const query = token.toLowerCase();
  const seen = new Set<string>();
  return rows.filter((row) => {
    const invoke = skillInvoke(row);
    if (invoke === "" || seen.has(invoke)) return false;
    seen.add(invoke);
    return invoke.toLowerCase().startsWith(query) || row.name.toLowerCase().startsWith(query);
  });
}

export function completeSkillSlash(value: string, row: SkillSlashRow): { value: string; caret: number } {
  const token = /^\/\S*/.exec(value)?.[0] ?? "";
  const remainder = value.slice(token.length);
  const prefix = `/${skillInvoke(row)} `;
  return { value: prefix + (remainder.startsWith(" ") ? remainder.slice(1) : remainder), caret: prefix.length };
}

export interface SkillSlashMenuModel {
  readonly id: string;
  readonly activeId: string | undefined;
  readonly rows: readonly SkillSlashRow[];
  readonly index: number;
  readonly choose: (row: SkillSlashRow) => void;
  readonly fieldRef: RefObject<HTMLTextAreaElement | null>;
  readonly dismiss: () => void;
}

/** Shared by session and staged fields; the caller owns the catalog and the draft. */
export function useSkillSlash({
  scope,
  rows,
  value,
  disabled,
  fieldRef,
  onChange,
}: {
  readonly scope: string;
  readonly rows: readonly SkillSlashRow[];
  readonly value: string;
  readonly disabled: boolean;
  readonly fieldRef: RefObject<HTMLTextAreaElement | null>;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  const [cursor, setCursor] = useState({ scope: "", focused: false, start: 0, end: 0 });
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState("");
  const [selection, setSelection] = useState({ key: "", index: 0 });
  const token = skillSlashToken(value, cursor.start, cursor.end);
  // Catalog changes invalidate both an old selected index and old click handlers.
  const key = JSON.stringify([
    scope,
    value,
    cursor.start,
    cursor.end,
    rows.map((row) => [row.name, row.invoke, row.description, row.location]),
  ]);
  const matches = token == null ? [] : matchingSkills(rows, token);
  const open =
    !disabled &&
    !composing &&
    cursor.focused &&
    cursor.scope === scope &&
    token != null &&
    matches.length > 0 &&
    dismissed !== key;
  const index = selection.key === key ? Math.min(selection.index, matches.length - 1) : 0;
  const activeId = open ? `${id}-${index}` : undefined;
  const latest = useRef({ key, open });
  latest.current = { key, open };

  function track(field: HTMLTextAreaElement): void {
    setCursor({
      scope,
      focused: document.activeElement === field,
      start: field.selectionStart,
      end: field.selectionEnd,
    });
  }

  useLayoutEffect(() => {
    setComposing(false);
    setDismissed("");
    setSelection({ key: "", index: 0 });
    const field = fieldRef.current;
    if (field != null) track(field);
  }, [scope, fieldRef]);

  const pending = useRef<{ scope: string; value: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const next = pending.current;
    pending.current = null;
    const field = fieldRef.current;
    if (next?.scope !== scope || next.value !== value || field == null || disabled) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(next.caret, next.caret);
    track(field);
  });

  function choose(row: SkillSlashRow): void {
    const field = fieldRef.current;
    if (!latest.current.open || latest.current.key !== key || field == null || document.activeElement !== field) return;
    if (!matches.some((candidate) => skillInvoke(candidate) === skillInvoke(row))) return;
    const next = completeSkillSlash(value, row);
    pending.current = { scope, ...next };
    onChange(next.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(key);
      return true;
    }
    if (event.shiftKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSelection({ key, index: (index + direction + matches.length) % matches.length });
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (index < 0 || index >= matches.length) return false;
      const row = matches[index];
      event.preventDefault();
      choose(row);
      return true;
    }
    return false;
  }

  const menu: SkillSlashMenuModel | null = open
    ? {
        id,
        activeId,
        rows: matches,
        index,
        choose,
        fieldRef,
        dismiss: () => {
          if (latest.current.open && latest.current.key === key) setDismissed(key);
        },
      }
    : null;

  return {
    menu,
    onKeyDown,
    track,
    fieldProps: {
      // A native textarea is a multiline textbox. ARIA permits a textbox to
      // control a listbox and reference its active option; no combobox role or
      // DOM focus transfer is needed (WAI-ARIA, aria-activedescendant).
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? id : undefined,
      "aria-activedescendant": activeId,
      onFocus: (event: FocusEvent<HTMLTextAreaElement>) => track(event.currentTarget),
      onBlur: () => setCursor((current) => ({ ...current, focused: false })),
      onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => track(event.currentTarget),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => {
        setComposing(false);
        track(event.currentTarget);
      },
    },
  };
}

export interface SkillSlashMenuBlockProps {
  readonly menu: SkillSlashMenuModel | null;
}

/** Floating slash-completion menu anchored to the composer field. */
export function SkillSlashMenuBlock({ menu }: SkillSlashMenuBlockProps) {
  const voice = useVoice();
  const activeId = menu?.activeId;

  useEffect(() => {
    if (activeId == null) return;
    const option = document.querySelector(`#${CSS.escape(activeId)}`);
    if (option != null && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [activeId]);

  if (menu == null) return null;
  return (
    <NativePopover
      isOpen
      popover="auto"
      triggerRef={menu.fieldRef}
      placement="top-start"
      matchTriggerWidth
      restoreFocus={false}
      onOpenChange={(open) => {
        if (!open) menu.dismiss();
      }}
      className="skill-slash-popover"
    >
      <div
        id={menu.id}
        role="listbox"
        aria-label={voice.composer.slashCommandsLabel}
        className="font-sans text-sm text-ink normal-case"
      >
        {menu.rows.map((row, index) => {
          const id = `${menu.id}-${index}`;
          return (
            <div
              key={skillInvoke(row)}
              id={id}
              role="option"
              aria-selected={index === menu.index}
              aria-labelledby={`${id}-label`}
              aria-describedby={row.description ? `${id}-description` : undefined}
              className={`block w-full cursor-default border-l-2 px-3 py-2 text-left hover:bg-hover ${
                index === menu.index ? "border-[var(--selection-marker)] bg-selected" : "border-transparent"
              }`}
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => menu.choose(row)}
            >
              <Text id={`${id}-label`} elementType="code" className="block truncate font-mono normal-case">
                /{skillInvoke(row)}
              </Text>
              {!row.description ? null : (
                <Text id={`${id}-description`} className="line-clamp-2 break-words font-sans text-muted normal-case">
                  {row.description}
                </Text>
              )}
            </div>
          );
        })}
      </div>
    </NativePopover>
  );
}
