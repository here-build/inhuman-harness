# Design System Architecture

`@inhuman.tools/harness-ui` adapts patterns from the Mercury component system and selected architectural ideas from Delta into a lean, CPU-light CSS + React architecture compatible with Safari `>= 18.7`.

## 1. CSS Cascade Layers (`@layer`)

Every stylesheet loaded by `@inhuman.tools/harness-ui/styles.css` binds explicitly to an ordered cascade:

```css
@layer theme, base, tokens, axes, primitives, components, utilities, blocks, overrides;
```

- **`tokens`:** Root palette (`oklch` inside `light-dark()`), font stacks, white-label `--radius-*`, and `Nlh`/`Nch` rhythm tokens.
- **`axes`:** Orthogonal context scopes for `surface`, `prominence`, `emphasis`, and `density`.
- **`primitives`:** Base component rules scoped tightly via `@scope ([data-ui="..."]) to ([data-ui], [data-slot])`.
- **`components` / `blocks`:** App-level components and composable white-label blocks (`Super-Wave 2`).
- **`overrides`:** Reserved highest layer for white-label hosts to swap tokens or skin rules without `!important`.

## 2. Mercury Four-Tier Rule Structure

Inside `primitives.css` (and consumer component stylesheets), styles avoid selector specificity wars using `:where()` normalization:

1. **Tier 1 — Base Structure:** Shared layout, border, cursor, and default `Nlh`/`Nch` geometry written directly as standard CSS properties inside `@scope ([data-ui="..."]) to ([data-ui], [data-slot])`.
2. **Tier 2 — Variant Normalization (`:where([data-variant="..."])`):** Zero-specificity base adjustment for declared visual variants (`ghost`, `solid`, `outline`, `accent`, `content`, etc.).
3. **Tier 3 — Contextual Axes & Sizes:** Adjustments responding to ancestor axis variables (`--axis-pad-x`, `--axis-pad-y`, `--axis-gap`) or explicit `[data-size="sm" | "md" | "lg"]`.
4. **Tier 4 — Interactive States & Consumer Overrides:** `:hover`, `:focus-visible`, `[data-disabled]`, `[aria-selected="true"]`, plus host classes / `@layer overrides`.

### Direct CSS Properties Rule

Components write visual values directly (`padding`, `gap`, `background-color`, `border-radius`, `border`) rather than introducing single-use internal indirection variables like `--_pad` or `--_bg`. CSS custom properties are reserved strictly for eliminating cross-rule repetition, shared tokens (`--canvas`, `--radius-sm`, `--space-x-sm`), axis palettes, and runtime measurements (`--rt-*`).

## 3. Separate Donut `@scope`s for Contextual Axes

Instead of a monolithic variable namespace or runtime JS style solvers, each contextual axis owns an independent CSS `@scope` limited by its own boundary class so outer contexts cascade inward without polluting unrelated axes or crossing isolated islands:

| Axis | Wrapper / Attribute Values | Boundary Class | Scoped Palette / Variables |
| --- | --- | --- | --- |
| **Surface** | `SurfaceScope` (`data-surface="paper" \| "soft" \| "well" \| "raised" \| "field"`) | `.surface-boundary` | `--axis-surface`, `--axis-surface-ink`, `--axis-surface-muted`, `--axis-surface-rule` |
| **Prominence** | `ProminenceScope` (`data-prominence="ambient" \| "standard" \| "raised" \| "focal"`) | `.prominence-boundary` | `--axis-prominence-bg`, `--axis-prominence-border`, `--axis-prominence-shadow`, `--axis-prominence-ink` |
| **Emphasis** | `EmphasisScope` (`data-emphasis="quiet" \| "neutral" \| "accent" \| "danger" \| "warning" \| "success"`) | `.emphasis-boundary` | `--axis-emphasis-fg`, `--axis-emphasis-bg`, `--axis-emphasis-border` |
| **Density** | `DensityScope` (`data-density="compact" \| "cozy" \| "comfortable"`) | `.density-boundary` | `--axis-density-scale`, `--axis-pad-y`, `--axis-pad-x`, `--axis-gap`, `--axis-control-min-h` |

Each primitive that creates a standalone overlay or card (such as native popovers and modal dialogs) attaches `.surface-boundary`, `.prominence-boundary`, and `.emphasis-boundary` intentionally to reset inherited palette contexts at that boundary.

## 4. Shared Base Tree + Top-Level Variants

Components render one predictable structural DOM tree anchored on `[data-ui="<name>"]` and `[data-slot="<part>"]`, toggling presentation through top-level variant attributes (`data-variant`, `data-size`, `data-orientation`) rather than branching completely different element hierarchies. Related sibling controls (`Button`, `FieldButton`, `Input`) compose horizontally or vertically through `<ControlGroup>` (`[data-ui="control-group"]`), which collapses touching hairlines and shares outer `--radius-*` corners automatically.

## 5. Five-Mode `Visibility` (`<Activity>`)

`Visibility` standardizes rendering lifecycle across 5 explicit modes:

