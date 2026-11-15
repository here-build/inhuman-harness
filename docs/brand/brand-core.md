# Brand Core

Inhuman Harness is built as an instrument for autonomous coding sessions rather than a consumer dashboard. The public UI system, `@inhuman.tools/harness-ui`, packages that instrument into a composable, white-label layer so host applications can assemble bespoke interfaces from blocks and primitives while overriding typography, color palettes, border radii, spacing rhythms, and product vocabulary cleanly.

## Positioning & Audience

- **Primary users:** Engineers orchestrating coding agents, reviewing diffs, managing sessions, and auditing tool execution.
- **Secondary adopters:** Product teams embedding harness capabilities into their own hosts, IDEs, portals, or branded enterprise workspaces.
- **Design stance:** Calm, high-density precision. Chrome recedes so user code, diffs, reasoning traces, and decisions hold the stage.

## Brand Pillars

1. **Precision over ornament**
   Every border, alignment guide, and typographic step marks structural hierarchy. Decoration is never used to simulate depth or warmth when a clear plane or hairline communicates faster.

2. **Composability before prescription**
   Components expose a single shared base tree and declarative variants rather than opinionated single-purpose wrappers. Hosts compose blocks like interlocking modules and customize visual tokens without forking component logic.

3. **Contextual awareness**
   Surfaces, prominence, emphasis, and density adapt orthogonally across nested regions (`surface`, `prominence`, `emphasis`, `density`) through isolated CSS scopes, so a compact toolbar inside an elevated inspector stays coherent automatically.

4. **Honest runtime behavior**
   Controls communicate live state directly and deterministically—using semantic ARIA roles, native top-layer popovers, predictable focus handling, and fallback copy managed outside component logic.

## White-Label Relationship

| Layer | Responsibility | Default Identity ("Graphic Precision") | Host Override Mechanism |
| --- | --- | --- | --- |
| **Voice** | UI copy, accessibility labels, action verbs | Crisp English operator vocabulary | `<VoiceProvider catalog={...}>` |
| **Tokens** | Color planes, ink hierarchy, radii, fonts, metric rhythm | OKLCH neutral paper/ink, `0px` radii, sans + mono | `@layer overrides` or `:root` CSS custom properties |
| **Axes** | Contextual palettes (`surface`, `prominence`, `emphasis`, `density`) | Independent donut `@scope` boundaries | Scoped wrappers or custom axis classes |
| **Primitives** | Accessible interactive controls with shared base trees | `@inhuman.tools/harness-ui/primitives` | Styling overrides via CSS layers or variant props |
| **Blocks** | Domain assemblies (`Super-Wave 2`) | Composable session, composer, and timeline blocks | Direct composition in host shells |

## Rejected on Purpose

- **Persona theatrics:** Avatars, mascots, typing bubbles, or chat containers that stage the model as a conversational persona.
- **Sci-fi or alien ornament:** Decorative glyphs, neon glows, or theme tropes illustrating the word "inhuman".
- **Imposed structure:** Canned rigid step templates that hide what the runtime actually executed.
- **Decorative visual noise:** Purple accents, unsolicited dark panels inside light themes, display serifs, italic Source Sans, or frosted glass cards (backdrop blur is reserved for floating margin lane notes passing over scrolling text).
