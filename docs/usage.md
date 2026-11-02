# Using inhuman

inhuman is a local agent workspace. Your sessions belong to a background daemon on your machine; the browser and terminal are ways to view and control them. Closing either client leaves the daemon and its sessions running. Work can still wait for your approval, a provider response, or a connected tool.

## Start your first session

You need **Node.js 22 or newer** and **macOS or Linux**. You also need access to a supported model provider. The npm package includes the clients; building from source is not required.

```sh
npx inhuman web
```

This starts the daemon and a local web server in the background, prints the URL, and opens your browser. The default address is `http://127.0.0.1:8787/`; if that port is busy, inhuman chooses a free one. The command returning to your shell is expected.

1. On a fresh installation, use the **Connect a model** screen. For additional connections later, open **Settings → Connections → Add a model**.
2. Choose a provider and complete its setup. ChatGPT and Grok offer subscription sign-in; OpenRouter offers browser authorization or an API key. An OpenAI-compatible connection asks for an endpoint and credentials. Follow the connection's prompts.
3. Register a project by opening the terminal client in an existing folder:

   ```sh
   cd /path/to/your/project
   npx inhuman
   ```

   Replace the example path with your folder. Once the terminal client opens, you can close it. This registers the folder and creates a session without stopping the background daemon when you leave.
4. Return to the browser and select the project's tab. Choose a model in the composer's model picker. A provider connection supplies the models; connecting it and selecting a model are separate steps. Sending a message from the project page creates a new session, or you can select the terminal-created session in the sidebar.
5. For a first check, send this prompt:

   > Write a three-item checklist for planning a small personal project. Reply in this chat only; do not use tools or change files.

6. After the reply arrives, close the browser tab. Run `npx inhuman web` again and select the session in the sidebar to see its conversation.

To add another folder, run `npx inhuman` from that directory, then select its project in the browser. The browser's **Add a project** dialog currently displays terminal instructions rather than registering a folder directly; use `npx inhuman` if it shows the older `harness` command. Start with a specific request, such as: “Read this project's README and summarize how to run it. Do not change files.” Review any requested tool approvals before allowing them.

Provider authentication is separate from `inhuman login`: that command enables remote access to your machine, not model access.

## Come back to your work

```sh
npx inhuman web                   # open the browser client
npx inhuman                      # attach the terminal client
npx inhuman --continue           # restore this terminal tab's last session
npx inhuman --resume SESSION_ID  # attach the terminal client to a session
```

Running `web` again reuses the daemon and local web server when they are already running. Browser and terminal clients connect to the same daemon; select the same session to continue the same conversation.

Closing the browser or terminal client does **not** stop the daemon. The machine must remain running for work to continue; this is not cloud execution.

To stop the background service explicitly:

```sh
npx inhuman daemon stop
```

This stops the daemon and interrupts ongoing execution; the local web server exits when the daemon goes away. Saved session documents remain on disk. To start again, run `npx inhuman web` or `npx inhuman`. Use `npx inhuman daemon restart` when a restart is needed, allowing for interruption of active work.

## Choose how tools get permission

The session's permission picker controls tool approval:

| Mode | What to expect |
| --- | --- |
| `manual` | Calls that are not already allowed ask for approval. |
| `auto` | Policy rules and a judge model decide which calls may run; others ask you. |
| `always approve` (`yolo`) | Calls run without routine approval; hard policy blocks still apply. |

Use `manual` while getting familiar with the tools. Check the requested action and its target before approving it. A session waiting for approval needs your response even if you close its client. Permission decisions control tool execution; they do not make the tools an isolated operating system sandbox.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `npx inhuman start` | Start the daemon and web server, print the URL, and return. |
| `npx inhuman web --no-browser` | Start or reuse the services and print the URL without opening it. |
| `npx inhuman web --port 9000` | Prefer port 9000 when starting a new web server. An existing server is reused. |
| `npx inhuman daemon start` | Start only the daemon. |
| `npx inhuman daemon stop` | Stop the daemon. |
| `npx inhuman daemon restart` | Restart the daemon. |
| `npx inhuman --help` | Show the command list. |
| `npx inhuman mcp --help` | Show MCP connection commands. |
| `npx inhuman install --help` | Show plugin installation options. |

You can add MCP servers and plugins after your first successful conversation. They extend the tools available to the agent; they are not required to start chatting.

```sh
npx inhuman mcp list
npx inhuman mcp add NAME --url https://example.com/mcp
npx inhuman mcp add NAME -- COMMAND ARGUMENTS
npx inhuman install PACKAGE
```

Replace the uppercase placeholders and example URL with the package or server's actual instructions. A server may need its own credentials or authorization; `npx inhuman mcp login NAME` authorizes an MCP connection that supports OAuth.

## Local storage

The default kernel directory is `~/.harness`. It holds configuration, connection credentials, and saved documents under `documents/`, including session history. Preserve this directory if you want to keep your workspace history. Opening a project also creates a `.harness/sessions` directory inside it.

Useful diagnostic files in the kernel directory are:

| File | Purpose |
| --- | --- |
| `harness.log` | Daemon and runtime process log. |
| `web.log` | Local web server log. |
| `web.json` | The running web server's address and process record. |

Pass `--kernel PATH` to use another kernel directory. Use the same path on subsequent commands, including stop and restart:

```sh
npx inhuman web --kernel ~/.harness-example
npx inhuman daemon stop --kernel ~/.harness-example
```

A different kernel has its own daemon and configuration. Treat stored credentials and logs as private when sharing diagnostics.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| The command exits immediately after printing a URL | This is normal for `start` and `web`: the services run in the background. Open the printed URL. |
| The browser does not open | Run `npx inhuman web --no-browser` and open the printed URL yourself. |
| Port 8787 is unavailable | Use the printed URL: a free port is selected automatically. `--port` is a preference for a newly started server. |
| No models are available | Open **Settings → Connections**, finish provider setup, ensure the connection is on, and select a model in the composer. |
| Work appears paused | Check for a pending approval or provider sign-in prompt. Reopening a client does not automatically approve anything. |
| The client cannot connect | Confirm you used the same `--kernel` path. Try `npx inhuman web` to start or reuse the services; inspect `harness.log` and `web.log` if startup fails. |
| An installed update still seems to use old daemon behavior | Restart the daemon, then run `web` again. Restarting interrupts active work. |

When reporting a problem, include your OS, Node version (`node --version`), command, and the relevant error. Remove credentials and private conversation or project content from logs first. [Open an issue](https://github.com/here-build/inhuman-harness/issues).

## Remote access (experimental)

Local use does not require remote login. Remote access is an experimental, email-allowlisted sandbox, not a generally available hosted service.

```sh
npx inhuman login
npx inhuman remote status
npx inhuman logout
```

`login` starts the local services if necessary and opens a WorkOS device approval page. Check the displayed code and approve the machine. Then sign in with the same account at [harness.inhuman.tools](https://harness.inhuman.tools) and select your machine. The machine must stay online; the daemon connects outward to the relay, while your machine remains the source of truth.

Anyone signed in as you can control this machine's harness, including tools that run commands. Remote access has no end-to-end encryption, roles, or method allowlist. `logout` disconnects this machine and clears its local remote credentials; it does not revoke the token at WorkOS. See the [remote access documentation](proposals/remote-access.md) for current restrictions and known gaps.
