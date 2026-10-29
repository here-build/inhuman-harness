import { describe, expect, it } from "vitest";

import { KernelToolCatalog } from "@/tool-catalog";

import { NAMED_AGENT_BOTS, SYSTEM_ENTRIES, peelAgentCallArgs } from "../index.js";

describe("builtin registrations", () => {
  it("catalog starts empty; composition supplies the roster", () => {
    const catalog = new KernelToolCatalog();
    expect({
      before: catalog.catalogWireNames(),
      execute: catalog.catalogEntry("read_file")?.execute,
    }).toEqual({ before: [], execute: undefined });

    catalog.replacePack(SYSTEM_ENTRIES);

    const classes = Object.fromEntries(catalog.catalogEntries().map((entry) => [entry.wireName, entry.class]));
    const explore = NAMED_AGENT_BOTS.find((bot) => bot.name === "explore");
    expect(classes).toEqual({
      read_file: "read",
      list_dir: "read",
      grep: "read",
      glob: "read",
      fff_search: "read",
      job_stop: "meta",
      write_file: "write",
      edit_file: "write",
      shell: "effect",
      update_metadata: "meta",
      context_need: "meta",
      context_recall: "read",
      scheme_repl: "effect",
      scheme_watch: "effect",
      web_search: "effect",
      web_extract: "effect",
      agent__respond: "effect",
      agent__void: "effect",
      agent__notify: "effect",
      agent__message: "effect",
      agent__send: "effect",
      agent__ask: "effect",
    });
    expect(explore?.description).toMatch(/read-only/);
    expect(catalog.catalogEntry("task__create")).toBeUndefined();
    expect({
      meta: catalog.catalogEntry("update_metadata")?.isSideChannel,
      need: catalog.catalogEntry("context_need")?.isSideChannel,
      read: catalog.catalogEntry("read_file")?.isSideChannel,
    }).toEqual({ meta: true, need: true, read: false });
    expect(Object.fromEntries(catalog.catalogEntries().map((entry) => [entry.wireName, entry.representation]))).toEqual(
      {
        read_file: "symbol",
        list_dir: "symbol",
        grep: "symbol",
        glob: "symbol",
        fff_search: "symbol",
        job_stop: "symbol",
        write_file: "both",
        edit_file: "both",
        shell: "both",
        update_metadata: "both",
        context_need: "both",
      context_recall: "both",
        scheme_repl: "tool",
        scheme_watch: "tool",
        web_search: "symbol",
        web_extract: "symbol",
        agent__respond: "tool",
        agent__void: "symbol",
        agent__notify: "symbol",
        agent__message: "symbol",
        agent__send: "symbol",
        agent__ask: "symbol",
      },
    );
  });

  it("effect bodies attach; orchestration rows stay projection-only", () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack(SYSTEM_ENTRIES);
    expect({
      read: typeof catalog.catalogEntry("read_file")?.execute,
      write: typeof catalog.catalogEntry("write_file")?.execute,
      shell: typeof catalog.catalogEntry("shell")?.execute,
      metadata: typeof catalog.catalogEntry("update_metadata")?.execute,
      scheme: catalog.catalogEntry("scheme_repl")?.execute,
      watch: catalog.catalogEntry("scheme_watch")?.execute,
      search: catalog.catalogEntry("web_search")?.execute,
      extract: catalog.catalogEntry("web_extract")?.execute,
      ask: catalog.catalogEntry("agent__ask")?.execute,
    }).toEqual({
      read: "function",
      write: "function",
      shell: "function",
      metadata: "function",
      scheme: undefined,
      watch: undefined,
      search: undefined,
      extract: undefined,
      ask: undefined,
    });
  });

  it("peelAgentCallArgs drops ask flags from the message bag", () => {
    const peeled = peelAgentCallArgs(
      JSON.stringify({
        spec: "echo",
        message: "hi",
        oneShot: true,
        readonly: true,
      }),
    );
    expect({
      oneShot: peeled.oneShot,
      readonly: peeled.readonly,
      dump: JSON.parse(peeled.argsJson),
      defaultOneShot: peelAgentCallArgs(JSON.stringify({ spec: "echo", message: "hi" })).oneShot,
    }).toEqual({
      oneShot: true,
      readonly: true,
      dump: { spec: "echo", message: "hi" },
      defaultOneShot: false,
    });
  });
});
