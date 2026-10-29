import { Command, Option } from "clipanion";

import { KernelCommand } from "./context.js";
import { runMcp, type McpArgv, type McpVerb } from "./mcp.js";

export class McpCommand extends KernelCommand {
  static paths = [["mcp"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "manage MCP connections",
  });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("harness mcp");
    if (blocked !== undefined) return blocked;
    this.context.stderr.write("Specify an mcp command: add, list, get, remove, login, logout, enable, disable\n");
    return 2;
  }
}

export class McpAddCommand extends KernelCommand {
  static paths = [["mcp", "add"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "adopt an MCP connection",
    examples: [
      ["HTTP", "$0 mcp add sentry --url https://mcp.sentry.dev/mcp"],
      ["stdio", "$0 mcp add airtable -- npx -y airtable-mcp-server"],
    ],
  });

  name = Option.String();
  url = Option.String("--url", { description: "HTTP MCP server URL" });
  tokenEnv = Option.String("--token-env", { description: "env var copied into secrets.token" });
  login = Option.Boolean("--login", false, {
    description: "OAuth login after HTTP add (TTY)",
  });
  rest = Option.Rest({ name: "command" });

  async execute(): Promise<number> {
    return mcp(this, "add", {
      name: this.name,
      url: this.url,
      tokenEnv: this.tokenEnv,
      login: this.login,
      "--": this.rest,
    });
  }
}

export class McpListCommand extends KernelCommand {
  static paths = [["mcp", "list"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "list MCP connections",
  });

  json = Option.Boolean("--json", false, { description: "print JSON" });

  async execute(): Promise<number> {
    return mcp(this, "list", { json: this.json });
  }
}

export class McpGetCommand extends KernelCommand {
  static paths = [["mcp", "get"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "show one MCP connection",
  });

  name = Option.String();
  json = Option.Boolean("--json", false, { description: "print JSON" });

  async execute(): Promise<number> {
    return mcp(this, "get", { name: this.name, json: this.json });
  }
}

export class McpRemoveCommand extends KernelCommand {
  static paths = [["mcp", "remove"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "drop an MCP connection (no prompt)",
  });

  name = Option.String();

  async execute(): Promise<number> {
    return mcp(this, "remove", { name: this.name });
  }
}

export class McpLoginCommand extends KernelCommand {
  static paths = [["mcp", "login"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "authorize an MCP connection",
  });

  name = Option.String();
  browser = Option.Boolean("--browser", true, { description: "open the authorize URL" });

  async execute(): Promise<number> {
    return mcp(this, "login", {
      name: this.name,
      browser: this.browser,
      noBrowser: this.browser === false,
    });
  }
}

export class McpLogoutCommand extends KernelCommand {
  static paths = [["mcp", "logout"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "clear OAuth secrets",
  });

  name = Option.String();

  async execute(): Promise<number> {
    return mcp(this, "logout", { name: this.name });
  }
}

export class McpEnableCommand extends KernelCommand {
  static paths = [["mcp", "enable"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "enable an MCP connection",
  });

  name = Option.String();

  async execute(): Promise<number> {
    return mcp(this, "enable", { name: this.name });
  }
}

export class McpDisableCommand extends KernelCommand {
  static paths = [["mcp", "disable"]];
  static usage = Command.Usage({
    category: "MCP",
    description: "disable an MCP connection",
  });

  name = Option.String();

  async execute(): Promise<number> {
    return mcp(this, "disable", { name: this.name });
  }
}

async function mcp(cmd: KernelCommand, verb: McpVerb, args: Omit<McpArgv, "kernel" | "mcpVerb">): Promise<number> {
  const blocked = cmd.rejectUnsupportedAgentFlags(`harness mcp ${verb}`);
  if (blocked !== undefined) return blocked;
  const result = await runMcp(
    {
      kernel: cmd.kernelPath(),
      mcpVerb: verb,
      ...args,
    },
    cmd.context,
  );
  return result.code;
}
