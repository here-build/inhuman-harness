# inhuman

A local agent workspace whose sessions keep running after you close the browser or terminal. A background daemon holds the conversation and runs the work on your machine; reopen either client to pick it up again.

## Start

Requires **Node.js 22+** and **macOS or Linux**.

```sh
npx inhuman web
```

The command starts the daemon and a local web server, prints its URL, and opens your browser. It then returns to your shell while the services keep running.

1. On the first-run **Connect a model** screen, choose a provider and finish its sign-in or credential prompts. Options include ChatGPT, OpenRouter, Grok, and OpenAI-compatible endpoints. Later, add connections through **Settings → Connections → Add a model**.
2. In a terminal, register an existing project folder:

   ```sh
   cd /path/to/your/project
   npx inhuman
   ```

   Replace the path with your folder. Once the terminal client opens, you can close it; the project and session remain available.
3. Return to the browser, select the project's tab, and choose a model in the composer. Sending from the project page creates a session.
4. Try: “Write a three-item project planning checklist. Reply here only; do not use tools or change files.”

Close the browser and run `npx inhuman web` again to return to your sessions. Your machine must remain running for work to continue. Tools may wait for your approval.

## Everyday use

```sh
npx inhuman                       # terminal client
npx inhuman web                   # browser client
npx inhuman start                 # start services and print the URL
npx inhuman web --no-browser      # print the URL without opening it
npx inhuman daemon stop           # stop background execution
npx inhuman daemon restart        # restart; interrupts active work
npx inhuman --help
```

Closing a client leaves the daemon running. `daemon stop` stops it; saved session documents remain on disk. The default kernel directory is `~/.harness`; use `--kernel PATH` consistently to choose another one. Saved session documents live under the kernel's `documents/` directory.

Choose `manual`, `auto`, or `always approve` in the session's permission picker. MCP servers and plugins can extend the agent's tools after setup.

Remote access through `npx inhuman login` is experimental and restricted to an email allowlist. It is separate from connecting a model provider.

Read the [usage guide](https://github.com/here-build/inhuman-harness/blob/main/docs/usage.md) for setup, permissions, storage, and troubleshooting. See the [project](https://github.com/here-build/inhuman-harness#readme), [remote access restrictions](https://github.com/here-build/inhuman-harness/blob/main/docs/proposals/remote-access.md), or [report an issue](https://github.com/here-build/inhuman-harness/issues).

[MIT license](https://github.com/here-build/inhuman-harness/blob/main/LICENSE.md).
