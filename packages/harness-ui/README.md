# `@inhuman.tools/harness-ui`

White-label primitives, contextual axis scopes, localized voice catalogs, visual blocks, Lego shell compositions, and Safari `18.7+` positioning helpers for Inhuman Harness.

```sh
pnpm add @inhuman.tools/harness-ui react react-dom
```

Browser baseline: `Safari >= 18.7`, `iOS Safari >= 18.7`, last 2 Chrome, and last 2 Firefox (zero CSS Anchor Positioning).

## Stylesheets

Import the layered bundle once from your application stylesheet or entry point:

```css
@import "@inhuman.tools/harness-ui/styles.css";
```

Individual CSS layers are also exported for custom host pipelines:
`@inhuman.tools/harness-ui/styles/tokens.css`, `axes.css`, `primitives.css`, `blocks.css`, and `compositions.css`.

## Exports

- `@inhuman.tools/harness-ui`: Unified barrel re-exporting all layers below plus `cn`.
- `./primitives` (`./primitives/*`): Accessible UI primitives (`Button`, `Input`, `Textarea`, `Checkbox`, `RadioGroup`, `Switch`, `Tabs`, `TextField`, `DropdownSelect`, `Autocomplete`, `Menu`, `NativePopover`, `NativeDialog`, `Dialog`, `Tooltip`, `ControlGroup`).
- `./theme`: Axis context wrappers and boundaries (`SurfaceScope`, `ProminenceScope`, `EmphasisScope`, `DensityScope`, `Visibility`).
- `./voice`: Multilingual and white-label copy customization (`VoiceCatalog`, `enVoiceCatalog`, `defineVoiceCatalog`, `VoiceProvider`, `useVoice`).
- `./positioning`: Geometry-driven overlay placement (`useFloatingPosition`, `computeFloatingPosition`, `useLaneLayout`, `solveLaneSlots`).
- `./blocks` (`./blocks/*`): Domain presentation blocks (`ComposerBlock`, `StageComposerBlock`, `ModelPickerBlock`, `PermissionModeControl`, `ReasoningEffortControl`, `SessionRailBlock`, `ProjectTabsBlock`, `FilePreviewPane`, `MarkdownBlock`, `CodeBlock`, `TerminalBlock`, `ConnectStepBlock`, `PermissionsBodyBlock`, `SettingsNav`, `SettingsGroupBlock`, `Setting`).
- `./compositions` (`./compositions/*`): Full-viewport Lego shell slots (`WorkspaceShell`, `SessionSidebar`, `ConversationStage`, `WorkspaceBar`, `InspectorDrawer`, `SettingsModal`).

## White-Label Lego Composition

Override CSS custom properties (`--canvas`, `--wash`, `--raised`, `--ink`, `--muted`, `--line`, `--accent`, `--radius-*`, `--font-sans`, `--font-heading`, `--font-mono`, `--spacing`), select `"rail-left"` or `"header-top"` on `WorkspaceShell`, and provide a partial `defineVoiceCatalog(...)` to rebrand without forking internals:

```tsx
import {
  ComposerBlock,
  ConversationStage,
  DensityScope,
  InspectorDrawer,
  PermissionModeControl,
  ProjectTabsBlock,
  SessionRailBlock,
  SessionSidebar,
  VoiceProvider,
  WorkspaceBar,
  WorkspaceShell,
  defineVoiceCatalog,
} from "@inhuman.tools/harness-ui";

const brandVoice = defineVoiceCatalog({
  composer: { promptLabel: "Workstream instruction", sendLabel: "Dispatch" },
  workspace: { sessionsLabel: "Workstreams" },
});

export function BrandedApp() {
  return (
    <VoiceProvider catalog={brandVoice}>
      <DensityScope density="compact">
        <WorkspaceShell
          layout="header-top"
          style={{ ["--font-heading" as string]: "Georgia, serif" }}
          sidebar={
            <SessionSidebar open brand="Acme Studio">
              <SessionRailBlock mode="project" items={[]} onNavigate={() => undefined} />
            </SessionSidebar>
          }
          stage={
            <ConversationStage
              composer={
                <ComposerBlock
                  notice=""
                  fieldRef={{ current: null }}
                  pillRef={{ current: null }}
                  dropEnabled={false}
                  onDropFiles={() => undefined}
                  pictures={[]}
                  picturesDisabled
                  onRemovePicture={() => undefined}
                  onPickPictures={() => undefined}
                  slashMenu={null}
                  draft=""
                  onDraftChange={() => undefined}
                  onDraftKeyDown={() => undefined}
                  onDraftPaste={() => undefined}
                  showSend={false}
                  canSend={false}
                  onSend={() => undefined}
                  footer={<PermissionModeControl mode="auto" onModeChange={() => undefined} />}
                />
              }
            />
          }
          workspaceBar={<WorkspaceBar><ProjectTabsBlock activeKey="main" tabs={[]} /></WorkspaceBar>}
          inspector={<InspectorDrawer title="Details" />}
        />
      </DensityScope>
    </VoiceProvider>
  );
}
```

## Primitives & Layer Contracts

- **Native vs. compound event contracts:** `Button`, `Input`, `Textarea`, and `NativeSelect` preserve native DOM props/events/refs (`Button` also accepts `onPress`, and its `content` variant preserves natural-case text). `FieldButton`, `FieldInput`, and `FieldTextArea` participate in React Aria compound field contexts (`SearchField`, `NumberField`, `CheckboxField`/`CheckboxButton`, `RadioField`/`RadioButton`, `SwitchField`/`SwitchButton`).
- **Floating overlays (`NativePopover`):** Renders `<div popover="manual" | "auto">` positioned via `useFloatingPosition` instead of CSS Anchor Positioning. Its hidden-collection pre-render relies on `react-aria/private/collections/Hidden`; verify anchored, menu, collection, date-picker, and browser dismissal checks when upgrading `react-aria`.
- **Modals:** `NativeDialog` adds React Aria semantics onto a caller-owned `<dialog>` (`showModal`/`close`). `Dialog` owns the `<dialog>` lifecycle; `DialogContent` provides interior ARIA dialog semantics only. Never nest two modal lifecycle owners.
- **Composer slots:** Pass optional model/effort selectors via `lane` (placed in the narrow left track on desktop) and `<PermissionModeControl />` via `footer` (aligned beneath the prompt column).

## Normative Brand & Design Guides

- [`docs/brand/brand-core.md`](../../docs/brand/brand-core.md)
- [`docs/brand/text-brandbook.md`](../../docs/brand/text-brandbook.md)
- [`docs/brand/design-direction.md`](../../docs/brand/design-direction.md)
- [`docs/brand/design-system.md`](../../docs/brand/design-system.md)

MIT
