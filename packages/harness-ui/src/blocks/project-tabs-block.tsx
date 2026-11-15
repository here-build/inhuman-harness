import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { IconChevronDown, IconCopy, IconPlus } from "@tabler/icons-react";

import { Menu, MenuItem, MenuTrigger, NativePopover } from "../primitives/anchored.js";
import { Button } from "../primitives/button.js";
import { glyph } from "../primitives/glyph.js";
import { FieldButton, Link } from "../primitives/navigation.js";
import { useVoice } from "../voice/index.js";

/** Navigation tab flavor in the workspace project strip. */
export type ProjectTabKind = "overview" | "project" | "bots";

/** Pure presentation item for one tab in {@link ProjectTabsBlock}. */
export interface ProjectTabItem {
  readonly key: string;
  readonly kind: ProjectTabKind;
  readonly active: boolean;
  readonly href?: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly title?: string;
  readonly status?: ReactNode;
  readonly menu?: ReactNode;
  readonly onSelect?: () => void;
}

export interface ProjectTabsBlockProps {
  readonly activeKey: string;
  readonly tabs: readonly ProjectTabItem[];
  readonly onNavigate?: (href: string) => void;
  readonly onAdd?: () => void;
  readonly addLabel?: string;
  readonly adding?: boolean;
  readonly listLabel?: string;
}

/**
 * Scrollable horizontal strip of workspace project tabs with optional menu trigger and add action.
 */
export function ProjectTabsBlock({
  activeKey,
  tabs,
  onNavigate,
  onAdd,
  addLabel = "Add",
  adding = false,
  listLabel,
}: ProjectTabsBlockProps) {
  const voice = useVoice();
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = activeRef.current;
    if (typeof node?.scrollIntoView === "function") {
      node.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [activeKey]);

  return (
    <div className="flex min-w-0 flex-1">
      <nav ref={listRef} className="project-tablist" aria-label={listLabel ?? voice.workspace.projectsLabel}>
        {tabs.map((tab) => {
          const select: NonNullable<ComponentProps<typeof Link>["onClick"]> = (event): void => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (tab.href != null && onNavigate != null) onNavigate(tab.href);
          };

          return (
            <div
              key={tab.key}
              ref={tab.active ? activeRef : undefined}
              className="project-tab touch-target"
              data-tab={tab.kind}
              data-active={tab.active ? "" : undefined}
            >
              {tab.href == null ? (
                <Button
                  variant="ghost"
                  aria-current={tab.active ? "page" : undefined}
                  className="project-tab-main"
                  aria-label={tab.label}
                  title={tab.title ?? tab.label}
                  onClick={tab.onSelect}
                >
                  {tab.icon}
                  <span className="project-tab-label truncate">{tab.label}</span>
                  {tab.status}
                </Button>
              ) : (
                <Link
                  isCommand
                  aria-current={tab.active ? "page" : undefined}
                  className="project-tab-main no-underline"
                  href={tab.href}
                  aria-label={tab.label}
                  title={tab.title ?? tab.label}
                  onClick={select}
                >
                  {tab.icon}
                  <span className="project-tab-label truncate">{tab.label}</span>
                  {tab.status}
                </Link>
              )}
              {tab.menu}
            </div>
          );
        })}
      </nav>
      {onAdd == null ? null : (
        <div className="project-add">
          <Button variant="secondary" disabled={adding} onClick={onAdd}>
            <IconPlus {...glyph} aria-hidden />
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export interface ProjectTabMenuProps {
  readonly path: string;
  readonly name: string;
  readonly newSessionLabel?: string;
  readonly onMint: () => void;
}

/**
 * Anchored context menu attached to the active project tab (`Copy path`, `New session`).
 */
export function ProjectTabMenu({ path, name, newSessionLabel, onMint }: ProjectTabMenuProps) {
  const voice = useVoice();
  const errorId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "pending" | "copied" | "error">("idle");
  const copyAttempt = useRef<object>(undefined);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
      copyAttempt.current = undefined;
    },
    [],
  );

  const changeOpen = (open: boolean): void => {
    clearTimeout(copiedTimer.current);
    copyAttempt.current = undefined;
    setCopyStatus("idle");
    setIsOpen(open);
  };

  const copy = async (): Promise<void> => {
    if (copyAttempt.current) return;
    const attempt = {};
    copyAttempt.current = attempt;
    setCopyStatus("pending");
    try {
      await navigator.clipboard.writeText(path);
      // A dismissed menu must not update (or close) a later opening.
      if (copyAttempt.current !== attempt) return;
      setCopyStatus("copied");
      copiedTimer.current = setTimeout(() => changeOpen(false), 600);
    } catch {
      if (copyAttempt.current !== attempt) return;
      copyAttempt.current = undefined;
      setCopyStatus("error");
    }
  };

  const newSession = newSessionLabel ?? voice.workspace.newSessionLabel;

  return (
    <div className={`project-tab-menu${isOpen ? " [.project-tab:not(:has(.project-tab-main:hover))_&]:bg-hover" : ""}`}>
      <MenuTrigger isOpen={isOpen} onOpenChange={changeOpen}>
        <FieldButton className="project-tab-chevron border-0 p-0" aria-label={`${name} menu`}>
          <IconChevronDown {...glyph} aria-hidden />
        </FieldButton>
        <NativePopover placement="top-end">
          <Menu aria-label={name}>
            <MenuItem
              id="copy"
              textValue="Copy path"
              className="project-menu-item"
              shouldCloseOnSelect={false}
              isDisabled={copyStatus === "pending" || copyStatus === "copied"}
              aria-describedby={copyStatus === "error" ? errorId : undefined}
              onAction={() => void copy()}
            >
              <IconCopy {...glyph} aria-hidden />
              {copyStatus === "copied" ? voice.common.copied : "Copy path"}
            </MenuItem>
            <MenuItem
              id="new-session"
              textValue={newSession}
              className="project-menu-item"
              onAction={() => {
                changeOpen(false);
                onMint();
              }}
            >
              <IconPlus {...glyph} aria-hidden />
              {newSession}
            </MenuItem>
          </Menu>
          {copyStatus === "error" ? (
            <p id={errorId} role="alert" className="px-2 py-1 text-sm text-danger">
              Could not copy path. Try again or copy it manually: {path}
            </p>
          ) : null}
        </NativePopover>
      </MenuTrigger>
    </div>
  );
}
