import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { completeSkillSlash, matchingSkills, skillInvoke, skillSlashToken, type SkillSlashRow } from "./skill-slash.js";

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
    if (next == null || next.scope !== scope || next.value !== value || field == null || disabled) return;
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
      const row = matches[index];
      if (row == null) return false;
      event.preventDefault();
      choose(row);
      return true;
    }
    return false;
  }

  return {
    menu: open
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
      : null,
    onKeyDown,
    track,
    fieldProps: {
      // A native textarea is a multiline textbox. ARIA permits a textbox to
      // control a listbox and reference its active option; no combobox role or
      // DOM focus transfer is needed (WAI-ARIA, aria-activedescendant).
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? id : undefined,
      "aria-activedescendant": activeId,
      onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => track(event.currentTarget),
      onBlur: () => setCursor((current) => ({ ...current, focused: false })),
      onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => track(event.currentTarget),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => {
        setComposing(false);
        track(event.currentTarget);
      },
    },
  };
}
