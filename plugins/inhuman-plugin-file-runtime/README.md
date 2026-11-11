# File runtime plugin

An optional **embedding SDK plugin** for Inhuman hosts. It describes complex
files already present in a host's transcript, suggests configured environments,
and executes TypeScript in a fresh offline Microsandbox microVM. It does not
create another file registry or give the model an S3 client or host shell.

This first slice is programmatic. The current daemon does not import JavaScript
plugin modules from a manifest. There is deliberately no `plugin.json` claiming
install-and-enable support. A host registers the returned `InhumanPlugin` tools
and calls `runtime.contextNotes(context)` before model context projection.
Automatic daemon/UI attachment delivery is not implemented by this package.

## Host integration

```ts
import { createFileRuntimePlugin, documentEnvironment } from "@inhuman.tools/plugin-file-runtime";

const { plugin, runtime } = createFileRuntimePlugin({
  host: {
    async open(context) {
      // Authenticate the actual invocation; never trust a sessionId from tool arguments.
      return fileAccessForInvocation(context);
    },
  },
  environments: [documentEnvironment(imageDigestReference)],
});

// Register plugin.tools through the host's ordinary policy/tool admission path.
// Before each model request, add these transient notes to its context:
const notes = await runtime.contextNotes(invocationContext);
```

`SessionFileAccess.list` supplies small metadata from the existing transcript,
including originals, tool-returned files and earlier output artifacts. Plain
text/JSON/images need no environment hint; structured CSV/TSV does. Unsupported
complex files remain visible with an empty environment list. Discovery does not
read the file or start a VM. Hints describe installed libraries and limitations;
they are not proof that a document was processed successfully.

The host implements `read` and `publish`. Reads recheck current access and return
the exact revision within the supplied byte bound. Publication must sniff/check
output types, reserve quota, recheck access, and atomically accept the complete
batch under `operationId`. Retries must return the same accepted receipt. A lost
publication acknowledgement produces `status: "unknown"`; reconcile that
operation before retrying. The host owns durable operation records and admission
after restart. This prototype does not supply a durable distributed scheduler.

Regenerate notes from accessible metadata after restart/compaction. Keep stable
file identities in the host transcript; notes are not the sole durable reference.
File names and contents are untrusted data and never grant permissions.

## Runtime image

The included image pins Deno 2.8.3 by base-image digest and dependencies through
`runtime/deno.lock`. It contains `@std/csv@1.0.6`, `exceljs@4.4.0` and
`pdf-lib@1.17.1`. It supports CSV/TSV calculations, XLSX reading/creation, and PDF
creation/page/form manipulation. PDF text extraction, rendering, OCR, iWork and
formula recalculation are **not** included. These are environment capabilities,
not a claim of full format fidelity.

From this package directory:

```sh
pnpm build
docker build -t inhuman-file-runtime:prototype runtime
docker save -o /tmp/inhuman-file-runtime.tar inhuman-file-runtime:prototype
node examples/import-image.mjs /tmp/inhuman-file-runtime.tar
```

The last command prints the pinned image reference. Pass it to the plugin or
the runnable host example:

```sh
node examples/demo.mjs 'inhuman-file-runtime:prototype@sha256:...'
```

The demo emits a file-environment hint, calculates all 1,500 CSV rows (total
1,125,750), and stores `summary.csv` plus provenance in the printed temporary
directory. It requires no model connection. Docker is used to build/export the
image; Microsandbox runs it independently. For another CPU architecture, build
the corresponding image. For production, distribute the built image through a
private registry and pin its actual digest.

## Execution boundary

`file_runtime_execute` takes an environment **and revision**, explicit input
file revisions, TypeScript code, and up to eight named outputs. Code receives
`inputs` (metadata plus guest paths) and `outputDir`; return a JSON value. Use
dynamic imports, such as `await import("exceljs")`, inside the code body.

Each execution gets a new local microVM: network disabled, restricted guest
profile, multi-tenant host deployment profile, UID/GID 1000, no host mounts,
ports or credentials. Deno additionally denies network, subprocess and FFI
access. Environment reads are limited to nine non-secret guest configuration keys
needed by npm dependencies (`READABLE_STREAM`, `NODE_DEBUG`, `NODE_ENV`,
`GRACEFUL_FS_PLATFORM`, `TEST_GRACEFUL_FS_GLOBAL_PATCH`, `BLUEBIRD_DEBUG`,
`BLUEBIRD_WARNINGS`, `BLUEBIRD_LONG_STACK_TRACES`, `BLUEBIRD_W_FORGOTTEN_RETURN`);
host environment is not copied.
The executor refuses SDK cloud routing rather than silently sending
files elsewhere. Dependencies are cached at image build time.

Defaults per plugin instance: two concurrent admissions, 30 s for the complete
operation, 1 vCPU, 512 MiB guest RAM, 256 MiB writable root disk, 20 MiB inputs,
8 MiB output files, 64 KiB combined stdout/stderr, 64 KiB JSON result.
Configured disk/CPU/memory limits require qualification on the execution host;
vCPU count is not a reservation of host CPU time. Operators must also bound
Microsandbox's host-side logs, caches and service resources. No VM reuse or
user snapshots are enabled.

Stop/timeouts destroy the entire VM. Late VM creation remains charged against
concurrency until it settles and cleanup finishes. `cleanupFailed` lets a host
record late-cleanup failures for reconciliation.
Failed VM removal keeps its slot charged; after operator cleanup, replace the
plugin runtime instance to reopen that capacity. Outputs are read with byte
bounds and published only after a successful program and confirmed VM removal.
The host's own publication transaction determines whether a concurrent Stop
preceded or followed an already committed batch.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
FILE_RUNTIME_IMAGE='repo/image@sha256:...' pnpm test:microvm
```

The ordinary suite exercises discovery, scoped revision resolution, hashes,
publication ordering, failures, budgets, concurrency and cancellation. The
opt-in microVM test performs CSV → XLSX/PDF, reopens the results, checks denied
network/environment/filesystem/subprocess operations and checks VM cleanup.
It also enters an infinite loop and verifies that the deadline destroys the VM
without publishing outputs.
It requires a prepared image and working host virtualization. These tests do
not qualify hypervisor escape resistance or the host's S3/authorization adapter.

Package qualification: build, `pnpm pack --pack-destination /tmp/file-runtime-pack`, then
install that archive and a packed `@inhuman.tools/plugin-sdk` dependency closure
into a clean consumer. Run the exported factory and the demo there. This package
is private while the embedding and daemon-integration boundary is being tried.

## Prototype verification, 2026-11-09

Build, typecheck and lint pass. Fifteen logic tests pass; the separate opt-in
microVM test passes with actual CSV/XLSX/PDF operations, denied sensitive APIs,
an infinite-loop timeout and empty VM inventory afterward. The packed plugin,
SDK and commons install into a clean consumer without workspace links. Its
public TypeScript surface compiles, and the packed host demo executes the
1,500-row calculation and publishes the CSV artifact with provenance.

Real execution was checked on macOS arm64 using Microsandbox 0.7.13 and a Linux
arm64 guest. Linux/KVM host deployment, adversarial isolation, host log/disk
quotas and a production transcript/storage adapter remain separate qualification
work. No daemon loader or UI upload support is implied by these results.
