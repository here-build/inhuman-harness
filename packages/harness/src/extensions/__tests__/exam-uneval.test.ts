import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { jsonToVal } from "../eval.js";
import { callDeclaredTool, loadProgram, type Registry } from "../index.js";
import { Proc, type Val } from "../value.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, "../../../../../plugins/inhuman-plugin-tasks");

function binding(name: string, call: (values: readonly Val[]) => Val): Proc {
  return { name, call };
}

async function probe(body: string, environment: Map<string, Proc>): Promise<Val> {
  const source = [
    "(define/tool 'probe",
    '  :description "probe"',
    "  :expose 'tool",
    '  :input (s/object (s/field "program" (s/string)))',
    "  :handler (lambda (input)",
    `             ${body}))`,
  ].join("\n");
  const registry: Registry = await loadProgram({
    agentId: "probe",
    source,
    filename: "probe.scm",
    revision: "rev",
    root: "/tmp",
    read: () => {
      throw new Error("missing source");
    },
    kind: "behavior",
    environment,
  });
  return callDeclaredTool(registry, "probe", jsonToVal({ program: "" }));
}

describe("exam uneval", () => {
  it("keeps every form of a begin and turns each port into a parameter", async () => {
    const value = await probe(
      '(exam/capture "(begin (read_file \\"a.ts\\") (tasks/write-completion-verdict #t \\"matches\\"))")',
      new Map(),
    );
    expect(value).toBe(
      '(lambda (read_file tasks/write-completion-verdict) (read_file "a.ts") (tasks/write-completion-verdict #t "matches"))',
    );
  });

  it("flattens a nested begin instead of dropping earlier forms", async () => {
    const value = await probe(
      '(exam/capture "(begin (begin (grep \\"id\\" \\"src\\")) (tasks/write-completion-verdict #f \\"no\\"))")',
      new Map(),
    );
    expect(value).toBe(
      '(lambda (grep tasks/write-completion-verdict) (grep "id" "src") (tasks/write-completion-verdict #f "no"))',
    );
  });

  it("stores a stamp that never calls a world port", async () => {
    const source = await probe('(exam/capture "(tasks/write-completion-verdict #t \\"matches\\")")', new Map());
    expect(source).toBe('(lambda (tasks/write-completion-verdict) (tasks/write-completion-verdict #t "matches"))');
  });

  it("stores a world port that never stamps", async () => {
    const source = await probe('(exam/capture "(read_file \\"a.ts\\")")', new Map());
    expect(source).toBe('(lambda (read_file) (read_file "a.ts"))');
  });

  it("runs every captured form and returns the stamp", async () => {
    const seen: string[] = [];
    const environment = new Map<string, Proc>([
      [
        "read_file",
        binding("read_file", () => {
          seen.push("read");
          return "body";
        }),
      ],
      [
        "tasks/write-completion-verdict",
        binding("tasks/write-completion-verdict", (values) => {
          seen.push("stamp");
          return [values[0] === true, typeof values[1] === "string" ? values[1] : ""];
        }),
      ],
    ]);
    const source = await probe(
      '(exam/capture "(begin (read_file \\"a.ts\\") (tasks/write-completion-verdict #t \\"matches\\"))")',
      new Map(),
    );
    const value = await probe(`(exam/apply ${JSON.stringify(source)})`, environment);
    expect(seen).toEqual(["read", "stamp"]);
    expect(value).toEqual([true, "matches"]);
  });

  it("turns every looked-up name in that form into a parameter", async () => {
    const value = await probe(
      '(exam/capture "(tasks/write-completion-verdict (read_file \\"a.ts\\") \\"read\\")")',
      new Map(),
    );
    expect(value).toBe(
      '(lambda (tasks/write-completion-verdict read_file) (tasks/write-completion-verdict (read_file "a.ts") "read"))',
    );
  });

  it("applies the stored lambda with the environment given for this run", async () => {
    const seen: unknown[][] = [];
    const environment = new Map<string, Proc>([
      [
        "tasks/write-completion-verdict",
        binding("tasks/write-completion-verdict", (values) => {
          seen.push([...values]);
          return [values[0] === true, typeof values[1] === "string" ? values[1] : ""];
        }),
      ],
    ]);
    const value = await probe(
      '(exam/apply "(lambda (tasks/write-completion-verdict) (tasks/write-completion-verdict #t \\"matches\\"))")',
      environment,
    );
    expect(seen).toEqual([[true, "matches"]]);
    expect(value).toEqual([true, "matches"]);
  });

  it("refuses to apply when the run did not supply a parameter", async () => {
    await expect(
      probe(
        '(exam/apply "(lambda (tasks/write-completion-verdict) (tasks/write-completion-verdict #t \\"x\\"))")',
        new Map(),
      ),
    ).rejects.toThrow(/exam environment lacks tasks\/write-completion-verdict/);
  });

  it("supplies each parameter from this run, not from the capture", async () => {
    const read =
      '(lambda (read_file tasks/write-completion-verdict) (tasks/write-completion-verdict (read_file "a.ts") "read"))';
    const environment = new Map<string, Proc>([
      ["read_file", binding("read_file", () => "file-body")],
      [
        "tasks/write-completion-verdict",
        binding("tasks/write-completion-verdict", (values) => [values[0] === "file-body", "read"]),
      ],
    ]);
    const value = await probe(`(exam/apply ${JSON.stringify(read)})`, environment);
    expect(value).toEqual([true, "read"]);
  });

  it("captures the tasks create program the same way", async () => {
    const tools = readFileSync(join(TASKS, "behavior/tools.scm"), "utf8");
    const registry = await loadProgram({
      agentId: "tasks",
      source: tools,
      filename: join(TASKS, "behavior/tools.scm"),
      revision: "rev",
      root: TASKS,
      read: (path) => readFileSync(path, "utf8"),
      kind: "behavior",
    });
    expect([...registry.tools.keys()]).toEqual([
      "task__create",
      "task__start",
      "task__drop",
      "task__after",
      "task__validate",
    ]);
    expect([...registry.tools.values()].every((tool) => tool.isSideChannel)).toBe(true);
  });
});
