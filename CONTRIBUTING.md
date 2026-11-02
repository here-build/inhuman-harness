# Contributing

Start with the [package map](docs/packages.md) to find the part you want to change.
For a new or newly documented public package, follow the
[package guidelines](docs/package-guidelines.md). Report a reproducible bug or
suggest an improvement through [GitHub issues](https://github.com/here-build/inhuman-harness/issues).
For vulnerabilities, use [SECURITY.md](SECURITY.md).

## Develop from source

Use Node.js 22+, the pnpm version pinned in `package.json` (10.34.8), and a Rust
toolchain for the terminal renderer, `qd`. Browser visual checks also need
Chrome or Chromium; see [test lanes](docs/testing.md).

```sh
git clone https://github.com/here-build/inhuman-harness.git
cd inhuman-harness
corepack enable
pnpm install --frozen-lockfile
pnpm build
cargo build --release --manifest-path packages/quickdraw/rust/qd/Cargo.toml
pnpm --filter inhuman dev
```

The last command starts the terminal client with debug logging and restarts the
daemon. To open the web client from the built checkout:

```sh
node packages/inhuman/bin/inhuman.mjs web
```

Use a separate kernel directory when testing changes against disposable state:

```sh
node packages/inhuman/bin/inhuman.mjs --kernel /tmp/inhuman-dev web
```

Rebuild after changing source. The workspace wrappers build dependencies before
package tests; running a package directly against stale `dist` can exercise old
code.

## Check a change

```sh
pnpm verify
```

This runs packaging boundaries, build, typecheck, lint, logic tests, process
smoke tests, and visual approvals. CI runs logic and process checks separately;
visual checks run for selected paths or when explicitly requested. Use
[docs/testing.md](docs/testing.md) for lane selection, browser setup, and
intentional snapshot updates.

Keep changes focused. In a pull request, explain the observable behavior that
changed, how you checked it, and any compatibility impact. Include a screenshot
or recording for visible interface changes. Update the package's example and
documentation when its usage changes.

## Release

The [Release workflow](.github/workflows/release.yml) builds the four `qd`
binaries, builds the workspace, runs `pnpm release:check`, and publishes public
workspace packages with provenance. Versions already on npm are skipped.
`@inhuman.tools/arrival-manifold` is excluded and released separately.

1. Bump the version of each changed package and dependent packages that need the
   new version, including `inhuman` when applicable. Record user-visible changes
   in the release notes.
2. For each package, configure npm trusted publishing for repository
   `here-build/inhuman-harness` and workflow `release.yml`. The workflow uses
   OIDC rather than a stored npm token. A brand-new package needs its initial
   manual publish before its trusted publisher can be configured.
3. Run Release from the Actions tab with `dry_run` enabled. Review the package
   list and output, then run it again with `dry_run` disabled to publish.

`pnpm release:check` checks the runtime dependency closure of `inhuman` for
public access, a version, and a nonempty `files` list. It also rejects public
packages with private workspace runtime dependencies. It does not prove every
published package works in a clean consumer project; use the
[package guidelines](docs/package-guidelines.md) for that review.
