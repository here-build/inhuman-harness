# Graphic Precision — web rebuild

## Implementation status — 2026-10-31

- **Delivered:** the complete normative guide, live Graphic Precision system/component stories, and historical notices on the old Brandbook pages.
- **Delivered foundations:** shared font roles and starting scale; zero-radius tokens; neutral opaque surfaces; lime primary actions; distinct contrast-tested selection and focus tokens in both themes. Removed repeated connection-marker pulsing and scanning placeholders.
- **Delivered controls:** React Aria Button interaction adapter, focus-aware native Input/Textarea, composed TextField, Checkbox, RadioGroup, Switch, and Tabs. Floating positioning stays on native Popover API and CSS anchors.
- **Integrated product surfaces:** shared controls in settings, permissions, project setup, MCP search, and safe composer actions. Plugin/settings checkboxes now use React Aria; the project-directory dialog uses the composed TextField. Native selects, modal lifecycle, and floating triggers remain intentional boundaries.
- **Regression coverage:** button press/click, caller keyboard cancellation, event bubbling, modifier keys, disabled/pending, form submission, refs/native events; labeled fields/help/errors; selection-control and tab keyboard behavior; semantic-token contrast. At that historical checkpoint, the web suite passed **705 tests across 64 files**, including story mount/play checks. Type checking passes.
- **Not claimed complete:** a full visual audit of every journey, manual screen-reader verification, real-browser anchor placement/focus-return checks, and the remaining per-surface cleanup. Unit/story tests do not replace these gates. No full-web redesign acceptance is implied by shared-token migration.

## Expanded catalog and screen migration — 2026-10-31

The second implementation pass adds the full form/quantity/color, collection/table/tree/tag, date/time, navigation/disclosure, feedback/file, token/navigation-tree/virtualization families. Native anchored Select/ComboBox/Menu/Tooltip, native dialogs, and composed date/range picker adapters sit alongside the lower-level RAC roots. A public barrel and authoring guide distinguish native-compatible controls from RAC-context parts. See [component coverage](graphic-precision-component-coverage.md) for precise boundaries, including specialized upstream APIs not adopted as a second overlay system.

Product integration now includes composed fields throughout settings/connection/permissions, shared native selects, provider/session searches with persistent labels, selected-row markers, provider tiles, and file preview loading/retry recovery. This extends—not replaces—the manual acceptance gates below.

## Working menus and composer — 2026-10-31

- Permission mode now uses the shared React Aria Menu/MenuItem/NativePopover adapter. Single selection, staged local choice, session versus kernel RPC routing, keyboard activation, dismissal and focus restoration remain covered. Native anchors still own placement.
- Project actions now use that same anchored menu. Copy preserves the delayed quiet confirmation, guards stale async completion after dismissal/reopening, and offers a local accessible error with the literal path on clipboard failure. New session closes the menu and invokes its existing action. Native project links and modifier-click behavior are unchanged.
- The model picker deliberately remains a specialized search-focused composite with native nested popovers. Shared Button/Input and persistent search/help/status relationships were adopted without replacing its offer subscriptions, authentication/connect flow, hover timing, active-descendant navigation, or reconnect behavior with a generic Menu. This boundary is intentional, not a claim of a full generic-picker rewrite.
- Composer/staged composer/acknowledgement use shared controls for send, stop, agent actions and remember selection; local help/status relationships stay with the draft. Existing IME, skills, attachment and RPC logic remain intact.
- Fixed the CSS cascade that hid individual keyboard focus inside the draft boundary; technical keyboard shortcuts use Monaspace. Agent object names explicitly retain natural-case typography despite shared Button petite-cap styling. Diff shadow DOM now uses the system Monaspace role instead of the removed JetBrains family, with a real shadow-DOM regression.
- Existing permission tests now open the menu and inspect accessible menu items instead of clicking hidden legacy DOM rows. Added focused model/composer/project/permission regressions and a CSS working-surface contract.

Historical verification for this pass: **917 tests pass across 83 files**; TypeScript, production build and Storybook build pass; ESLint reports **0 errors / 55 warnings** in the current working tree. Concurrent unrelated edits are included in the total suite. Real-browser layout, viewport collision, screen-reader and touch verification remain open; passing happy-dom tests does not certify native top-layer placement. The staged agent menu and skill slash menu still retain their dedicated native mechanisms and need a separate parity-led accessibility pass.

## Agents, slash suggestions, attachments and transcript actions — 2026-10-31

