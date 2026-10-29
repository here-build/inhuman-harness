import { describe, expect, it } from "vitest";

import { defaultPolicy, bindPolicy } from "../bind.js";
import { CLASS_IDS, CLASSES, isClassId } from "../classes.js";
import { PolicyCompileError } from "../compile.js";
import { reasonableDefaults } from "../reasonable-defaults.js";
import { classesOf } from "../types.js";

const classes = (command: string) => classesOf(defaultPolicy.explainBash(command));

describe("class taxonomy", () => {
  it("is closed and every class has a label and a description", () => {
    expect(Object.keys(CLASSES).toSorted()).toEqual([...CLASS_IDS].toSorted());
    for (const id of CLASS_IDS) {
      expect(CLASSES[id].label).not.toBe("");
      expect(CLASSES[id].description).not.toBe("");
    }
  });
  it("does not accept tier names as classes", () => {
    expect(isClassId("risky")).toBe(false);
    expect(isClassId("general")).toBe(false);
    expect(isClassId("soft-deny")).toBe(false);
  });
});

describe("compile: classes", () => {
  it("refuses an unknown class id", () => {
    expect(() => bindPolicy({ bash: { policy: "ask", class: "made-up" } })).toThrow(PolicyCompileError);
    expect(() =>
      bindPolicy({ bash: { policy: "ask", subcommands: { x: { policy: "deny", class: "risky" } } } }),
    ).toThrow(/unknown class risky/);
    expect(() => bindPolicy({ write_block: [{ path: "x", class: "nope" }] })).toThrow(/unknown class/);
    expect(() => bindPolicy({ read_miss_class: "nope" })).toThrow(/unknown class/);
  });
  it("inherits matcher, then node, then ancestor, then the root default", () => {
    const policy = bindPolicy({
      bash: {
        policy: "ask",
        subcommands: {
          a: { policy: "deny", class: "publish", subcommands: { b: "deny" } },
          c: { policy: "ask", matcher: [{ tok: "x", policy: "deny", class: "privilege" }] },
          d: "deny",
        },
      },
    });
    expect(classesOf(policy.explainBash("a"))).toEqual(["publish"]);
    expect(classesOf(policy.explainBash("a b"))).toEqual(["publish"]);
    expect(classesOf(policy.explainBash("c x"))).toEqual(["privilege"]);
    expect(classesOf(policy.explainBash("d"))).toEqual(["exec-unknown"]);
    expect(classesOf(policy.explainBash("zzz"))).toEqual(["exec-unknown"]);
  });
  it("asserts expect_class in assume", () => {
    const doc = (cls: string) => ({
      bash: { policy: "ask", subcommands: { a: { policy: "deny", class: "publish" } } },
      assume: [{ command: "a", expect: "deny", expect_class: cls }],
    });
    expect(() => bindPolicy(doc("publish"))).not.toThrow();
    expect(() => bindPolicy(doc("privilege"))).toThrow(/expected class privilege/);
  });
  it("tags path rules with list defaults and object items", () => {
    const policy = bindPolicy({
      read_file: ["."],
      read_block: [".env", { path: ".kube", class: "control-plane" }],
      write_file: [".", "!package.json", { path: "!ci", class: "control-plane" }],
      write_block: [".husky", { path: ".netrc", class: "credential" }],
    });
    expect(classesOf(policy.explainRead(".env"))).toEqual(["credential"]);
    expect(classesOf(policy.explainRead(".kube/config"))).toEqual(["control-plane"]);
    expect(classesOf(policy.explainRead("/etc/passwd"))).toEqual(["envelope-read"]);
    expect(classesOf(policy.explainWrite("src/a.ts"))).toEqual(["workspace-write"]);
    expect(classesOf(policy.explainWrite("package.json"))).toEqual(["protected-file"]);
    expect(classesOf(policy.explainWrite("ci"))).toEqual(["control-plane"]);
    expect(classesOf(policy.explainWrite(".husky/pre-commit"))).toEqual(["control-plane"]);
    expect(classesOf(policy.explainWrite(".netrc"))).toEqual(["credential"]);
    expect(classesOf(policy.explainWrite("/etc/x"))).toEqual(["envelope-write"]);
    expect(classesOf(policy.explainWrite("a/../b"))).toEqual(["unmodelled"]);
  });
});

