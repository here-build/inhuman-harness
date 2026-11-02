# Hello plugin

A complete CLI plugin with one tool, `hello`. It uses the current host's Scheme ABI and needs no dependencies or build step. Requires Node.js 22+ and npm. The commands below use `npx inhuman` to run the CLI.

From the repository root:

```sh
npx inhuman install --kernel /tmp/inhuman-hello-demo "$PWD/examples/hello-plugin"
npx inhuman eval --kernel /tmp/inhuman-hello-demo --mode yolo --format json -e '(hello {:name "Ada"})'
```

The JSON result on stdout is `"Hello, Ada!"` (progress appears on stderr). `--mode yolo` authorizes this local greeting tool without an approval prompt. No model connection or API key is needed. Both commands must use the same kernel folder; this example uses a separate folder so it can be tried independently.

`package.json` gives npm the package identity. `plugin.json` gives the host the plugin identity (`hello-example`) and points `extensions["tools.inhuman"].abi` at `tools.scm`. The host loads that program and registers `hello`; `:expose 'both` makes it available as a Scheme symbol and a model tool. The input schema requires a string `name`.

After editing the source, restart the daemon for this kernel before invoking it again:

```sh
npx inhuman daemon restart --kernel /tmp/inhuman-hello-demo
```

When finished:

```sh
npx inhuman daemon stop --kernel /tmp/inhuman-hello-demo
```

For JavaScript tool definitions called programmatically, see the [plugin SDK guide](../../packages/harness-plugin-sdk/README.md). The current CLI does not load an SDK JavaScript export from a manifest's `plugins[].importPath`.
