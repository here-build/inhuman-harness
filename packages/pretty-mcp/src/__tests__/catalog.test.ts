import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  candidateFromCalibrated,
  catalogIndex,
  catalogSlug,
  fileFromServer,
  generateCatalog,
  installedCatalogDir,
  lookupCatalogTool,
  uncoveredFrom,
  uncoveredSerializersFrom,
} from "../catalog.js";
import { renderMustache, renderTool, splitIdentity } from "../render.js";
import { isCovered, isSerializerCovered, optsSchemaFromArgs, validateOpts } from "../schema.js";
import { TOOLKIT } from "../toolkit.js";
import type { Calibration, CatalogFile, CatalogTool } from "../types.js";

const PATH_ARG = {
  name: "path",
  type: "string",
  required: true,
  description: "File path",
};

describe("optsSchemaFromArgs", () => {
  it("marks required and keeps additionalProperties", () => {
    expect(
      optsSchemaFromArgs([PATH_ARG, { name: "limit", type: "integer", required: false, description: "" }]),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: true,
    });
  });
});

describe("validateOpts", () => {
  const schema = optsSchemaFromArgs([PATH_ARG]);

  it("accepts the required string", () => {
    expect(validateOpts(schema, { path: "a.ts" })).toEqual([]);
  });

  it("rejects missing and wrong types", () => {
    expect(validateOpts(schema, {})).toEqual(["missing path"]);
    expect(validateOpts(schema, { path: 1 })).toEqual(["path should be string"]);
  });
});

describe("coverage merge", () => {
  it("keeps question/effect/serializer when schemas refresh", () => {
    const previous: CatalogTool = {
      description: "old",
      opts: { type: "object" },
      question: "Read **{{path}}**?",
      effect: "Read **{{path}}**",
      result: { schema: null, serializer: "ok" },
    };
    const next = candidateFromCalibrated({ name: "read_file", description: "new", args: [PATH_ARG] }, previous);
    expect(next.description).toBe("new");
    expect(next.question).toBe("Read **{{path}}**?");
    expect(next.effect).toBe("Read **{{path}}**");
    expect(next.result.serializer).toBe("ok");
    expect(next.opts).toEqual(optsSchemaFromArgs([PATH_ARG]));
  });

  it("marks tools missing from calibration stale", () => {
    const previous: CatalogFile = {
      id: "s",
      displayName: "S",
      source: "smithery",
      description: "",
      tools: {
        gone: {
          description: "",
          opts: {},
          question: "x?",
          effect: "x",
          result: { schema: null, serializer: null },
        },
        stay: {
          description: "",
          opts: {},
          question: null,
          effect: null,
          result: { schema: null, serializer: null },
        },
      },
    };
    const next = fileFromServer(
      {
        id: "s",
        displayName: "S",
        source: "smithery",
        description: "",
        tools: [{ name: "stay", description: "d", args: [] }],
      },
      previous,
    );
    expect(next.tools.gone?.stale).toBe(true);
    expect(next.tools.gone?.question).toBe("x?");
    expect(next.tools.stay?.stale).toBeUndefined();
  });
});

describe("uncoveredFrom", () => {
  it("skips covered tools and includes missing catalog rows", () => {
    // @ts-expect-error partial fixture: uncoveredFrom only reads servers/counts
    const calibration = {
      servers: [TOOLKIT],
      counts: { tools: TOOLKIT.tools.length },
    } as Calibration;
    const catalog = new Map<string, CatalogFile>([
      [
        TOOLKIT.id,
        fileFromServer(TOOLKIT, {
          id: TOOLKIT.id,
          displayName: TOOLKIT.displayName,
          source: TOOLKIT.source,
          description: TOOLKIT.description,
          tools: {
            read_file: {
              description: "",
              opts: {},
              question: "Read **{{path}}**?",
              effect: "Read **{{path}}**",
              result: { schema: null, serializer: null },
            },
          },
        }),
      ],
    ]);
    const rows = uncoveredFrom(calibration, catalog);
    expect(rows.some((row) => row.tool === "read_file")).toBe(false);
    expect(rows.some((row) => row.tool === "grep")).toBe(true);
    expect(rows[0]?.opts).toBeDefined();
    const serializers = uncoveredSerializersFrom(calibration, catalog);
    expect(serializers.some((row) => row.tool === "read_file")).toBe(true);
    expect(serializers.some((row) => row.tool === "grep")).toBe(false);
  });
});

