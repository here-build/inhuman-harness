# Graphic Precision

A design and tone-of-voice system for SaaS products used for sustained, everyday work.

This document is the normative design brief for the web application. Implementation order and acceptance gates: [web rebuild](graphic-precision-web-rebuild.md). The Storybook `Graphic Precision` section presents this specification alongside working examples. Product-specific examples must follow this guide, not redefine it.

## 1. Product character

The product feels precise, composed, and responsive. It helps people navigate complex information, act confidently, and understand consequences.

Typography, geometry, rhythm, and labeling create its visual identity. Bright color marks significance. Motion explains change. Copy provides enough information to make a decision.

Four qualities guide the system:

- **Precision:** every element, word, and state has a clear purpose.
- **Coherence:** related things belong together; recurring interactions behave consistently.
- **Energy:** expressive accents appear where action and change matter.
- **Respect:** the product protects attention, preserves work, and keeps people in control.

## 2. Meaning determines appearance

Identify an element’s role before choosing its treatment.

| Role | What the person does | Expression |
|---|---|---|
| Content | Reads, understands, compares | Source Sans 3, natural sentence case |
| Structure | Navigates the information hierarchy | Nunito Sans, size and spacing |
| Textual symbol | Recognizes a command, mode, or category | Source Sans 3, petite caps |
| Technical value | Checks, copies, or enters something literally | Monaspace Krypton |
| Interaction | Triggers an action or changes a value | Familiar affordance, clear state |
| Surface | Perceives grouping and depth | Restrained background and necessary boundaries |

Visual prominence follows the task. A document may lead in an editor, data in an analytical view, and the affected field during error recovery.

## 3. Typography

**Nunito Sans: structure and hierarchy.**

Use for page titles, section headings, and structural headings in panels and dialogs.

Prefer moderate weights at larger sizes. Establish hierarchy through size, spacing, and placement, then adjust weight optically for the actual font size and theme.

Structural headings retain natural case unless they serve as textual symbols.

**Source Sans 3: content and the interface vocabulary.**

Use for object names, field labels and values, descriptions, messages, help, user content, and table content.

Use its petite caps for commands, navigation labels, modes, statuses, and other textual symbols.

The same family connects readable content with recognizable interface signs. Its two typographic treatments distinguish their roles.

**Monaspace Krypton: literal precision.**

Use for code, commands, paths, identifiers, versions, technical logs, and keyboard shortcuts.

Preserve literal values exactly. Case, punctuation, and spacing may be part of the data.

Ordinary amounts, percentages, and dates remain in Source Sans 3. Enable tabular figures where alignment supports comparison.

Starting scale:

| Role | Size / line height |
|---|---|
| Page title | 28 / 34 px |
| Section heading | 20 / 26 px |
| Body text | 16 / 24 px |
| Compact interface and tables | 14 / 20 px |
| Textual symbol | 14–16 / 20 px, optically adjusted |
| Supporting information | 13 / 18 px |

These values are starting points. Validate them with real content, including Cyrillic and long names.

## 4. Petite caps: text as a symbol

The central rule:

**If it could be an icon, set it in petite caps.**

Petite caps identify short, stable units of the interface vocabulary. People recognize them as whole signs while scanning.

| Element | Treatment |
|---|---|
| Search, Filter, Export as commands | Source Sans 3, petite caps |
| Overview, History, Settings in navigation | Source Sans 3, petite caps |
| Draft, Published as statuses | Source Sans 3, petite caps |
| Create project on a button | Source Sans 3, petite caps |
| “Autumn campaign launch” as a project name | Source Sans 3, natural case |
| “Changes saved” as a message | Source Sans 3, natural case |
| “Delete project?” as a dialog heading | Nunito Sans, natural case |
| `PRJ-0284`, `production`, `⌘K` | Monaspace Krypton, literal value |

Role matters more than length. A short document title remains content. A long command needs clearer wording or a more suitable presentation.

Petite caps do not imply lower importance. Give them sufficient size, weight, and contrast.

Store ordinary text in the underlying content. Apply petite-cap styling through typography.

## 5. Geometry and space

The default geometry is rectangular.

Buttons, inputs, panels, menus, dialogs, and containers use zero corner radius. Circles remain where they help identify function: radio buttons, status dots, and circular charts.

Build grouping in this order:

1. Proximity between related elements.
2. Alignment.
3. Space between groups.
4. Surface differentiation.
5. A border where the preceding methods are insufficient.

A border marks a meaningful boundary: an input, an editing region, or a temporary panel. Sections do not automatically require enclosing boxes.

The base spacing unit is 4 px. Core intervals are 8, 12, 16, 24, 32, and 48 px.

Density follows the task. Tables can be compact; extended explanations need more breathing room. Density preferences must preserve readability and functionality.

## 6. Color and surfaces