- The staged agent selector now uses shared RAC MenuTrigger/Menu/MenuItem plus NativePopover. Configured and removed-agent fallback names remain natural-case content; Default is a command symbol. Selection is local until send, retains other staged options, works without a live RPC port, closes on selection/Escape and returns focus. Native anchors remain above the trigger.
- Skill suggestions reuse NativePopover anchored to the drafting textarea, rather than a clipped inline panel. The native multiline textbox retains DOM focus, caret, active-descendant references, IME and existing Enter/Tab/Escape behavior. Options are non-tabbable, named/described, use exact mono invocation values, full accessible descriptions, muted selection and an explicit neutral marker. Light dismissal is synchronized with key-guarded hook state; stale catalog/scope handlers cannot insert a skill. Layout prefers above the field with viewport fallbacks; real browser geometry still needs acceptance.
- Attachment preview/remove and swipe actions use shared controls; pick/drop states follow their existing drafting/submission boundaries. Native image dialogs, paste/drop batching, drag capture and vertical-scroll behavior are retained. Fixed keyboard focus loss when a swipe action closes: focus returns to the surviving switch, waits on its row while disabled, and is not stolen back if the person moved elsewhere.
- Transcript Edit and picture-open actions use the shared Button. Edit still delegates to the existing draft owner (there is no invented inline editor); native hover/focus-owned failure popovers, domain-shaped read-path controls and streaming progress logic remain untouched. Concurrent plugin/session-beat work is preserved.
- Added Graphic Precision / Working editor stories using the actual application for agent choice, visible skill suggestions, and completion without sending. Their staged fixtures reset between stories. Added dedicated agent, skill, attachment/swipe and transcript regressions; updated legacy integration tests to open menus through their public semantics.

Historical verification: **958 tests across 87 files pass**, including the complete catalog of **152 story mount/play cases plus its inventory check**. TypeScript, production and Storybook builds pass. ESLint exits successfully with **0 errors / 53 warnings** in the current working tree. Vite still warns about large chunks; no bundle-size optimization is claimed. Manual browser layout, screen-reader and touch checks remain open.

## Authority and scope

[Graphic Precision](graphic-precision.md) is the normative visual and verbal specification. This rebuild concerns `packages/harness-web-app` and the transcript rendered inside it, not the TUI. The Storybook **Graphic Precision** section renders the source guideline document directly and demonstrates meaning, typography, and feedback. Older Brandbook journeys remain useful feature inventories; old stylistic decisions are not competing authority.

The goal is a clean, maintainable working application, not a second skin confined to Storybook. Preserve drafts, literal values, routing, connection behavior, permission semantics, and recovery paths throughout migration. Preserve unrelated changes already in the working tree.

## Ordered delivery

### 1. Document and establish foundations

- Save all twelve guideline sections, including product voice and quality criteria.
- Present the specification in Storybook from the same document, avoiding duplicate normative copy.
- Establish semantic tokens shared by Storybook and the application: fonts, scale, spacing, zero-radius geometry, opaque surfaces, brand accent, selection, focus, and feedback.
- Use Nunito Sans for structure, Source Sans 3 for content and petite-cap textual symbols, and Monaspace Krypton for literal technical values.
- Keep both themes and existing `data-scheme` / syntax-highlight synchronization.
- Validate Cyrillic, long names, tabular quantities, and reduced motion. Inspect actual font feature support; do not simulate petite caps by uppercasing stored strings.

Gate: guide and living examples are available; token readers still work; contrast tests cover both themes, including primary action text and focus.

### 2. Rebuild the component library

- Build reusable interaction behavior on React Aria, retaining compatible native props where existing consumers require them.
- Start with Button, Input, Textarea and composed labeled fields; then selection controls and tabs. Expose semantic labels, descriptions, validation, disabled, pending, focus, and selection states.
- Field labels and object names are content, not petite-cap command symbols.
- A field wrapper must connect label, help, and error text to the input. A placeholder never replaces a persistent label.
- Preserve form submission, native event contracts, refs, and keyboard shortcuts while migrating consumers.
- Demonstrate states in live stories; test keyboard, naming, disabled behavior, validation, and state updates.

**Floating exception:** menus, tooltips, floating panels, and their positioning remain native Popover API + CSS Anchor Positioning. Do not replace them with React Aria Popover positioning, Floating UI, or an additional placement engine. Preserve DOM nesting, dismissal, focus return, viewport flipping, and anchor ownership. React Aria may supply control semantics without owning placement.

Existing anchor owners include project menus, permission/agent menus, model picker/provider submenus, and transcript failure details. Native dialogs retain their modal lifecycle; adopting shared buttons must not break `method="dialog"`.

Gate: component tests and existing consumer stories pass; no alternative floating-positioning dependency or engine is introduced.

### 3. Rebuild application surfaces, by journey

Migrate actual consumers; remove duplicated control styling only when the shared component has equivalent behavior. Do not bulk-replace all `<button>` elements: popover triggers, composite widgets, sortable headers, and literal-value controls require role-specific review.

