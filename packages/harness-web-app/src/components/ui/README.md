# Graphic Precision UI

Normative guide: [`docs/graphic-precision.md`](../../../../../docs/graphic-precision.md).
Coverage and boundaries: [`docs/graphic-precision-component-coverage.md`](../../../../../docs/graphic-precision-component-coverage.md).

Import public components from `components/ui/index.js`, or a family module for a narrow dependency. The barrel exports styled controls, **not** every raw upstream component.

## Two deliberate event contracts

- `Button`, `Input`, `Textarea`, and `NativeSelect` preserve native props/events/refs. `Input` and `Textarea` now render RAC input components. Use these when incrementally migrating existing application handlers. `Button` also accepts `onPress`; when both are supplied, each fires once. Its `content` variant preserves natural-case object text and caller-owned layout.
- `FieldButton`, `FieldInput`, `FieldTextArea`, and the other compound parts participate in React Aria contexts. Use `FieldButton` for slots such as `increment`, `decrement`, `trigger`, and `close`, not the native-compatible Button.
- `TextField` is the labeled convenience form control. `SearchField` and `NumberField` are composable roots: supply `Label`, `FieldInput`, and optional `Description`/`FieldError`.
- `Checkbox`/`Radio`/`Switch` are compatibility convenience controls. New compound forms may use `CheckboxField` + `CheckboxButton`, `RadioField` + `RadioButton`, and `SwitchField` + `SwitchButton` for field-specific descriptions/validation.

```tsx
import { SearchField, Label, FieldInput, Description } from "../components/ui/index.js";

<SearchField value={query} onChange={setQuery}>
  <Label>Filter sessions</Label>
  <FieldInput placeholder="Name or project" />
  <Description>Search the sessions available in this workspace.</Description>
</SearchField>
```

## Floating layers

`NativePopover` consumes RAC trigger/state/ref contexts and uses native Popover API + CSS Anchor Positioning. It does not call RAC `Popover`, `usePopover`, or `useOverlayPosition`. It falls back to a bounded fixed panel when CSS anchors are unavailable and retains local dismissal without Popover API. This is not a global browser polyfill or a guarantee for specialized product surfaces that still use raw native popovers.

- `DropdownSelect` is a composed labeled select. `Select` is the generic RAC root for custom composition.
- `Autocomplete` is a composed labeled combobox. `AutocompleteRoot` is the distinct upstream semantic provider for filtering arbitrary collections.
- `Menu`/`MenuItem`/`MenuTrigger`/`SubmenuTrigger` compose with `NativePopover`.
- `LabeledDatePicker` and `LabeledDateRangePicker` are full anchored fields. `DatePicker`/`DateRangePicker` remain lower-level non-positioning roots.
- `NativeDialog` adds React Aria semantics to an existing native `<dialog>` lifecycle without replacing the caller's showModal/close handling. `Dialog` owns a native `<dialog>` lifecycle. `DialogContent` supplies RAC interior semantics only; do not nest two modal lifecycle owners.
- `Tooltip` is a noninteractive native anchored hint with a persistent accessible description. It is not a container for actions.
- `FileTrigger`, `ColorPicker`, month/year picker render-prop providers, and virtualization/state/i18n utilities have no independent visual surface. Their children carry the design.

**Upgrade sensitivity:** the native adapter needs React Aria's hidden-collection lifecycle to preserve closed Select/Menu items during collection construction. Its import of `react-aria/private/collections/Hidden` is an explicit upstream-private dependency. Any React Aria upgrade requires the complete anchor, collection, form/reset, nested-menu and date-picker tests plus a real-browser dismissal/focus/placement check. Do not replace this bridge with a positioned RAC Popover as a shortcut.

## Roles and states

Labels and object names remain natural-case Source Sans 3. `Link` defaults to linked content; use `isCommand` for navigation/command symbols. Buttons and stable commands use the `label` petite-cap treatment. Do not uppercase stored strings.

Selection is muted with an explicit neutral marker, focus uses `--focus`, and lime is reserved for primary actions and small active context. Use actual token names (`bg-field`, `bg-canvas`, `bg-raised`, `bg-wash`). In Tailwind 4, an `outline-none` base needs `data-[focus-visible]:outline-solid` as well as width/color to restore a visible outline.

Stories cover both themes. Automated tests cover semantics and interactions, not real-browser CSS anchor geometry, screen-reader output, or visual acceptance.

Product settings and acknowledgement choices use `DropdownSelect`, including disabled options. `NativeSelect` remains a compatibility export with no current product consumer. The hidden picture file input remains native browser plumbing because composer triggers access its file/change API; its visible actions use styled toolbelt controls.