| Mode | Mounted | Effects / Subscriptions | Layout Space | Mechanism |
| --- | --- | --- | --- | --- |
| `"visible"` | Yes | Active | Yes | Normal React `<Activity mode="visible">` |
| `"hidden"` | Yes (state preserved) | Paused | No (`display: none` via React) | React `<Activity mode="hidden">` |
| `"display-none"` | Yes | Active | No | Wrapper `[data-visibility="display-none"]` |
| `"invisible"` | Yes | Active | Yes | Wrapper `[data-visibility="invisible"]` (`visibility: hidden`, `pointer-events: none`) |
| `"unmounted"` | No | None | No | Returns `null` |

## 6. Runtime Geometric Measurement & Safari `18.7+` Positioning

Dynamic geometry measured via `ResizeObserver` / DOM layout reads writes directly to `--rt-*` CSS custom properties without calling `setState`:

- **Floating overlays (`useFloatingPosition`):** Computes viewport-clamped `--rt-x`, `--rt-y`, `--rt-max-h`, `--rt-max-w`, `--rt-trigger-w`, and `--rt-origin` via `element.style.setProperty(...)` for native top-layer `<div popover="manual" | "auto">` overlays without leaving their owning `<dialog>` subtree and without any CSS Anchor Positioning rules.
- **Timeline margin lanes (`solveLaneSlots` / `useLaneLayout`):** Computes non-overlapping `top` offsets and clamped heights for marginalia notes aligned to beat rows inside an intrinsic CSS Grid container.

## 7. White-Label Visual Blocks (`@inhuman.tools/harness-ui/blocks`)

Higher-level domain visuals are shipped as pure, framework-agnostic presentation blocks (`packages/harness-ui/src/blocks/*`) that receive plain data models and callbacks without importing host MobX stores, router instances, RPC transports, or `syntax.wasm`:

- **Syntax & Content:** `MarkdownBlock` (`Markdown`), `CodeBlock` (`SyntaxHighlightProvider` + `resolveLang`), `ReadLine`, `TerminalBlock`, `InlineScript`.
- **Workspace & Navigation:** `SessionRailBlock`, `ProjectTabsBlock`, `FilePreviewPane` (`FilePreviewPanel`), `LinkNoticeBlock`, `SplashBlock`, `ConnectStepBlock`, `ProviderIcon`.
- **Composer & Controls:** `ComposerBlock` (`StageComposerBlock`), `ModelPickerBlock`, `PermissionModeControl`, `ReasoningEffortControl`, `SkillSlashMenuBlock`, `PictureChipsBlock`, `PictureDropSurface`, `SwipeRow`, `AckBlock`, `SessionStatusBlock`, `PermissionsBodyBlock`.
- **Settings Primitives:** `SettingsNav`, `SettingsSectionHeader`, `SettingsFactList`, `ReconnectDoorBlock`, `Setting`, `SettingsGroupBlock`, `TriggerRangeBlock`, `PercentSliderBlock`, `RegistrySearchBlock`.

Blocks resolve accessible labels and copy through `useVoice()`, and fall back to inline `enVoiceCatalog` English strings when no custom `<VoiceProvider>` is mounted.

## 8. Lego Layout Compositions (`@inhuman.tools/harness-ui/compositions`)

Full-viewport application layouts assemble without hardcoded chrome via semantic slot components in `packages/harness-ui/src/compositions/*`:

- **`WorkspaceShell`:** Root layout orchestrator supporting `layout="rail-left" | "header-top"`, `embed` mode, `picking` backdrop, `sidebar`, `stage`, `inspector`, `workspaceBar`, and `overlay` slots.
- **`SessionSidebar`:** Collapsible `<SurfaceScope as="aside" surface="soft">` navigation rail with `brand` and `headerAction` slots plus optional `density`.
- **`ConversationStage`:** `<SurfaceScope as="main" surface="paper">` scrolling transcript stage with native bottom overflow anchoring and a docked `composer` slot.
- **`WorkspaceBar`:** `<SurfaceScope surface="soft">` strip combining responsive `mobileNavToggle`, `leadingAction`, and `ProjectTabsBlock` children (docked below `.frame-body` in `rail-left`, or above it via `.frame[data-layout="header-top"] > .project-strip`).
- **`InspectorDrawer`:** Responsive `<SurfaceScope as="aside" surface="paper">` drawer (docked beside the stage on wide viewports, container-queried overlay under `89rem + 18rem`, fixed sheet on compact viewports).
- **`SettingsModal`:** Native `<dialog>` overlay pairing `SettingsNav`, `SettingsSectionHeader`, and scrollable panel content.

## 9. Token & Voice Customization Guide

Host applications and Storybook white-label skins customize appearance without cloning components by scoping CSS custom properties and providing a localized catalog:

1. **Theme Tokens & Typography:** Override `--canvas`, `--wash`, `--raised`, `--ink`, `--muted`, `--line`, `--edge`, `--hover`, `--selected`, `--selection-marker`, `--accent`, `--accent-ink`, `--focus`, `--radius-{xs,sm,md,lg}`, `--font-sans`, `--font-heading`, `--font-mono`, and `--spacing` on `:root`, an ancestor wrapper, or `<WorkspaceShell style={...}>`.
2. **Layout & Density:** Flip `<WorkspaceShell layout="header-top">` and wrap subtrees in `<DensityScope density="compact" | "cozy" | "comfortable">` or `<SurfaceScope>`.
3. **Multilingual Voice Catalogs:** Build a complete catalog with `defineVoiceCatalog(overrides, enVoiceCatalog)` and mount `<VoiceProvider catalog={catalog}>` around the shell or individual blocks.
