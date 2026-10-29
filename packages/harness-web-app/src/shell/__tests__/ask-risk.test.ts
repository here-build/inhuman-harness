import { describe, expect, it } from "vitest";

import { askHeading, askRisk, type AskAct } from "../ask-risk.js";

const project = "/Users/ada/work/harness";

function act(name: string, args: Record<string, unknown> | null, extra: Partial<AskAct> = {}): AskAct {
  return { name, args, projectPath: project, ...extra };
}

describe("ask heading", () => {
  it("names a shell by the project directory", () => {
    expect(askHeading(act("shell", { command: "pnpm test" }))).toBe("Run a command in harness");
    expect(askHeading(act("shell", { command: "pwd" }, { projectPath: "" }))).toBe("Run a command in this project");
  });

  it("names an edit, a create, and a delete by the file", () => {
    expect(askHeading(act("edit_file", { path: "src/styles.css" }))).toBe("Edit styles.css");
    expect(askHeading(act("write_file", { path: "src/a.ts" }, { existed: false }))).toBe("Create a.ts");
    expect(askHeading(act("write_file", { path: "src/a.ts" }, { existed: true }))).toBe("Edit a.ts");
    expect(askHeading(act("delete_file", { path: "src/old.ts" }))).toBe("Delete old.ts");
    expect(askHeading(act("edit_file", {}))).toBe("Edit a file");
  });

  it("uses the tool label, or the raw name when that label is the name", () => {
    expect(askHeading(act("mcp__github__create_issue", { title: "Composer edge" }))).toBe(
      "Use mcp__github__create_issue",
    );
    expect(
      askHeading(act("mcp__github__create_issue", {}), (name) =>
        name.endsWith("create_issue") ? "Create issue" : name,
      ),
    ).toBe("Use Create issue");
    expect(askHeading(act("  ", null))).toBe("Pending action");
  });
});

describe("ask risk", () => {
  const phrase = (command: string): string => askRisk(act("shell", { command })).phrase;

  it("flags the destructive shell forms and keeps ordinary commands quiet", () => {
    expect(phrase("rm -rf dist && pnpm build")).toBe("This deletes files.");
    expect(phrase("rm -r dist")).toBe("This deletes files.");
    expect(phrase("rm -fr /tmp/out")).toBe("This deletes files.");
    expect(phrase("/bin/rm --recursive dist")).toBe("This deletes files.");
    expect(phrase("rm file.txt")).toBe("");
    expect(phrase("rm -- -rf")).toBe("");
    expect(phrase('echo "rm -rf /"')).toBe("");
    expect(phrase("git clean -fd")).toBe("This deletes untracked files.");
    expect(phrase("git clean -n")).toBe("");
    expect(phrase("mkfs.ext4 /dev/sda")).toBe("This erases a disk.");
    expect(phrase("dd if=/dev/zero of=/dev/sda")).toBe("This overwrites raw bytes.");
    expect(phrase("git reset --hard HEAD")).toBe("This discards local changes.");
    expect(phrase("git push --force origin main")).toBe("This rewrites remote history.");
    expect(phrase("git push -f")).toBe("This rewrites remote history.");
    expect(phrase("git push --force-with-lease")).toBe("");
    expect(phrase("git push -u origin main")).toBe("");
    expect(phrase("chmod -R 755 src")).toBe("This changes permissions recursively.");
    expect(phrase("chmod 644 src/a.ts")).toBe("");
    expect(phrase("sudo ls")).toBe("This runs as root.");
    expect(phrase("sudo rm -rf /tmp/out")).toBe("This deletes files.");
    expect(phrase("bash -c 'rm -rf dist'")).toBe("This deletes files.");
    expect(phrase("pnpm test")).toBe("");
  });

  it("flags a delete or a write that leaves the project, and not one that stays", () => {
    expect(askRisk(act("delete_file", { path: "/etc/passwd" })).phrase).toBe("This deletes files outside the project.");
    expect(askRisk(act("delete_file", { path: "src/old.ts" })).destructive).toBe(false);
    expect(askRisk(act("write_file", { path: "../secret" })).phrase).toBe("This writes outside the project.");
    expect(askRisk(act("edit_file", { path: "src/styles.css" })).destructive).toBe(false);
    expect(askRisk(act("write_file", { path: "/etc/passwd" }, { projectPath: "" })).destructive).toBe(false);
  });
});
