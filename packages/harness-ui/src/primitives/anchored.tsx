import {
  cloneElement,
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
  type RefObject,
} from "react";
import { FocusScope, useDialog, useObjectRef } from "react-aria";
import { filterDOMProps } from "react-aria/filterDOMProps";
// RAC's collection builder renders a hidden copy before the real control. Like
// RAC Popover, this shell must preserve collection children in that copy.
import { useIsHidden } from "react-aria/private/collections/Hidden";
import { ClearPressResponder } from "react-aria/private/interactions/PressResponder";
import { FocusableContext } from "react-aria/private/interactions/useFocusable";
import {
  Button,
  ComboBox as AriaComboBox,
  FieldError,
  Group,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  OverlayTriggerStateContext,
  PopoverContext,
  Select as AriaSelect,
  SelectValue,
  SubmenuTrigger as AriaSubmenuTrigger,
  Text,
  composeRenderProps,
  useContextProps,
  useSlottedContext,
  type ComboBoxProps,
  type Key,
  type MenuItemProps,
  type MenuProps,
  type MenuSectionProps,
  type PopoverProps,
  type SelectProps,
  type ValidationResult,
} from "react-aria-components";
import { createPortal } from "react-dom";

import { cn } from "../lib/cn.js";
import { normalizePlacement, useFloatingPosition, type FloatingPlacement } from "../positioning/floating.js";
import { EMPHASIS_BOUNDARY, PROMINENCE_BOUNDARY, SURFACE_BOUNDARY } from "../theme/index.js";
import { useVoice } from "../voice/index.js";

export function Select<T, M extends "single" | "multiple" = "single">({
  className,
  ...props
}: SelectProps<T, M> & RefAttributes<HTMLDivElement>) {
  return <AriaSelect {...props} className={composeRenderProps(className, (value) => cn("gp-anchored-field", value))} />;
}

export function ComboBox<T extends object>({ className, ...props }: ComboBoxProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaComboBox {...props} className={composeRenderProps(className, (value) => cn("gp-anchored-field", value))} />
  );
}

export function Menu<T extends object>({ className, ...props }: MenuProps<T> & RefAttributes<HTMLDivElement>) {
  return <AriaMenu {...props} className={composeRenderProps(className, (value) => cn("gp-anchored-list", value))} />;
}

export const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(function MenuItemControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaMenuItem
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) => cn("label gp-anchored-item", value))}
    />
  );
});

export function MenuSection<T extends object>({ className, ...props }: MenuSectionProps<T>) {
  return <AriaMenuSection {...props} className={cn("gp-anchored-section", className)} />;
}

// Collection branch components must remain RAC branches, rather than adding DOM
// around their children. Styling belongs to MenuItem and the native shell.
export const SubmenuTrigger: typeof AriaSubmenuTrigger = AriaSubmenuTrigger;

let lastPopoverEscapeDialog: { dialog: HTMLDialogElement; at: number } | null = null;
let cleanupSwallowedTriggerClick: (() => void) | null = null;

function markPopoverEscape() {
  const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  lastPopoverEscapeDialog =
    dialogs.length > 0 ? { dialog: dialogs.item(dialogs.length - 1), at: performance.now() } : null;
}

export interface NativePopoverProps extends Omit<PopoverProps, "children" | "className" | "style" | "placement"> {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  popover?: "auto" | "manual";
  lightDismiss?: boolean;
  placement?: FloatingPlacement;
  matchTriggerWidth?: boolean;
  restoreFocus?: boolean;
}