| Surface | Main checks |
|---|---|
| Workspace and project navigation | active context marker, names natural case, keyboard focus, narrow layout |
| Settings and connections | persistent labels, validation near correction, literal account values, native modal close, loading and failure |
| Permissions and confirmations | consequences before action, precise action labels, unchanged authorization behavior |
| Composer and model selection | draft preservation, IME, send/cancel feedback, exact model IDs, anchors unchanged |
| Session list and transcript | content-led hierarchy, readable prose and code, separate selection/focus/status, scroll position |
| File preview, diffs, workflow | exact paths and code, number alignment, stable data categories, keyboard navigation |
| Empty, offline, partial, and failure states | explanation, truthful progress, durable work-threatening errors, explicit recovery |

Gate per journey: real fixture stories, both themes, keyboard-only use, narrow and wide viewports, Cyrillic and long names, motion disabled, and loss/recovery paths. A global token change alone does not complete this gate.

### 4. Consolidate and audit

- Remove obsolete parallel primitives, unused font imports/dependencies, and superseded design instructions after consumer migration.
- Audit semantic HTML and accessible names, labels, descriptions, focus order/return, contrast, touch targets, and forced colors.
- Inspect real browser Popover/Anchor behavior: unit DOM environments do not implement placement or top-layer behavior.
- Check supported-browser compatibility explicitly; do not silently assume Anchor Positioning support from a broad browser target.
- Check sustained-use density, unnecessary borders, notification persistence, and recurring animation.
- Run package typecheck, lint, tests, production build, and Storybook build. Record baseline failures separately from regressions.

## Completion criteria

The rebuild is complete only when all application journeys have passed the gates above, not when the new fonts or Storybook pages land. Remaining migration or manual validation must be named explicitly in the delivery report. Do not claim visual/browser/accessibility verification on the basis of unit tests or a successful static build.

Use the twelve quality criteria in the normative guide as the final review checklist. In particular: commands, values, and explanations are distinguishable; selection and focus differ; both themes share a character; color and motion are never the only carriers of meaning; people retain control of their work.

## Shared conversation grid and remaining controls — 2026-10-31

The conversation and composer now use one five-track definition: flexible status lane, `--gutter-width`, `--body-width`, identical gutter, flexible status lane. Message surfaces and changed diff rows include both gutters; text, diff code, draft labels and help share the body edge. Send occupies the right gutter. Narrow containers collapse status lanes and move configuration below the draft while retaining the same text alignment.

Visible application controls now use the styled React Aria toolbelt, including transcript and terminal disclosures, content actions, workflow controls, settings and acknowledgement selects, project/session links, and native-dialog semantics. Native Popover API/CSS anchors still own floating placement; the specialized model picker and slash suggestions retain their domain interaction logic. Native dialog lifecycle and the hidden file input remain browser plumbing. The compatibility `NativeSelect` export has no application consumers.

Real-browser verification covered light/dark desktop conversation layouts, a 390 px narrow layout without page overflow, diff backgrounds spanning equal gutters, and permission-menu native anchor placement. This caught and removed a popover-local `anchor-scope: all` that excluded the trigger anchor and misplaced menus at the viewport origin. Disclosure regressions cover streaming expansion, keyboard pinning, browser-find `beforematch` expansion, and responsive reasoning visibility. Comprehensive screen-reader, touch and cross-browser acceptance remain separate from these checks.

Historical validation for this pass: full web suite **975 tests / 89 files passed**, transcript package **17 tests / 4 files passed**, TypeScript passed, production and Storybook builds passed. The added anchor-scope contract also passes its **14-test** library suite. ESLint reports **0 errors / 55 warnings** at the final full lint checkpoint; the mechanical design scan reports no findings. Existing large-bundle warnings remain. Escape dismissal and focus restoration were verified in the browser.


## Subsequent test and browser audit

The counts above are historical checkpoints from the implementation passes, not current suite totals. Test normalization subsequently separated logic, subprocess smoke, and visual approval lanes; current commands and their boundaries are documented in [Test lanes](testing.md). The former UI export inventory and CSS source-grep contracts were replaced by consumer behavior checks and actual Chromium computed appearance/focus approvals.

The follow-up audit checks light/dark desktop and exact narrow viewports in Chromium. Shared `NativePopover` controls now degrade to a viewport-contained fixed panel when CSS anchors are unavailable; their existing local dismissal also works without Popover API. Capability emulation in Chromium verifies fallback geometry, selection and focus behavior; it is not an actual Safari test or a touch/screen-reader certification.

The specialized model picker and transcript failure hints still use their pre-existing direct native popover/anchor mechanisms. The package's iOS 16.4 Browserslist entry is a compilation target, not evidence that those complete application journeys work in that browser. Full older-browser, screen-reader and physical-touch acceptance remains open; the shared adapter fallback does not certify those separate native surfaces.