describe("renderTool", () => {
  const tool: CatalogTool = {
    description: "",
    opts: optsSchemaFromArgs([PATH_ARG]),
    question: "Read **{{path}}**?",
    effect: "Read **{{path}}**",
    result: { schema: null, serializer: "{{#ok}}exit {{value.exitCode}}{{/ok}}{{^ok}}{{text}}{{/ok}}" },
  };

  it("emits markdown and does not HTML-escape", () => {
    expect(renderTool(tool, "question", { path: "a<b>.md" })).toEqual({
      ok: true,
      markdown: "Read **a<b>.md**?",
    });
    expect(renderTool(tool, "effect", { path: "a.md" })).toEqual({
      ok: true,
      markdown: "Read **a.md**",
    });
    expect(renderTool(tool, "result", {}, { ok: true, value: { exitCode: 0, stdout: "", stderr: "" } })).toEqual({
      ok: true,
      markdown: "exit 0",
    });
  });

  it("refuses invalid opts and empty templates", () => {
    expect(renderTool(tool, "question", {})).toEqual({ ok: false, error: "missing path" });
    expect(renderTool({ ...tool, question: null }, "question", { path: "a.md" })).toEqual({
      ok: false,
      error: "uncovered question",
    });
  });

  it("lifts a JSON-string MCP value so named fields print", () => {
    const named: CatalogTool = {
      ...tool,
      result: {
        schema: null,
        serializer:
          "{{#ok}}**{{value.subject}}** {{#value.from}}**{{value.from}}**{{/value.from}}{{#value.from_}}**{{value.from_}}**{{/value.from_}}{{#value.body}}\n{{value.body}}{{/value.body}}{{/ok}}{{^ok}}{{text}}{{/ok}}",
      },
    };
    expect(
      renderTool(named, "result", {}, { ok: true, value: '{"subject":"hi","from_":"a@b.c","body":"yo"}' }),
    ).toEqual({ ok: true, markdown: "**hi** **a@b.c**\nyo" });
  });

  it("lifts an MCP text-block array into result objects", () => {
    const web: CatalogTool = {
      ...tool,
      result: {
        schema: null,
        serializer: "{{#ok}}{{#value}}**{{title}}** {{url}}\n{{description}}\n{{/value}}{{/ok}}",
      },
    };
    const rendered = renderTool(
      web,
      "result",
      {},
      {
        ok: true,
        value: [
          { type: "text", text: '{"title":"A","url":"https://a.example","description":"one"}' },
          { type: "text", text: '{"title":"B","url":"https://b.example","description":"two"}' },
        ],
      },
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(splitIdentity(rendered.markdown)).toEqual({
      line: "**A** https://a.example",
      block: "one\n**B** https://b.example\ntwo",
    });
  });

  it("prints screenshot results as markdown images, preferring a path over bytes", () => {
    const image: CatalogTool = {
      ...tool,
      result: {
        schema: null,
        serializer:
          "{{#ok}}{{#value.images}}![]({{src}})\n{{/value.images}}{{#value.texts}}\n{{.}}{{/value.texts}}{{^value.images}}{{value}}{{/value.images}}{{/ok}}{{^ok}}{{text}}{{/ok}}",
      },
    };
    const mixed = renderTool(
      image,
      "result",
      {},
      {
        ok: true,
        value: [
          { type: "text", text: "- [Screenshot of viewport](output/page.png)" },
          { type: "image", mimeType: "image/png", data: "iVBOR-not-on-the-line" },
        ],
      },
    );
    expect(mixed).toEqual({ ok: true, markdown: "![](output/page.png)\n" });
    expect(mixed.ok && mixed.markdown.includes("iVBOR")).toBe(false);

    const bytes = renderTool(
      image,
      "result",
      {},
      {
        ok: true,
        value: [{ type: "image", mimeType: "image/png", data: "abc" }],
      },
    );
    expect(bytes).toEqual({ ok: true, markdown: "![](data:image/png;base64,abc)\n" });

    const annotated = renderTool(
      image,
      "result",
      {},
      {
        ok: true,
        value: [
          { type: "text", text: '[annotated](output/ann.png)\n### Page\n- heading "Example"' },
          { type: "image", mimeType: "image/png", data: "abc" },
        ],
      },
    );
    expect(annotated.ok).toBe(true);
    if (!annotated.ok) return;
    expect(splitIdentity(annotated.markdown)).toEqual({
      line: "![](output/ann.png)",
      block: '### Page\n- heading "Example"',
    });
  });
});

describe("splitIdentity", () => {
  const send =
    "send{{#subject}} **{{subject}}**{{/subject}}{{#recipient}} to **{{recipient}}**{{/recipient}}?{{#body}}\n**{{body}}**{{/body}}{{#cc}}\ncc **{{.}}**{{/cc}}";

  it("keeps a no-extra call as one line", () => {
    const markdown = renderMustache(send, { subject: "hi", recipient: "a@b.c" });
    expect(splitIdentity(markdown)).toEqual({
      line: "send **hi** to **a@b.c**?",
      block: "",
    });
  });

  it("puts contents and cc on the block, not the headline", () => {
    const markdown = renderMustache(send, {
      subject: "hi",
      recipient: "a@b.c",
      body: "yo",
      cc: ["x@y.z", "w@w.w"],
    });
    expect(splitIdentity(markdown)).toEqual({
      line: "send **hi** to **a@b.c**?",
      block: "**yo**\ncc **x@y.z**\ncc **w@w.w**",
    });
  });

  it("puts edit old/new on the block and all- on the verb", () => {
    const edit =
      "{{#replace_all}}all-{{/replace_all}}edit **{{path}}**?{{#old_string}}\n**{{old_string}}**{{/old_string}}{{#new_string}}\n**{{new_string}}**{{/new_string}}";
    expect(splitIdentity(renderMustache(edit, { path: "src/a.ts" }))).toEqual({
      line: "edit **src/a.ts**?",
      block: "",
    });
    expect(
      splitIdentity(
        renderMustache(edit, {
          path: "src/a.ts",
          old_string: "old",
          new_string: "new",
          replace_all: true,
        }),
      ),
    ).toEqual({
      line: "all-edit **src/a.ts**?",
      block: "**old**\n**new**",
    });
  });

  it("puts write contents and shell cwd on the block", () => {
    const write = lookupCatalogTool(catalogIndex(installedCatalogDir()), "harness-toolkit", "write_file");
    expect(write?.question).toBe(
      "{{#existed}}update{{/existed}}{{^existed}}create{{/existed}} **{{path}}**?{{#content}}\n**{{content}}**{{/content}}",
    );
    expect(write?.effect).toBe(
      "{{#existed}}updated{{/existed}}{{^existed}}created{{/existed}} **{{path}}**{{#content}}\n**{{content}}**{{/content}}",
    );
    expect(splitIdentity(renderMustache(write!.question!, { path: "a.ts", content: "hi" }))).toEqual({
      line: "create **a.ts**?",
      block: "**hi**",
    });
    expect(splitIdentity(renderMustache(write!.question!, { path: "a.ts", content: "hi", existed: false }))).toEqual({
      line: "create **a.ts**?",
      block: "**hi**",
    });
    expect(splitIdentity(renderMustache(write!.question!, { path: "a.ts", content: "hi", existed: true }))).toEqual({
      line: "update **a.ts**?",
      block: "**hi**",
    });
    expect(splitIdentity(renderMustache(write!.effect!, { path: "a.ts", content: "hi" }))).toEqual({
      line: "created **a.ts**",
      block: "**hi**",
    });
    expect(splitIdentity(renderMustache(write!.effect!, { path: "a.ts", content: "hi", existed: true }))).toEqual({
      line: "updated **a.ts**",
      block: "**hi**",
    });
    expect(
      splitIdentity(renderMustache(write!.question!, { path: "a.ts", content: "hi", description: "Add greeting" })),
    ).toEqual({ line: "create **a.ts**?", block: "**hi**" });
    const shell = "run `{{command}}`?{{#cwd}}\nin **{{cwd}}**{{/cwd}}";
    expect(splitIdentity(renderMustache(shell, { command: "ls", cwd: "packages" }))).toEqual({
      line: "run `ls`?",
      block: "in **packages**",
    });
    expect(splitIdentity(renderMustache(shell, { command: "ls", description: "list files" }))).toEqual({
      line: "run `ls`?",
      block: "",
    });
  });

  it("puts shell stdout on the result block", () => {
    const serializer =
      "{{#ok}}exit {{value.exitCode}}{{#value.stdout}}\n{{value.stdout}}{{/value.stdout}}{{#value.stderr}}\nstderr {{value.stderr}}{{/value.stderr}}{{/ok}}{{^ok}}{{text}}{{/ok}}";
    expect(
      splitIdentity(
        renderMustache(serializer, {
          ok: true,
          value: { exitCode: 0, stdout: "hi", stderr: "" },
        }),
      ),
    ).toEqual({ line: "exit 0", block: "hi" });
    expect(
      splitIdentity(
        renderMustache(serializer, {
          ok: false,
          text: "shell cwd does not exist: missing",
        }),
      ),
    ).toEqual({ line: "shell cwd does not exist: missing", block: "" });
  });

  it("puts MCP text-block value on the result line/block", () => {
    const serializer = "{{#ok}}{{value}}{{/ok}}{{^ok}}{{text}}{{/ok}}";
    expect(splitIdentity(renderMustache(serializer, { ok: true, value: '### Page\n- heading "Example"' }))).toEqual({
      line: "### Page",
      block: '- heading "Example"',
    });
    expect(splitIdentity(renderMustache(serializer, { ok: false, text: "mcp: tool reported failure" }))).toEqual({
      line: "mcp: tool reported failure",
      block: "",
    });
    expect(renderMustache(serializer, { ok: true, text: "should-not-print" })).toBe("");
  });
});

describe("generateCatalog", () => {
  it("writes a server file and preserves templates on the second pass", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pretty-mcp-"));
    // @ts-expect-error partial fixture: generateCatalog only reads servers
    const calibration = {
      servers: [TOOLKIT],
      counts: { tools: TOOLKIT.tools.length },
    } as Calibration;
    await writeFile(
      path.join(dir, "harness-toolkit.json"),
      `${JSON.stringify({
        id: TOOLKIT.id,
        displayName: TOOLKIT.displayName,
        source: TOOLKIT.source,
        description: TOOLKIT.description,
        tools: {
          read_file: {
            description: "x",
            opts: {},
            question: "Read **{{path}}**?",
            effect: "Read **{{path}}**",
            result: { schema: null, serializer: null },
          },
        },
      } satisfies CatalogFile)}\n`,
    );
    const first = await generateCatalog(calibration, dir);
    expect(first.written).toBe(1);
    expect(first.covered).toBe(1);
    expect(first.uncovered).toBe(TOOLKIT.tools.length - 1);
    const second = await generateCatalog(calibration, dir);
    expect(second.covered).toBe(1);
  });
});

