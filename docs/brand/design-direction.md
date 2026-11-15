# Design Direction

Inhuman Harness ships with the **Graphic Precision** visual direction: an architectural light/dark palette built from calibrated OKLCH planes, razor-sharp hairlines, tabular monospace instrumentation, and font-coupled proportions. Hosts adopting the UI package can retain Graphic Precision or override its design tokens cleanly.

## Visual Character

- **Paper & Ink Hierarchy:** Surfaces step cleanly in perceptual lightness (`--canvas`, `--wash`, `--raised`, `--field`) rather than relying on heavy drop shadows (overlay shadow `--overlay-shadow` is reserved for floating popovers and modal dialogs). Ink steps from primary (`--ink`) to secondary (`--muted`) and tertiary (`--subtle`), computed with OKLCH `light-dark(...)`. Interactive wash states use `--hover`, `--selected`, and `--selection-marker`.
- **Crisp Geometry by Default:** Radii default to sharp corners (`--radius-xs: 0px`, `--radius-sm: 0px`, `--radius-md: 0px`, `--radius-lg: 0px`, `--radius-pill: 9999px`) matching drafting tables and code editors. White-label hosts can soften the entire application by overriding those tokens in `@layer overrides` or `:root`.
- **Single-Pixel Line Work:** Controls use `1px solid` rules (`--line` for subtle dividers, `--edge` for control borders, `--focus` for `2px` focus rings) so borders stay sharp at `1x` and Retina densities without blurry semi-transparent glows.

## Typography

- **Prose / Controls (`--font-sans`):** `Source Sans 3` (`--font-sans`) carries UI controls, natural-case labels, body prose, numbers/dates (`tabular-nums`), and petite-cap `.label` commands.
- **Headings (`--font-heading`):** `Nunito Sans` (`--font-heading`) carries page titles and section headings with `--font-weight-strong` (`620`).
- **Instrumentation (`--font-mono`):** `Monaspace Krypton` (`--font-mono`) with tabular figures preserves IDs, paths, commands, shortcuts, and ANSI/terminal output.
- **Starting Scale:** Page `28/34` (`text-2xl`), Section `20/26` (`text-xl`), Body `16/24` (`text-base`), Compact `14/20` (`text-sm`), Supporting `13/18` (`text-xs`).

## Intrinsic Metric Sizing (`Nlh` & `Nch`)

Rather than scattering brittle `px` or `rem` heights across inputs, chips, and containers, dimensions track the active font metrics:

- **Vertical heights & rhythm use `lh`:** Standard single-line controls target line-coupled heights and gaps (`--space-y-xs: 0.15lh`, `--space-y-sm: 0.28lh`, `--space-y-md: 0.55lh`, `--space-y-lg: 0.9lh`, `--control-min-h: 1.75lh`), so scaling font size or density automatically re-proportions controls.
- **Horizontal measure & padding use `ch`:** Horizontal control padding, menu widths, inline gaps, and readable column measures use `ch` (`--space-x-xs: 0.6ch`, `--space-x-sm: 1.1ch`, `--space-x-md: 1.75ch`, `--space-x-lg: 2.5ch`, `--measure-prose: 64ch`).
- **Explicit `px` exceptions:** Hairline border widths (`1px`), focus outline offsets (`1px`–`2px`), and computed viewport popover coordinates (`--rt-x`, `--rt-y`, `--rt-trigger-w`, `--rt-max-h`, `--rt-max-w`).

## Color & Contrast Commitments

- Every foreground/background pair declared on `:root` uses OKLCH inside `light-dark(...)` and must satisfy automated WCAG AA contrast checks in both light and dark modes (`contrast.test.ts`).
- Primary action surfaces pair `--accent` with `--accent-ink` in both light and dark schemes; disabled controls move to neutral non-accent surfaces (`--wash` / `--subtle` / `--line`).
- Semantic state and diff tokens (`--danger`, `--warning`, `--success`, `--working`, `--added-line`, `--removed-line`) retain restrained saturation so copy and indicators remain readable.
- Terminal output containers (`.shell-term` in `surfaces/web/src/styles.css`) define `--vt-0` through `--vt-15` across both light and dark modes using `light-dark(...)`.

## Overlays, Motion & Browser Baseline

- **Target Baseline:** **Safari >= 18.7**, iOS Safari >= 18.7, Chrome (last 2), Firefox (last 2).
- **Zero CSS Anchor Positioning:** CSS `anchor-name`, `position-anchor`, `position-area`, `anchor()`, `anchor-size()`, `anchor-scope`, `position-try*`, and `@position-try` are prohibited because Safari `< 26.5` does not support them.
- **Overlay Strategy:** Floating menus, selects, submenus, and tooltips render inside native HTML top-layer popovers (`popover="manual"` with outside-`pointerdown` + `Escape` dismissal, or explicit `popover="auto"`) positioned deterministically in fixed viewport coordinates (`--rt-x`, `--rt-y`, `--rt-trigger-w`, `--rt-max-h`, `--rt-max-w`, `--rt-origin`) via `useFloatingPosition`, keeping overlays inside their owning DOM tree (e.g., modal `<dialog>` inertness stays intact).
- **Motion:** `--ease-out` (`cubic-bezier(0.23, 1, 0.32, 1)`) at `--default-transition-duration: 150ms` for interactive feedback on colors, borders, transforms, and opacity.
