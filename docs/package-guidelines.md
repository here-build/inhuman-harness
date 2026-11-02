# Consumer-ready packages

Use this checklist when introducing a public package or changing its public
surface. These are contribution guidelines, not a claim that every current
package meets them. The [package map](packages.md) identifies entry points and
implementation packages.

- **Purpose:** say who the package serves, what it does, and when to use it.
  Explain its relationship to the harness and any required host.
- **Working example:** provide an installation command and a small runnable
  example with expected output or behavior. Include setup and teardown when
  resources or background processes are involved.
- **Exports and types:** expose intentional entry points through `exports` and
  ship the matching declarations and runtime files. Document supported imports;
  examples must not reach into source or undeclared internal paths.
- **Clean packed install:** build, pack with `pnpm pack`, inspect the tarball,
  then install it in a temporary project outside the workspace. Run the example
  and a TypeScript consumer check there. Pack any unpublished workspace
  dependencies too, so the check does not silently use an older registry build.
  Confirm bins, assets, and declarations work without workspace links or dev
  dependencies.
- **Compatibility:** state Node/browser/platform requirements, ESM or other
  module support, peer dependencies, and host versions where relevant. Check
  claimed environments and keep browser entry points free of Node-only imports.
- **Metadata:** include an accurate description, license, repository directory,
  homepage, and issue URL. Review `files`, dependency placement, and public
  publishing configuration. Keep private implementation packages private.
- **Documentation:** keep usage in the package README, link deeper reference
  material, and show errors or limitations a consumer will actually encounter.
- **Release notes:** describe observable changes, migration steps, and breaking
  changes. Bump affected versions and review dependent packages before release.

## What the repository checks today

`pnpm test:boundaries` runs the tests in
[`scripts/packed-product.test.mjs`](../scripts/packed-product.test.mjs) and
[`scripts/release-check.test.mjs`](../scripts/release-check.test.mjs). They cover
selected import boundaries, package identities, packed product files, and the
release-check rules. They are not a universal clean-install test for every
package.

`pnpm release:check` validates the `inhuman` runtime closure and rejects public
packages with private workspace runtime dependencies. The
[Release workflow](../.github/workflows/release.yml) builds and runs that check
before publishing; it does not run the full `pnpm verify` gate. Follow
[CONTRIBUTING.md](../CONTRIBUTING.md) for development and release steps and
[test lanes](testing.md) for behavior checks.