describe("catalogIndex", () => {
  it("loads the shipped toolkit and looks up by id", () => {
    const index = catalogIndex(installedCatalogDir());
    const glob = lookupCatalogTool(index, "harness-toolkit", "glob");
    expect(glob?.question).toContain("{{pattern}}");
    expect(lookupCatalogTool(index, "Harness dist toolkit", "read_file")?.effect).toContain("{{path}}");
    expect(lookupCatalogTool(index, "missing", "glob")).toBeUndefined();
  });
});

describe("task notebook wires", () => {
  const index = catalogIndex(installedCatalogDir());

  it("covers create/start/drop/validate with subject or taskId identity", () => {
    const create = lookupCatalogTool(index, "harness-toolkit", "task__create");
    const start = lookupCatalogTool(index, "harness-toolkit", "task__start");
    const drop = lookupCatalogTool(index, "harness-toolkit", "task__drop");
    const after = lookupCatalogTool(index, "harness-toolkit", "task__after");
    const validate = lookupCatalogTool(index, "harness-toolkit", "task__validate");
    expect({
      createQ: create?.question,
      createE: create?.effect,
      startQ: start?.question,
      startE: start?.effect,
      dropQ: drop?.question,
      dropE: drop?.effect,
      afterQ: after?.question,
      afterE: after?.effect,
      validateQ: validate?.question,
      validateE: validate?.effect,
    }).toEqual({
      createQ:
        "create **{{subject}}**?{{#description}}\n{{description}}{{/description}}{{#activeForm}}\nform **{{activeForm}}**{{/activeForm}}{{#activationBrief}}\nbrief **{{activationBrief}}**{{/activationBrief}}{{#validationProgram}}\nprogram `{{validationProgram}}`{{/validationProgram}}",
      createE:
        "created **{{subject}}**{{#description}}\n{{description}}{{/description}}{{#activeForm}}\nform **{{activeForm}}**{{/activeForm}}{{#activationBrief}}\nbrief **{{activationBrief}}**{{/activationBrief}}{{#validationProgram}}\nprogram `{{validationProgram}}`{{/validationProgram}}",
      startQ: "start `{{taskId}}`?",
      startE: "started `{{taskId}}`",
      dropQ: "drop `{{taskId}}`?{{#reason}}\n{{reason}}{{/reason}}",
      dropE: "dropped `{{taskId}}`{{#reason}}\n{{reason}}{{/reason}}",
      afterQ: "after `{{taskId}}` `{{after}}`?",
      afterE: "after `{{taskId}}` `{{after}}`",
      validateQ: "{{#background}}background-{{/background}}validate `{{taskId}}`?",
      validateE: "{{#background}}background-{{/background}}validated `{{taskId}}`",
    });
    expect(create?.result.serializer).toBe("{{text}}");
    expect(start?.result.serializer).toContain("{{value.subject}}");
    expect(drop?.result.serializer).toBe("{{text}}");
    expect(after?.result.serializer).toBe("{{text}}");
    expect(validate?.result.serializer).toContain("{{#value}}");
  });

  it("prints subject/taskId on the line and extras on the block", () => {
    const create = lookupCatalogTool(index, "harness-toolkit", "task__create")!;
    const start = lookupCatalogTool(index, "harness-toolkit", "task__start")!;
    const drop = lookupCatalogTool(index, "harness-toolkit", "task__drop")!;
    const after = lookupCatalogTool(index, "harness-toolkit", "task__after")!;
    const validate = lookupCatalogTool(index, "harness-toolkit", "task__validate")!;
    expect(
      splitIdentity(
        renderMustache(create.question!, {
          subject: "Fix auth",
          description: "durable spec",
          validationProgram: '(read_file "a.ts")',
        }),
      ),
    ).toEqual({
      line: "create **Fix auth**?",
      block: 'durable spec\nprogram `(read_file "a.ts")`',
    });
    expect(
      splitIdentity(
        renderMustache(create.question!, {
          subject: "Fix auth",
          activeForm: "fixing auth",
          activationBrief: "do it",
          validationProgram: '(read_file "a.ts")',
        }),
      ),
    ).toEqual({
      line: "create **Fix auth**?",
      block: `form **fixing auth**\nbrief **do it**\nprogram \`(read_file "a.ts")\``,
    });
    expect(splitIdentity(renderMustache(create.effect!, { subject: "Fix auth" }))).toEqual({
      line: "created **Fix auth**",
      block: "",
    });
    expect(splitIdentity(renderMustache(start.question!, { taskId: "t1" }))).toEqual({
      line: "start `t1`?",
      block: "",
    });
    expect(splitIdentity(renderMustache(drop.question!, { taskId: "t1", reason: "stale" }))).toEqual({
      line: "drop `t1`?",
      block: "stale",
    });
    expect(splitIdentity(renderMustache(after.question!, { taskId: "t1", after: "t0" }))).toEqual({
      line: "after `t1` `t0`?",
      block: "",
    });
    expect(splitIdentity(renderMustache(validate.question!, { taskId: "t1" }))).toEqual({
      line: "validate `t1`?",
      block: "",
    });
    expect(splitIdentity(renderMustache(validate.effect!, { taskId: "t1", background: true }))).toEqual({
      line: "background-validated `t1`",
      block: "",
    });
    expect(renderMustache(create.question!, { subject: "Fix auth" })).not.toMatch(/todo/i);
    expect(
      renderTool(
        create,
        "result",
        { subject: "Fix auth", description: "d", validationProgram: '(read_file "a.ts")' },
        { ok: true, text: "id-1" },
      ),
    ).toEqual({ ok: true, markdown: "id-1" });
    expect(
      renderTool(
        start,
        "result",
        { taskId: "t1" },
        { ok: true, value: { subject: "Fix auth", activationBrief: "do it" } },
      ),
    ).toEqual({ ok: true, markdown: "**Fix auth**\ndo it" });
    expect(renderTool(drop, "result", { taskId: "t1", reason: "stale" }, { ok: true })).toEqual({
      ok: true,
      markdown: "",
    });
    expect(renderTool(validate, "result", { taskId: "t1" }, { ok: true, value: [true, "looked"] })).toEqual({
      ok: true,
      markdown: "true\nlooked\n",
    });
    expect(
      renderTool(validate, "result", { taskId: "t1" }, { ok: false, text: "cannot validate pending task: t1" }),
    ).toEqual({
      ok: true,
      markdown: "cannot validate pending task: t1",
    });
  });
});

describe("catalogSlug / isCovered", () => {
  it("flattens slashes", () => {
    expect(catalogSlug("@github/mcp")).toBe("@github__mcp");
  });

  it("needs both templates", () => {
    expect(isCovered("q?", "e")).toBe(true);
    expect(isCovered("q?", null)).toBe(false);
    expect(isCovered("  ", "e")).toBe(false);
    expect(isSerializerCovered("exit {{value.exitCode}}")).toBe(true);
    expect(isSerializerCovered(null)).toBe(false);
  });
});