const NativePopoverContainer = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** Native top-layer lifecycle + Safari 18.7+ viewport-clamped positioning; never calls usePopover/useOverlayPosition. */
export const NativePopover = forwardRef<HTMLDivElement, NativePopoverProps>(
  function NativePopoverControl(inputProps, forwardedRef) {
    const context = useSlottedContext(PopoverContext);
    const parentContainer = useContext(NativePopoverContainer);
    const [props, contextRef] = useContextProps(inputProps, forwardedRef as ForwardedRef<HTMLElement>, PopoverContext);
    const ref = contextRef as RefObject<HTMLDivElement | null>;
    const state = useContext(OverlayTriggerStateContext);
    const [localOpen, setLocalOpen] = useState(props.defaultOpen ?? false);
    const isOpen = props.isOpen ?? state?.isOpen ?? localOpen;
    const latest = useRef({ isOpen, close: () => {} });
    const close = () => {
      if (props.onOpenChange) props.onOpenChange(false);
      else if (state) state.close();
      else setLocalOpen(false);
    };
    latest.current = { isOpen, close };
    const hidden = useIsHidden();
    const triggerRef = props.triggerRef;
    const native = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
    const isComboBox = props.trigger === "ComboBox";
    const resolvedPlacement = normalizePlacement(
      inputProps.placement ?? props.placement,
      props.trigger === "SubmenuTrigger" ? "right-start" : "bottom-start",
    );
    const popoverMode = props.popover ?? "manual";
    const lightDismiss = props.lightDismiss ?? (popoverMode === "manual" || !native);

    useLayoutEffect(() => {
      if (hidden || !isOpen) return;
      const element = ref.current;
      if (!element) return;
      // Mount into the top layer before RAC's list/menu autofocus effect runs.
      if (native && !element.matches(":popover-open")) element.showPopover();
      return () => {
        if (native && element.matches(":popover-open")) element.hidePopover();
      };
    }, [hidden, isOpen, native, ref]);

    useFloatingPosition({
      triggerRef,
      floatingRef: ref,
      isOpen: !hidden && isOpen,
      placement: resolvedPlacement,
      matchTriggerWidth: props.matchTriggerWidth,
    });

    useEffect(() => {
      if (hidden || !isOpen || !lightDismiss) return;
      // Popovers default to popover="manual" with explicit outside-pointerdown and
      // Escape dismissal so opening during pointerdown does not light-dismiss on
      // pointerup without showPopover({ source }) (Safari 18.7+).
      const isTopmost = () => [...document.querySelectorAll("[data-light-dismiss]")].at(-1) === ref.current;
      const pointer = (event: PointerEvent) => {
        cleanupSwallowedTriggerClick?.();
        if (event.button > 0 || !isTopmost()) return;
        const target = event.target;
        if (!(target instanceof Node) || ref.current?.contains(target)) return;
        if (
          props.shouldCloseOnInteractOutside &&
          target instanceof Element &&
          !props.shouldCloseOnInteractOutside(target)
        ) {
          return;
        }
        if (triggerRef?.current?.contains(target)) {
          if (props.isNonModal || props.trigger === "SubmenuTrigger") return;
          const triggerButton = target instanceof Element ? target.closest("button, [role='button']") : null;
          if (triggerButton && triggerRef.current.contains(triggerButton)) {
            const swallow = (followup: Event) => {
              if (followup.target instanceof Node && triggerButton.contains(followup.target)) {
                followup.preventDefault();
                followup.stopPropagation();
              }
            };
            const done = () => {
              document.removeEventListener("pointerup", onPointerUp, true);
              document.removeEventListener("click", onClick, true);
              document.removeEventListener("pointercancel", done, true);
              if (cleanupSwallowedTriggerClick === done) cleanupSwallowedTriggerClick = null;
            };
            const onPointerUp = (followup: PointerEvent) => {
              if (!(followup.target instanceof Node) || !triggerButton.contains(followup.target)) {
                done();
                return;
              }
              swallow(followup);
            };
            const onClick = (followup: MouseEvent) => {
              swallow(followup);
              done();
            };
            cleanupSwallowedTriggerClick = done;
            document.addEventListener("pointerup", onPointerUp, true);
            document.addEventListener("click", onClick, true);
            document.addEventListener("pointercancel", done, true);
            event.preventDefault();
            event.stopPropagation();
            if (triggerButton instanceof HTMLElement) triggerButton.focus();
          }
          latest.current.close();
          return;
        }
        latest.current.close();
      };
      const keyboard = (event: KeyboardEvent) => {
        if (event.key === "Escape" && isTopmost()) {
          markPopoverEscape();
          event.preventDefault();
          event.stopPropagation();
          latest.current.close();
        }
      };
      document.addEventListener("pointerdown", pointer, true);
      document.addEventListener("keydown", keyboard);
      return () => {
        document.removeEventListener("pointerdown", pointer, true);
        document.removeEventListener("keydown", keyboard);
      };
    }, [hidden, isOpen, lightDismiss, props, ref, triggerRef]);

    if (hidden) return <>{props.children}</>;
    if (!isOpen) return null;
    let children = props.children;
    // Clear exactly the contexts RAC would clear (e.g. ComboBox's Input/Group),
    // but retain ListBox/Menu state and its virtual-focus/selection semantics.
    for (const Context of [PopoverContext, ...(context?.clearContexts ?? [])]) {
      children = <Context.Provider value={null}>{children}</Context.Provider>;
    }
    const content = (
      <div
        {...filterDOMProps(props, { global: true })}
        ref={ref}
        popover={popoverMode}
        data-light-dismiss={lightDismiss ? "" : undefined}
        data-native-fallback={!native || undefined}
        data-placement={props.trigger === "SubmenuTrigger" ? "end" : "bottom"}
        className={cn("gp-native-popover", SURFACE_BOUNDARY, PROMINENCE_BOUNDARY, EMPHASIS_BOUNDARY, props.className)}
        style={props.style}
        onKeyDownCapture={(event) => {
          // A native submenu is mounted beside (not inside) the parent Menu.
          // Handle level dismissal at this boundary before an inherited Menu
          // onClose can collapse the entire menu stack.
          const back = getComputedStyle(event.currentTarget).direction === "rtl" ? "ArrowRight" : "ArrowLeft";
          if (props.trigger === "SubmenuTrigger" && (event.key === back || event.key === "Escape")) {
            markPopoverEscape();
            event.preventDefault();
            event.stopPropagation();
            latest.current.close();
            if (triggerRef?.current instanceof HTMLElement) triggerRef.current.focus();
            return;
          }
          if (
            lightDismiss &&
            event.key === "Escape" &&
            [...document.querySelectorAll("[data-light-dismiss]")].at(-1) === ref.current
          ) {
            markPopoverEscape();
            event.preventDefault();
            event.stopPropagation();
            latest.current.close();
          }
        }}
        onToggle={(event) => {
          // toggle is asynchronous/coalesced. Ignore a stale closed notification
          // after a reopen by checking the actual native state too.
          if (
            event.newState === "closed" &&
            latest.current.isOpen &&
            (!native || !event.currentTarget.matches(":popover-open"))
          ) {
            latest.current.close();
          }
        }}
      >
        <NativePopoverContainer.Provider value={ref}>
          <ClearPressResponder>
            <FocusableContext.Provider value={null}>{children}</FocusableContext.Provider>
          </ClearPressResponder>
        </NativePopoverContainer.Provider>
      </div>
    );
    const overlay =
      props.restoreFocus === false || isComboBox ? content : <FocusScope restoreFocus>{content}</FocusScope>;
    // RAC closes a submenu when focus enters another item in its parent Menu.
    // Native top-layer promotion alone does not change DOM ancestry, so mount
    // submenus beside the parent Menu, keeping modal <dialog open> containment intact.
    return props.trigger === "SubmenuTrigger" && parentContainer?.current
      ? createPortal(overlay, parentContainer.current)
      : overlay;
  },
);

