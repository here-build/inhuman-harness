# Web UI stories

`pnpm storybook` serves them on :6006; `pnpm build-storybook` writes `dist/storybook`.
`src/__tests__/stories.test.ts` mounts every story and runs its `play`, so a broken
story fails the gate.

Every story is the real app — router, frame, tape, composer — at one route. Only the
dial is the story's: `world.ts` builds plexus documents locally (kernel, projects,
sessions with real turns and jobs) and `StoryDial` serves them without a socket. The
session port writes back into the same models (and `connect/adopt` / `ui/resolve` follow a script per provider, see `onboarding.stories.tsx`), so a story stays live: a picked
model lands in `kvs`, a sent message opens a turn, Stop seals it. A job binds to one
document, so scenes build fresh jobs on every call.

The toolbar's **Scheme** pins `data-scheme` on the root; every token is a
`light-dark()` pair, so the page follows.

## Brandbook

`brand-*.stories.tsx` are pages, not scenes: the visual identity drawn in the app's own tokens and classes.
`brand-kit.tsx` reads the color pairs from `styles.css`, so a token change shows here without an edit.

| Page | What it holds |
| --- | --- |
| Brandbook › Foundations › Principles | the proposition: two surfaces and the bridge, the whiteboard, character, laws, the name, what was rejected |
| Brandbook › Foundations › Color, Typography, Space and shape, Motion | the scales, each in both schemes, with do / don't |
| Brandbook › Patterns › Status language | the four states across rail, lanes, calls, workflow, and the daemon line |
| Brandbook › Patterns › Components, Voice | the kit and the copy rules, from the strings the app says |
| Brandbook › Journeys › Map | eight user flows, each step linked to the scene below that shows it |
| Brandbook › Journeys › Findings | where the live app departs from its journeys or its rules |

## Features and their states