The system uses neutral, opaque surfaces, clear boundaries, and a small set of expressive colors.

The dark theme combines graphite backgrounds with soft, light text. The light theme preserves the same structure and character. Temporary panels separate from the workspace through lightness, borders, and shadows where useful.

The signature lime accent marks the primary action and small indicators of active context. Large working surfaces remain neutral.

Keep color roles distinct:

| Role | Application |
|---|---|
| Brand accent | Primary command, active section |
| Selection | Muted surface with an explicit marker |
| Focus | Clearly visible outline around the current element |
| Success | Confirmed outcome |
| Warning | A consequence requiring attention |
| Error | A problem preventing an action |
| Data category | A stable association supported by a legend or label |

Communicate status through words or shape as well as color. Preserve color meanings throughout the product.

Decorative textures may appear on occasional surfaces. Reading, input, and data comparison take place on clean backgrounds.

## 7. Components and working states

**Buttons.** Use a short command with a clear outcome. Emphasize the primary action within the current task. Add an icon when it improves recognition.

**Inputs.** Provide a persistent label, a clear current value, and relevant constraints. Place errors near the correction point and preserve entered data.

**Tables.** Align content to support comparison. Left-align names; align numeric quantities consistently by magnitude. Headers and row identifiers may remain fixed. Selection, hover, and keyboard focus must be distinguishable.

**Dialogs.** Name the decision. Explain its consequences. Label buttons with actions: “Delete project,” “Save draft,” or “Continue editing.”

**Empty states.** Explain why content is absent and identify the next step. These moments allow a more expressive brand treatment.

**Notifications.** Match prominence to consequence. Routine saves receive a quiet local status. Problems that threaten ongoing work remain visible until resolved.

## 8. Behavior and motion

Every action receives immediate feedback. Longer operations communicate what is happening, what has completed, and whether cancellation is available.

Motion connects cause and effect:

- A menu appears near its trigger.
- A panel opens from a consistent direction.
- Data updates preserve position and selection.
- Deletion offers recovery where possible.

Frequent operations stay fast. Recurring row appearances, saves, and view changes avoid elaborate animation.

Glitches, flickering, decorative scanning, and continuous pulsing stay outside the working area. All components respect reduced-motion preferences.

## 9. Product voice

The product speaks calmly, directly, and specifically. It is confident about known facts and transparent about uncertainty.

The basic message structure is:

**What happened. What it means for the work. What can happen next.**

Use only the parts the situation requires. A successful save needs two words. An error may need several sentences.

Voice principles:

- Name the object and action precisely.
- Use familiar language.
- Explain consequences before confirmation.
- Preserve the accuracy of numbers, timing, and states.
- Provide a path to recovery.
- Address the person directly when it helps.
- Remain respectful in every error state.

Technical character comes from accuracy. Gaming terminology, invented protocols, and machine jargon do not become the product’s everyday language.

## 10. Tone follows the situation

| Situation | Tone | Example |
|---|---|---|
| Routine command | Brief, specific | “Export CSV” |
| Success | Quiet confirmation | “Changes saved” |
| Empty list | Helpful | “No projects yet. Create your first project to organize your team’s tasks.” |
| Invalid input | Concrete | “Enter an address in the format name@example.com.” |
| Connection loss | Transparent | “Connection lost. Last saved at 14:32. Reconnect.” |
| Partial completion | Exact | “Updated 18 of 20 records. Two records need review.” |
| Deletion | Restrained, explicit | “The project and its 24 tasks will be deleted. This cannot be undone.” |
| Insufficient permissions | Respectful | “Only the project owner can edit this project. Request access.” |
| Long operation | Informative | “Processed 240 of 800 files.” |

Humor may appear in occasional, low-stakes moments. Payment, access, data loss, and failure messages retain a direct tone.

## 11. Visual and verbal language work together

A short command in petite caps identifies an available action. Natural-case text explains its meaning. Monaspace Krypton presents an exact value.

For an export flow:

- “Export” uses Source Sans 3 petite caps.
- “The file will include 248 records matching your current filters” uses Source Sans 3 in natural case.
- `projects-2026-10-31.csv` uses Monaspace Krypton.
- The “Download CSV” button receives the brand accent and petite-cap labeling.
- Completion produces a quiet “File ready” message.

Each treatment carries a stable meaning. Familiarity makes the system faster to read.

## 12. Quality criteria

The system succeeds when:

- Content leads on working screens.
- Commands, values, and explanations are immediately distinguishable.
- Rectangular geometry and graphic discipline support comfortable reading.
- Selection, focus, progress, and errors have distinct expressions.
- Repeated use requires progressively less attention to the interface.
- Both themes retain the same character.
- The interface remains clear with animation disabled.
- Messages remain useful without color.
- Extended sessions preserve a sense of control and calm.