export interface AnchoredOption {
  id: Key;
  label: string;
  description?: string;
  isDisabled?: boolean;
}

interface FieldContent {
  label: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode | ((validation: ValidationResult) => ReactNode);
  options: readonly AnchoredOption[];
  className?: string;
}

export interface DropdownSelectProps
  extends Omit<SelectProps<AnchoredOption>, "children" | "items" | "className">, FieldContent {}

export const DropdownSelect = forwardRef<HTMLButtonElement, DropdownSelectProps>(function DropdownSelectControl(
  { label, description, errorMessage, options, className, disabledKeys, ...props },
  ref,
) {
  return (
    <Select
      {...props}
      className={className}
      disabledKeys={disabledKeys ?? options.filter((item) => item.isDisabled).map((item) => item.id)}
    >
      <Label className="gp-anchored-label">{label}</Label>
      <Button ref={ref} className="gp-anchored-trigger">
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </Button>
      {description != null && (
        <Text slot="description" className="gp-anchored-description">
          {description}
        </Text>
      )}
      <FieldError className="gp-anchored-error">{errorMessage}</FieldError>
      <NativePopover>
        <ListBox items={options} className="gp-anchored-list">
          {(item) => (
            <ListBoxItem id={item.id} textValue={item.label} className="gp-anchored-item">
              <Text slot="label">{item.label}</Text>
              {item.description && (
                <Text slot="description" className="gp-anchored-description">
                  {item.description}
                </Text>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </NativePopover>
    </Select>
  );
});

export interface AutocompleteProps
  extends Omit<ComboBoxProps<AnchoredOption>, "children" | "items" | "defaultItems" | "className">, FieldContent {
  placeholder?: string;
}

export const Autocomplete = forwardRef<HTMLInputElement, AutocompleteProps>(function AutocompleteControl(
  { label, description, errorMessage, options, className, placeholder, disabledKeys, ...props },
  ref,
) {
  const voice = useVoice();
  return (
    <ComboBox
      {...props}
      defaultItems={options}
      className={className}
      disabledKeys={disabledKeys ?? options.filter((item) => item.isDisabled).map((item) => item.id)}
    >
      <Label className="gp-anchored-label">{label}</Label>
      <Group className="gp-anchored-input-group">
        <Input ref={ref} placeholder={placeholder} className="gp-anchored-input" />
        <Button className="gp-anchored-trigger" aria-label={voice.select.showSuggestions}>
          ▾
        </Button>
      </Group>
      {description != null && (
        <Text slot="description" className="gp-anchored-description">
          {description}
        </Text>
      )}
      <FieldError className="gp-anchored-error">{errorMessage}</FieldError>
      <NativePopover restoreFocus={false} matchTriggerWidth>
        <ListBox
          className="gp-anchored-list"
          renderEmptyState={() => <div className="gp-anchored-empty">{voice.select.noMatches}</div>}
        >
          {(item: AnchoredOption) => (
            <ListBoxItem id={item.id} textValue={item.label} className="gp-anchored-item">
              <Text slot="label">{item.label}</Text>
              {item.description && (
                <Text slot="description" className="gp-anchored-description">
                  {item.description}
                </Text>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </NativePopover>
    </ComboBox>
  );
});

export interface TooltipProps {
  children: ReactElement<{ "aria-describedby"?: string }>;
  content: ReactNode;
  delay?: number;
  closeDelay?: number;
}

/** Noninteractive hint. The description exists even while its visual hint is delayed. */
export function Tooltip({ children, content, delay = 600, closeDelay = 100 }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [isOpen, setOpen] = useState(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  const schedule = (open: boolean) => {
    cancel();
    timer.current = setTimeout(() => setOpen(open), open ? delay : closeDelay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span
      className="gp-anchored-tooltip-trigger"
      ref={triggerRef}
      onPointerEnter={() => {
        hovered.current = true;
        schedule(true);
      }}
      onPointerLeave={() => {
        hovered.current = false;
        if (!focused.current) schedule(false);
      }}
      onFocus={() => {
        focused.current = true;
        cancel();
        setOpen(true);
      }}
      onBlur={() => {
        focused.current = false;
        if (!hovered.current) schedule(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          setOpen(false);
        }
      }}
    >
      {cloneElement(children, {
        "aria-describedby": [children.props["aria-describedby"], id].filter(Boolean).join(" "),
      })}
      <span id={id} role="tooltip" className="gp-anchored-sr-only">
        {content}
      </span>
      <NativePopover
        isOpen={isOpen}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        popover="manual"
        lightDismiss={false}
        placement="top"
        restoreFocus={false}
        className="gp-anchored-tooltip"
      >
        <span aria-hidden="true">{content}</span>
      </NativePopover>
    </span>
  );
}

export interface DialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  label: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A native modal dialog: browser top layer/inert/focus return, Aria labelling. */
export const Dialog = forwardRef<HTMLDialogElement, DialogProps>(function DialogControl(
  { isOpen, onOpenChange, label, children, className },
  forwardedRef,
) {
  const ref = useObjectRef(forwardedRef);
  const id = useId();
  const { dialogProps, titleProps } = useDialog({ "aria-labelledby": id }, ref);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (isOpen && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    } else if (!isOpen && element.open) {
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
    }
  }, [isOpen, ref]);
  return (
    <dialog
      {...dialogProps}
      ref={ref}
      className={cn("gp-native-dialog", SURFACE_BOUNDARY, PROMINENCE_BOUNDARY, EMPHASIS_BOUNDARY, className)}
      onCancel={(event) => {
        event.preventDefault();
        if (
          lastPopoverEscapeDialog?.dialog === event.currentTarget &&
          performance.now() - lastPopoverEscapeDialog.at < 50
        ) {
          lastPopoverEscapeDialog = null;
          return;
        }
        onOpenChange(false);
      }}
      onClose={() => {
        if (isOpen) onOpenChange(false);
      }}
    >
      <h2 {...titleProps} id={id}>
        {label}
      </h2>
      {children}
    </dialog>
  );
});

export {
  Heading,
  Label,
  ListBox,
  ListBoxItem,
  MenuTrigger,
  SelectValue,
  type SubmenuTriggerProps,
} from "react-aria-components";
