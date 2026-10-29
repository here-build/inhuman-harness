# `@inhuman.tools/policy-processor`

JSON floor for the **shell-argv** and **file-access** clusters, plus the monadic authorization wait and one auto remainder PDP. Prep walks an [unbash](https://www.npmjs.com/package/unbash) AST into prepared questions; the matcher never sees `|`, `xargs`, or `FOO=bar`. Floor is data (`policy.json`). Remainder is Arrival Scheme (`auto-mode-ask.scm`); each `.prompt` is judgement (`ext/prompt/isolated` → child `CompletionExpectation`). `license` is the PEP wait.

**Floor:** one `policy.json` — `read_file` / `write_file` enable lists (`!` deny), `read_block` / `write_block` hard-block, and a `bash` command tree → `approve | deny | ask | block`. A cluster the document did not define is `ask`. Empty file list is deny-all. `allow` is a spelling of `approve`. `assume` smokes the bash processor at compile.

**Host:** `@inhuman.tools/policy-processor/license` — `license(job, turn, root) → Promise<boolean>`. Programs live on the session root (`policyProgram`, `judgeAskProgram`); compiled Policy / remainder votes intern on that root. Matcher compile is `LicenseScope.compiledPolicy(program)` → `{ bash, read, write }`. Dist ask: [`auto-mode-ask.scm`](../../policy/auto-mode-ask.scm) + [`classifier-bash.prompt`](../../policy/classifier-bash.prompt) / [`classifier-bash-incomplete.prompt`](../../policy/classifier-bash-incomplete.prompt) (Tirith nested-incomplete remainder) / [`classifier-read.prompt`](../../policy/classifier-read.prompt) / [`classifier-write.prompt`](../../policy/classifier-write.prompt) (in-enable `!`) / [`classifier-write-outside.prompt`](../../policy/classifier-write-outside.prompt) / [`classifier-write-risky.prompt`](../../policy/classifier-write-risky.prompt) / [`classifier-mcp.prompt`](../../policy/classifier-mcp.prompt). Registers `classifier/bash` `classifier/read` `classifier/write` `classifier/mcp`. Floor deny is a join vote (no remainder).

**Defaults:** empty-config envelope: [`src/reasonable-defaults.json`](../../../../packages-policy/policy/src/reasonable-defaults.json).

## Equation

```
job, turn, root
  → license
  → reads root.policyProgram / judgeAskProgram
  → writes policyResult / classifierResult / classifierAbstain
  → boolean
```

Matcher (still the floor):

```
policy.json → compiledPolicy → { bash(command), read(path), write(path) } → approve | deny | ask | block
```

`block` is unliftable (descending arms cannot override it; auto has no processor for it). `deny` is overridable by children in the floor lattice; auto has no deny remainder. Prep is inside `bash`. Cut keep is per node inside `eval_T`. The arity table that *discovers* glued-short shapes of `I` is not this package.

## Tirith shell floor

`FloorHandle` checks the complete original shell command with the installed Tirith binary before publishing `policyResult`. `checkBash` and the Scheme floor remain pure. The host joins both votes with `block > deny > ask > approve`. Tirith **coverage** (not raw `action`) is the join: concrete allow/warn/block map to `approve`/`ask`/`block`; nested-incomplete-only is remainder `ask`; offline package-intel gaps are not a finding; scanner failure is `block`. Dist ask + `classifier-bash-incomplete.prompt` is the nested-incomplete intern. Classifier evidence is concrete findings only.

The adapter uses argument-array execution, POSIX parsing (matching the shell tool's `/bin/sh`), offline local analysis, a five-second timeout, a 1 MiB output limit, and cancellation. It validates JSON schema 3 and the verdict/exit-code pair. Program, command, tool name, or workspace changes cancel pending checks; cancelled, released, and closed jobs cannot receive stale votes. No verdict is published until inspection finishes.

`tirith-policy/.tirith/policy.yaml` is the package-owned scanner policy. Child configuration and state are isolated from user/project policy files, allowlists, and bypass environment variables. Each check uses temporary state that is removed afterward, so this integration uses Tirith's bundled detection rules without a persistent threat-intelligence cache or background updates. It is command inspection, not execution containment.

Structured findings are retained in `policyEvidenceJson`; `policyMessage` carries concrete and nested-incomplete copy into the shell approval/receipt UI (intel-gap is silent). The remainder PIP includes **concrete** findings only, labeled untrusted as instructions, and uses that cut in cache identity.

Case guards live in `src/__tests__/tirith-floor.test.ts` and `src/__tests__/tirith.test.ts`. They cover precedence, pending checks, lifecycle invalidation, scanner failures, output validation, hostile configuration, command-as-data handling, and real-binary attacks. Run `pnpm --filter @inhuman.tools/turn test`. The initial red run had 21 failures and one clean-command pass; the shell receipt guard also failed before implementation.

## Status

Matcher + algebra suite. `license` is the guard; tests stand up a Job orchestrator. MCP residual retries until a vote (no language yet). Host wiring of `license` is the next consumer.
