# Graphic Precision — React Aria coverage

The target is every **component family in the installed `react-aria-components` version**, not a hand-picked button kit. Version currently inspected: **1.22.1**. Contexts, state hooks, internationalization, collection builders, and layout engines are integration utilities, not independently styled widgets.

Normative rules: [Graphic Precision](graphic-precision.md). Migration/acceptance gates: [web rebuild](graphic-precision-web-rebuild.md).

## Implementation batches

The following families are implemented and integrated into the public `src/components/ui/index.ts` API. Each family has working Storybook examples and behavior tests. Auxiliary providers and slots are composable parts, not standalone screens; real-browser acceptance remains separate from automated checks.

| Family | Library module | Coverage target |
|---|---|---|
| Foundation controls | `button`, `input`, `native-select`, `text-field`, `checkbox`, `radio-group`, `switch`, `tabs`, `choice-fields` | Native-compatible adapters; labeled fields; choices; tabs; compound field/button variants with help and validation |
| Forms, quantities, colors | `form-controls`, `field-parts` | Form, label, help/error, group, search, number field, slider, progress, meter, checkbox group, toggle buttons, color controls |
| Collections and data | `collections`, `collection-parts` | ListBox, GridList, Table, Tree, TagGroup; sections, headers, items, selection and drop indicators |
| Dates and time | `date-controls`, `anchored-dates`, `field-parts` | DateField, TimeField, segmented inputs; Calendar/RangeCalendar and month/year navigation providers; non-positioning picker roots **and full labeled native-anchored date/range pickers** |
| Navigation and composition | `navigation` | Link, Breadcrumbs, Disclosure/Group/Panel, Toolbar, Heading, Text, Keyboard, Separator |
| Feedback and files | `feedback` | Dialog semantics, toast region/content/queue, file trigger, drop zone, tooltip trigger context |
| Anchored choices | `anchored` | Select, ComboBox, Menu and associated items/sections/triggers, using native anchors rather than RAC positioning |
| Advanced editing/navigation | `advanced` | TokenField/Input/Token; NavigationTree; Virtualizer and layouts; internationalization, filtering and collection utilities |

## Non-negotiable overlay boundary

- `react-aria-components` **Popover and Tooltip positioning must not own product overlays**. Floating surfaces remain native Popover API + CSS Anchor Positioning.
- Modal lifecycle remains native `<dialog>` where already used. A RAC `Dialog` can supply interior semantics; importing RAC Modal/ModalOverlay as a replacement is not part of this migration.
- `OverlayArrow` is optional decoration, not a positioning authority. The default system does not need an arrow.
- Selection roots and state contexts may be exposed separately from their native anchored shell. Such roots do not constitute a complete picker on their own and must be described honestly.
- PreviewTrigger, Sheet, and SharedElementTransition are upstream specialized/experimental behavior, not permission to add a second floating/animation system. They require an explicit native-anchor adapter or an explicit documented exception before product use.
- Reduced-motion mode must remove movement from authored transitions. No decorative continuous pulses or scanning animations.

## API and design contract

Wrappers preserve upstream typed value/selection APIs, render props, refs where applicable, and native form semantics. They do not encode application RPC behavior. The compatibility `Button` keeps native `onClick`; RAC press semantics must not swallow parent events or ignore a caller's keyboard cancellation.

Object names, field labels, values, descriptions and table content use natural-case Source Sans 3. Commands/navigation/status symbols use petite caps through styling, never mutated source strings. Structural headings use Nunito Sans. Technical values use Monaspace Krypton. Dates and ordinary numbers remain content, optionally tabular.

Collection selection uses a muted surface **and an explicit marker**; focus is a distinct high-contrast outline. Functional circles (radio indicators, slider knobs and color wheels) remain valid exceptions to rectangular geometry. Disabled, readonly, invalid, pending, hover, focus and selected are independent states.

## Screen migration sequence

1. Settings, permissions, and provider connection: labeled fields, choices, help/error relationships and preserved save behavior.
2. First-run provider discovery and session navigation: persistent search labels, command/content roles, visible focus and explicit current-row markers.
3. File preview and composer actions: quiet loading/error states, technical values preserved literally, no edits to execution/streaming behavior.
4. Anchored model/permission menus: use the tested anchor adapter only after keyboard, nested dismissal and focus-return parity are established.
5. Remaining application journeys and manual acceptance in light/dark, narrow/desktop, reduced motion, keyboard and screen reader.

## Verification

### Automated integration

Historical checks for that implementation pass: **853 tests across 75 files pass**, including **149 mounted/played stories plus the catalog inventory check**; TypeScript, production build and Storybook build pass. ESLint exits successfully with **0 errors and 43 warnings**. Those historical numbers included concurrent changes outside that migration; they are not the current lane totals.

- Consumer behavior tests exercise typed collection consumers and the native/RAC event boundary. The prior export inventory and source-grep checks were retired during test normalization; browser-rendered focus/appearance approvals now cover the shared working controls.
- The story gate now checks the on-disk catalog against imported story files so new stories cannot silently fall outside mount/play verification.
- Behavior coverage includes segmented date input and anchored date/range pickers, hidden select form/reset/disabled behavior, typeahead, ComboBox filtering, nested submenu keyboard dismissal/focus return, tooltip timing, native dialogs, editable tokens, virtualized offscreen keyboard selection, sortable tables, disclosures, upload/drop semantics and toast queues.
- First product migration is implemented: settings (including a native-select adapter), provider connection, permission probe, first-run provider discovery, session rail, and file preview. Existing routing/RPC/native dialog ownership remains intact.
- Static review fixes include link-foreground contrast in the light theme, command/content typography, visible solid focus outlines in Tailwind 4, typed item/ref preservation, and preventing search submission from bypassing disabled provider tiles during connection loss.

This is not a claim that every upstream export or every screen has passed a browser accessibility audit. Upstream `UNSTABLE_*` toasts are explicitly isolated in `feedback`; specialized Sheet/Preview/transition behavior and raw Modal/Popover/Tooltip are not silently substituted for the native overlay architecture. The authoring guide documents the hidden-collection private-API bridge and required upgrade checks.

### Still required before whole-web acceptance

Manual keyboard/screen-reader and visual checks in real browsers, especially native top-layer placement, viewport collision, nested dismissal, focus restoration, and both themes/narrow layouts. Permission mode and project action menus now use the shared native-anchored RAC adapter with dedicated parity tests. The model picker remains a specialized native-popover/search-focused composite: its base controls and label/help/status relationships have migrated, while its rich provider/auth flows and nested active-descendant behavior are intentionally preserved. The staged agent menu now uses that adapter too, with local-stage and keyboard parity tests. Skill-slash suggestions use its native-anchor surface with textarea-focused active-descendant semantics instead of pretending to be a Menu/combobox. Attachment/swipe controls and safe transcript actions have migrated; dedicated failure-popover triggers and data-shaped read-path/agent-note controls remain intentional native boundaries pending their own parity-led audit.
