# Text Brandbook & Tone of Voice

All copy inside `@inhuman.tools/harness-ui` and the default web surface is authored in concise, operator-grade English and externalized into a typed `VoiceCatalog` so hosts can customize terminology or swap languages without modifying components.

## Voice Principles

1. **Direct and operational**
   Lead with the action or state. Prefer `"Close dialog"` over `"Click here to close this dialog"`, and `"Dismiss"` or `"Cancel"` over conversational phrasing.

2. **Zero exclamation or filler**
   Never use exclamation marks, apologies, emojis, or anthropomorphized chatter in system chrome (`"Something went wrong!"` -> `"Request failed"`).

3. **Explicit object naming**
   Labels in overlays, disclosures, and icon-only controls describe both the action and target when context alone would be ambiguous (`"More options"`, `"Previous page"`, `"Calendar"`, `"Resize handle"`).

4. **Reversible clarity in destructive actions**
   Describe concrete consequences calmly without dramatic adjectives.

## Copy Standards by UI Role

| Role | Rule | Examples |
| --- | --- | --- |
| **Triggers & Navigation** | Petite caps (`.label`), imperative verb or concise navigation noun | `"Close"`, `"Options"`, `"Today"`, `"Overview"` |
| **Names, Fields & Prose** | Natural sentence case in `--font-sans` (`Source Sans 3`); never force petite caps on field labels, dates, or names | `"Autumn campaign"`, `"Review date"`, `"Changes saved"` |
| **Empty & Fallback** | State the absence neutrally in a fragment or short clause | `"No matches"`, `"Empty"`, `"Unavailable"` |
| **Status & Telemetry** | Calm 4-state language paired with literal token meaning | `"Pending"`, `"Running"`, `"Attention"`, `"Ready"`, `"Failed"` |
| **Literal Technical Values** | Preserved verbatim in `--font-mono` (`Monaspace Krypton`) | `"PRJ-0284"`, `"projects-2026-10-31.csv"`, `"⌘K"` |
| **Screen-Reader Labels** | Required on icon-only buttons, split handles, and date/select grids | `"Previous month"`, `"Next month"`, `"Close"` |

## Multilingual & White-Label `VoiceCatalog`

Hardcoded strings are prohibited inside reusable UI primitives. Instead, components read defaults from `useVoice()` backed by `VoiceProvider`:

- **Default catalog:** `enVoiceCatalog` shipped by `@inhuman.tools/harness-ui/voice`.
- **Creating a custom or translated catalog:** Use `defineVoiceCatalog(partialOverrides)` to merge host or locale overrides onto `enVoiceCatalog` while preserving exhaustive type safety for every string key.
- **Overriding locally:** Wrap any subtree (or the root app) in `<VoiceProvider catalog={myCatalog}>`. Explicit component props (such as `aria-label` or `placeholder` passed by a caller) always take precedence over catalog defaults.

## Extending the Catalog

When adding a new primitive or block requiring UI copy:

1. Add a semantic, component-grouped key to `VoiceCatalog` (never format/position-specific keys like `blueButtonText`).
2. Provide the canonical English phrase in `enVoiceCatalog`.
3. Read it inside the primitive via `const voice = useVoice()` and allow caller prop override (`props["aria-label"] ?? voice.dialog.closeLabel`).