/** Walk the dist document: every deny/ask/block node, matcher and path item resolves to a class. */
describe("dist floor classes (Appendix A)", () => {
  type Node = Record<string, unknown>;
  const rows: Array<[string, string]> = [];
  function walk(node: unknown, path: string, inherited: string | undefined): void {
    if (typeof node === "string") {
      if (node !== "approve") rows.push([path, inherited ?? "MISSING"]);
      return;
    }
    const n = node as Node;
    const cls = (n.class as string | undefined) ?? inherited;
    if (n.policy !== undefined && n.policy !== "approve") rows.push([path, cls ?? "MISSING"]);
    const matchers = (m: unknown, at: string, from: string | undefined) => {
      for (const item of (m as Node[] | undefined) ?? []) {
        const mc = (item.class as string | undefined) ?? from;
        if (item.policy !== undefined && item.policy !== "approve") rows.push([`${at}[matcher]`, mc ?? "MISSING"]);
        matchers(item.matcher, at, mc);
      }
    };
    matchers(n.matcher, path, cls);
    for (const [name, sub] of Object.entries((n.subcommands as Node | undefined) ?? {}))
      walk(sub, `${path} ${name}`, cls);
    if (n["--"] !== undefined) walk(n["--"], `${path} --`, cls);
  }
  walk((reasonableDefaults as Node).bash, "bash", undefined);

  it("every deny/ask/block node and matcher resolves to a class", () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter(([, cls]) => cls === "MISSING")).toEqual([]);
    expect(rows.every(([, cls]) => isClassId(cls))).toBe(true);
  });

  it.each([
    ["sudo ls", "deny", "privilege"],
    ["shutdown now", "deny", "privilege"],
    ["mkfs /dev/sda", "block", "destroy-catastrophic"],
    ["rm -rf /", "block", "destroy-catastrophic"],
    ["chmod 777 x", "deny", "privilege"],
    ["chown -R a b", "deny", "privilege"],
    ["git status", "policyApprove", ""],
    ["git rebase main", "ask", "unmodelled"],
    ["git push", "ask", "remote-write"],
    ["git push --force", "deny", "vcs-history"],
    ["git push --force-with-lease", "ask", "vcs-history"],
    ["git push --no-verify", "deny", "control-plane"],
    ["git commit --no-verify -m x", "deny", "control-plane"],
    ["git reset --hard", "deny", "destroy-local"],
    ["git reset", "ask", "vcs-history"],
    ["git clean -fd", "deny", "destroy-local"],
    ["git stash drop", "deny", "destroy-local"],
    ["git checkout main", "ask", "destroy-local"],
    ["git branch -D x", "deny", "vcs-history"],
    ["git add -f x", "ask", "protected-file"],
    ["git pull", "ask", "network-egress"],
    ["git clone --upload-pack=x y", "ask", "exec-unknown"],
    ["gh pr merge 1", "deny", "remote-write"],
    ["gh release list", "policyApprove", ""],
    ["gh release delete x", "deny", "publish"],
    ["gh gist create", "deny", "publish"],
    ["gh secret set x", "deny", "credential"],
    ["npm publish", "deny", "publish"],
    ["npm install", "ask", "package-install"],
    ["npm install -g x", "deny", "package-install"],
    ["npm test", "ask", "exec-unknown"],
    ["cargo publish", "deny", "publish"],
    ["kubectl get secrets", "deny", "credential"],
    ["kubectl exec x", "ask", "remote-write"],
    ["docker run --privileged x", "deny", "privilege"],
    ["docker inspect x", "ask", "unmodelled"],
    ["docker run x", "ask", "exec-unknown"],
    ["pip install x", "deny", "package-install"],
    ["curl http://x", "ask", "network-egress"],
    ["make deploy", "ask", "exec-unknown"],
    ["./deploy.sh", "ask", "exec-unknown"],
    ["harness eval --mode yolo", "deny", "control-plane"],
    ["sed -i s/a/b/ f", "deny", "workspace-write"],
    ["cat .env", "block", "credential"],
    ["echo a > .bashrc", "block", "control-plane"],
    ["echo a > package.json", "deny", "protected-file"],
    ["echo a > /etc/x", "deny", "envelope-write"],
    ["echo a > out.txt", "ask", "workspace-write"],
    ["cat /etc/passwd", "deny", "envelope-read"],
  ])("%s -> %s %s", (command, tier, cls) => {
    const verdict = defaultPolicy.explainBash(command);
    expect(verdict.disposition).toBe(tier);
    expect(classes(command)).toEqual(cls === "" ? [] : [cls]);
  });

  it("a mixed pipeline reports the class of the votes at the tier", () => {
    expect(classes("make x && npm publish")).toEqual(["publish"]);
    expect(classes("npm publish && sudo ls")).toEqual(["publish", "privilege"]);
  });

  it("lifted votes are marked and carry the exec-unknown class", () => {
    for (const [command, lift] of [
      ["FOO=1 git log", "env"],
      ["echo $x", "nonliteral"],
      ["ls | xargs git log", "xargs"],
    ] as const) {
      const verdict = defaultPolicy.explainBash(command);
      expect(verdict.disposition).toBe("ask");
      expect(verdict.votes.some((vote) => vote.lift === lift && vote.class === "exec-unknown")).toBe(true);
    }
  });

  it("an ask a rule cast is still marked lifted behind an env prefix, xargs or a non-literal word", () => {
    for (const [command, lift] of [
      ["FOO=1 npm test", "env"],
      ["ls | xargs npm test", "xargs"],
      ["npm test $x", "nonliteral"],
    ] as const) {
      const verdict = defaultPolicy.explainBash(command);
      expect(verdict.disposition).toBe("ask");
      expect(verdict.votes.every((vote) => vote.lift === lift)).toBe(true);
    }
    expect(defaultPolicy.explainBash("npm test").votes.every((vote) => vote.lift === undefined)).toBe(true);
  });

  it("units carry the grant family", () => {
    const unit = (command: string) => defaultPolicy.explainBash(command).votes[0]?.unit;
    expect(unit("git push origin main")).toEqual({ argv0: "git", spine: ["push"], familyArgs: [] });
    expect(unit("npm run build")).toEqual({ argv0: "npm", spine: ["run"], familyArgs: ["build"] });
    expect(unit("make deploy")).toEqual({ argv0: "make", spine: [], familyArgs: ["deploy"] });
    expect(unit("./deploy.sh prod")).toEqual({ argv0: "./deploy.sh", spine: [], familyArgs: [] });
  });

  it("parity: bash/read/write equal explain().disposition", () => {
    for (const command of ["ls", "git push -f", "rm -rf /", "cat .env", "a | b", ""]) {
      expect(defaultPolicy.bash(command)).toBe(defaultPolicy.explainBash(command).disposition);
    }
    expect(defaultPolicy.read(".env")).toBe(defaultPolicy.explainRead(".env").disposition);
    expect(defaultPolicy.write("x")).toBe(defaultPolicy.explainWrite("x").disposition);
  });
});