| Feature | State | Story |
| --- | --- | --- |
| **Frame** | daemon not up yet | App › Connecting |
| | kernel up, nothing chosen | App › Workspace |
| | no projects known | App › No Projects |
| | phone: rail behind Browse | App › Phone |
| **Connection** | no daemon on first connect: command + retry | Connection › Unreachable |
| | socket answered, room never synced | Connection › Unanswered |
| | dropped after attach, redialing; composer locked | Connection › Reconnecting |
| | session the kernel does not list | Connection › Missing |
| | session in another project: open it there | Connection › Elsewhere |
| | attach cancelled | Connection › Cancelled |
| | route attaching past a beat | Connection › Opening |
| **Sidebar** | open session running (green dot) | Sidebar › Running |
| | open session waiting on you (amber ring) | Sidebar › Waiting For You |
| | every row lit from its kernel glance: running, ask, question, idle | Sidebar › All Sessions |
| | many rows, long and non-Latin titles | Sidebar › Many Sessions |
| | bots apart from sessions: global, then each project's own | Sidebar › Bots |
| | sections split the rail fairly: a short one takes what it holds, long ones halve it and scroll | Sidebar › Split Short, Split Even |
| | project not attached yet | Sidebar › Attaching |
| **Project index** | empty project | App › Empty Project |
| | pick a session or start one | App › Project Index |
| **Fresh session** | place + composer above center | Tape › Fresh, Composer › Empty |
| **Tape: messages** | user message, multi-turn | Tape › Conversation |
| | markdown: headings, lists, tasks, quote, table, code, link | Tape › Conversation |
| | speech mid-sentence | Tape › Running |
| **Tape: left lane** | round title and description | Tape › Conversation, Progress |
| | task create / start / drop / validate, goal | Tape › Progress |
| | model and connection per span, change of model | Tape › Conversation, Progress |
| **Tape: right lane** | reasoning beside its round | Tape › Conversation, Reasoning |
| | reasoning-only round | Tape › Reasoning |
| | narrow: reasoning folded ahead of its round | Tape › Narrow |
| **Tape: agents** | spawned agent as one status: name, model, worker title (spawn message until it has one), progress | Tape › Agents |
| | a call that waited closes in its round; a background one where its result is claimed | Tape › Agents |
| | the bar is the state: blue working, yellow asking, gray settled or cancelled, red failed | Tape › Agents |
| | still out: held to the bottom; settled: no status line | Tape › Agents |
| | narrow: agents follow the round that took them in; the ones still out close the tape | Tape › Agents Narrow |
| | click: the agent's own session in a dialog, both lanes, read-only; its agents open their own | Tape › Agent Peek |
| | a worker whose session cannot be opened (review, sweep) | Tape › Agents (click it) |
| | a program's row: Graph inside the disclosure opens its dataflow in a dialog; cards read the session's own jobs, so a reviewer held at an approval is yellow | Tape › Program Graph |
| **Tape: looks** | Reading files and directories (`dir/`, `./`) | Tape › Looks |
| | Searching for … in scope | Tape › Looks, Conversation |
| | Finding … ; no matches | Tape › Looks |
| | failed look with its reason | Tape › Looks |
| | binary file (not openable), live look (spinner) | Tape › Looks |
| **Tape: tools** | run of tools as one list | Tape › Tools |
| | failed tool, live tool | Tape › Tools |
| | text / markdown receipts | Tape › Tools |
| | scheme batch with its calls | Tape › Scheme Batch |
| **Tape: files** | edit in context | Tape › Diffs, Conversation |
| | new file, overwrite, failed write | Tape › Diffs |
| **Tape: terminal** | colored output, palette badges | Tape › Terminals |
| | non-zero exit, working directory, heredoc script | Tape › Terminals |
| | still printing | Tape › Terminals |
| **Composer** | empty, drafting (Send) | Composer › Empty, Drafting |
| | live turn (Stop) | Composer › Running |
| | refused message keeps the draft | Composer › Refused |
| | approval: diff / shell / arguments receipt | Composer › Approval Diff, Shell, Arguments |
| | ask lands mid-draft: held, then armed | Composer › Approval While Drafting |
| **Model picker** | providers with person / key / balance / quota | Composer › Picker Open |
| | low quota (warning), failed wire (reason) | Composer › Picker Open |
| | search across providers | Composer › Picker Search |
| | provider's models beside its row | Composer › Picker Provider |
| | no completion catalog: model named only | Composer › No Catalog |
| | no model chosen | Composer › Approval Diff |
| **Onboarding** | nothing connected: the page is the provider tiles, on any route | Onboarding › Splash, Project Route, Workspace Route |
| | servers found on this machine, live; none found says so | Onboarding › Local Servers, Splash |
| | search over the API-key tiles, no match | Onboarding › Search, Search Empty |
| | the first call out, no answer yet | Onboarding › Connecting |
| | API key field in place of the grid | Onboarding › Api Key |
| | browser sign-in: link, waiting (cancellable), done | Onboarding › Browser, Browser Waiting, Browser Done |
| | browser sign-in that also takes a pasted key | Onboarding › Browser Paste |
| | custom endpoint: address, then optional key | Onboarding › Custom Endpoint |
| | cancelled (focus back on the tile), failed with Retry | Onboarding › Cancelled, Failed |
| | confirmation; a step only the terminal can finish | Onboarding › Confirm, Unknown Form |
| | phone width, dark scheme | Onboarding › Phone, Phone Step, Dark |
| | connected, waiting for the kernel to list it | Onboarding › Landing |
| | line to the daemon redialing: notice under the heading, tiles wait | Onboarding › Reconnecting |
| | kernel readable, no port to write through yet: tiles wait | Onboarding › No Port |
| | with providers connected: "Add a provider" in the picker, its step in place | Onboarding › Add Provider, Add Provider Step |
| **File preview** | source file, highlighted | File preview › Source File |
| | Markdown file | File preview › Markdown File |
| | directory listing, search matches | File preview › Listing, Search Results |
| | not on disk (no `/file` server) | File preview › Not On Disk |
| **Workflow graph** | a program's calls as cards in causal order: agents as actors, tools as instruments | Workflow › Fanout, Tools |
| | a map under one frame: iteration tabs, the card shows the selected pass | Workflow › Fanout, Nested |
| | a loop: the value wraps the frame back into the slot it feeds | Workflow › Loop |
| | a branch: a dashed frame for the clause, another pass's route as a ghost | Workflow › Branch |
| | a filter: the pill on the trunk, `kept k of n` | Workflow › Filter |
| | a failed call: red bar, the error on one line; the program carries on | Workflow › Tools |
| | colour is state: blue working, yellow asking, gray settled, red failed; wires and frames are gray | Workflow › Fanout Live |
| | live: the incremental fold; a held reviewer asks while the rest of the graph waits | Workflow › Fanout Live |
| | streaming: calls released one by one, each card turns gray as the next starts blue | Workflow › Streaming |
| | a live call inside a pass: the tab wears the working dot, the card behind it is live | Workflow › Live In Iteration |
| | a failed call: its pass's tab wears the red dot | Workflow › Failed Agent |
| | a cancelled call: gray, no dot, nothing says it went wrong | Workflow › Cancelled Agent |
| | a loop's passes are tabs; the last is the sign-off | Workflow › Loop Tabs |
| | on a phone the canvas scrolls inside its pane | Workflow › Narrow |

## Not storied

- **Image and PDF previews, a pending load**: they read `/file` from the daemon, which
  Storybook does not serve.
- **An unreadable job and a cell that throws**: defensive fallbacks ("unreadable step",
  "could not be shown"); `session-reducer.test.ts` and the gate here cover them.
