# `@-internal-`

Private config quasi-packages. Not product. Not published. Workspace-only.

`@-internal-/*` is the reserved org for configs that must not sit in `packages/` next to product.

| Path | Package | Role |
|------|---------|------|
| [`eslint-config/`](./eslint-config/) | `@-internal-/eslint-configs` | ESLint flat presets (`nodejs`, `browser`, `shared`, `cloudflare`, `landing`, `reactConfig`) |
| [`tsconfig/`](./tsconfig/) | `@-internal-/tsconfig` | Purpose × env TypeScript bases |

Copied from [here.build/commons](https://github.com/here-build/commons) (`packages/eslint-config`, `packages/tsconfig`). MIT.

Every package pins TypeScript 6.0.2. `typescript-eslint` does not support the 7.x compiler API yet.

Every product package: `lint` → `eslint .`, `typecheck` → `tsc --noEmit`.

```js
import { nodeProject } from "@-internal-/eslint-configs";

export default nodeProject(import.meta.dirname);
```

Tests are in the tsconfig program (`tsconfig.json` includes them; `tsconfig.build.json` excludes them from emit). Type hacks in tests are `@ts-expect-error` with an explainer, not excluded files. `ignoreTests: true` is only for a package whose tsconfig still cannot see tests — otherwise projectService cannot parse those files.