describe("brace and glob expansion of blocked paths", () => {
  it.each([
    "cat .e{nv,x}",
    "cat .en[v]",
    "cat .en?",
    "cat .e*",
    "cat ./.env.*",
    "cat .{env,x}",
    "cat {.env,a}",
    "cat a/../.e{nv,x}",
    "cat .e{n,m}v",
    "cat .e{1..2}",
    "cat .*",
    "cat .s{s,t}h/id_rsa",
    "cat .ss[h]/x",
    "cat **/.env",
    "cat sub/.en[v]",
    "echo x > .bash{rc,x}",
    "tee .zsh*",
    "cat id_{rsa,x}",
    "cat .ENV",
  ])("%s is block", (command) => {
    const verdict = defaultPolicy.explainBash(command);
    // `.e{1..2}` and `.e{n,m}v` expand to names no rule blocks: they only block when something can match.
    if (command === "cat .e{1..2}") {
      expect(verdict.disposition).not.toBe("block");
      return;
    }
    expect(verdict.disposition).toBe("block");
  });

  it("does not block globs that cannot reach a block rule", () => {
    for (const command of ["cat *.ts", "cat src/*", "cat a{1..3}", "cat file?.txt", "cat [ab].txt", "ls src/**/*.ts"]) {
      expect(defaultPolicy.explainBash(command).disposition).not.toBe("block");
    }
  });

  it("a quoted literal is not expanded", () => {
    expect(defaultPolicy.explainBash("cat '.e*'").disposition).not.toBe("block");
  });

  it("leading dot needs a dot unless dotglob is set", () => {
    expect(defaultPolicy.explainBash("cat *").disposition).not.toBe("block");
    expect(defaultPolicy.explainBash("shopt -s dotglob; cat *").disposition).toBe("block");
  });

  it("an oversized brace falls back to a wildcard", () => {
    expect(defaultPolicy.explainBash("cat .env{,{1..99999}}").disposition).toBe("block");
  });

  it("keeps the .claude/worktrees carve-out under a glob", () => {
    expect(defaultPolicy.explainBash("rm -r .claude/worktrees/*").disposition).not.toBe("block");
  });

  it("reports the rule that blocked", () => {
    const verdict = defaultPolicy.explainBash("cat .e{nv,x}");
    expect(verdict.votes[0]).toMatchObject({ class: "credential", ruleId: "read_block:.env" });
  });
});
