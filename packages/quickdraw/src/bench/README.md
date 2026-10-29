# Present-path bench

Load box for the present path. Founding experiment: **yes**, TS can hold ≥30fps
on a moderate TUI when TEA owns pure `update`, logic/paint split across
`worker_threads`, and paint is cell buffer + damage. That architecture shipped
as box-cadence in `src/runtime` (product protocol is box-bus, not this folder's
whole-model TEA snapshot). Run it with `pnpm --filter @inhuman.tools/quickdraw bench`.

## Threads

| Thread | Owns | Must not |
|--------|------|----------|
| Worker (`worker.ts` + `model.ts`) | `Model`, `update` | write stdout, hold Buffer |
| Main (`main.ts` + `view.ts`) | present, ANSI, PTY size | mutate model |

Latest-wins mailbox drops intermediate gens; single host event loop only.

```bash
pnpm --filter @inhuman.tools/quickdraw bench
```
