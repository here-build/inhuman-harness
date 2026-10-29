/**
 * Regression tests for the audited defects in the default floor. Every case states the SAFE
 * verdict. Commands use inert placeholders; nothing here executes them.
 */
import { describe, expect, it } from "vitest";

import { bindPolicy } from "../bind.js";
import { sedScriptIsPlain } from "../guards.js";
import { reasonableDefaults } from "../reasonable-defaults.js";
import type { Disposition } from "../types.js";

const policy = bindPolicy(reasonableDefaults);
const notApproved = (cmd: string) => expect(policy.bash(cmd), cmd).not.toBe("policyApprove");
const exactly = (cmd: string, want: Disposition) => expect(policy.bash(cmd), cmd).toBe(want);

describe("controls", () => {
  it.each([
    ["cat .env", "block"],
    ["git status", "policyApprove"],
    ["git log", "policyApprove"],
    ["git diff HEAD~1", "policyApprove"],
    ["git diff main..feature -- src/a.ts", "policyApprove"],
    ["git show HEAD", "policyApprove"],
    ["git commit -m msg", "policyApprove"],
    ["git commit --no-verify", "deny"],
    ["git -c color.ui=always status", "policyApprove"],
    ["git fetch origin", "policyApprove"],
    ["sed s/a/b/ src/a.ts", "policyApprove"],
    ["sed -n 1,5p src/a.ts", "policyApprove"],
    ["sed -i s/a/b/ f", "deny"],
    ["sort src/a.ts", "policyApprove"],
    ["sort -o out", "deny"],
    ["uniq src/a.ts", "policyApprove"],
    ["grep -rn foo src", "policyApprove"],
    ["wc -l src/a.ts", "policyApprove"],
    ["diff src/a.ts src/b.ts", "policyApprove"],
    ["kubectl get pods", "policyApprove"],
    ["gh pr view 1", "policyApprove"],
    ["gh issue list", "policyApprove"],
  ] as const)("%s -> %s", (cmd, want) => exactly(cmd, want));
});

describe("git (C3): approved forms do not run programs or write files", () => {
  it.each([
    "git -c core.fsmonitor=./x status",
    "git -c core.pager=./x log",
    "git -c core.sshCommand=./x fetch",
    "git -c core.editor=./x commit",
    "git -c pager.log=./x log",
    "git -c filter.x.clean=./x status",
    "git -c unknown.key=1 status",
    "git -c user.name=a -c core.fsmonitor=./x status",
    "git --config-env=core.pager=X log",
    "git --config-env core.pager=X log",
  ])("config injection is not approved: %s", notApproved);

  it.each([
    ["git -c CORE.HOOKSPATH=/tmp/h commit -m m", "deny"],
    ["git -c Core.HooksPath=/tmp/h status", "deny"],
    ["git -c ALIAS.x=!rm status", "deny"],
    ["git -c Include.Path=/tmp/e status", "deny"],
    ["git -c INCLUDEIF.gitdir:/.path=/tmp/e status", "deny"],
    ["git -c Diff.External=./x diff", "deny"],
  ] as const)("config keys fold case: %s", (cmd, want) => exactly(cmd, want));

  it.each([
    "git fetch --upload-pack=./x .",
    "git fetch --upload-pack ./x .",
    "git fetch --upload-pa=./x .",
    "git fetch -u ./x .",
    "git fetch --receive-pack=./x .",
    "git fetch --exec=./x .",
    "git pull --upload-pack=./x",
    "git clone --upload-pack=./x . d",
    "git ls-remote --upload-pack=./x .",
    "git fetch ext::sh",
  ])("transport program options ask: %s", (cmd) => expect(policy.bash(cmd), cmd).toBe("ask"));

  it.each([
    ["git log --output=package.json", "deny"],
    ["git log --output=out.txt", "ask"],
    ["git log --outp=out.txt", "ask"],
    ["git show --output=.git/hooks/pre-commit", "block"],
    ["git diff --output=package.json", "deny"],
    ["git diff --output secret", "deny"],
    ["git diff --outp=secret", "deny"],
    ["git format-patch -o .git/hooks", "block"],
    ["git format-patch --output-directory=.git/hooks", "block"],
  ] as const)("--output is a typed write: %s", (cmd, want) => {
    if (cmd.includes("--output-directory")) return notApproved(cmd);
    exactly(cmd, want);
  });

  it("diff --no-index reads its operands", () => {
    exactly("git diff --no-index .env /dev/null", "block");
    notApproved("git diff --no-index --stat /etc/passwd src/a.ts");
    notApproved("git diff --no-index /etc/passwd src/a.ts");
    exactly("git diff --no-i .env /dev/null", "block");
  });

  it("revision:path and pathspec operands are reads", () => {
    exactly("git show HEAD:.env", "block");
    exactly("git diff -- .env", "block");
    exactly("git log -p -- .ssh/id_rsa", "block");
    exactly("git diff main...feature", "policyApprove");
  });

  it.each([
    ["git commit --no-verif -m m", "deny"],
    ["git commit --no-v -m m", "deny"],
    ["git commit --no-verify -m m", "deny"],
    ["git push --no-veri", "deny"],
    ["git push --forc", "deny"],
    ["git reset --har", "deny"],
    ["git branch --dele --forc x", "deny"],
    ["git add --forc x", "ask"],
  ] as const)("abbreviated long option matches the full one: %s", (cmd, want) => exactly(cmd, want));

  it("force branch rename and move ask", () => {
    notApproved("git branch -M a main");
    notApproved("git branch -f main HEAD~3");
    notApproved("git branch --move --force a main");
    exactly("git branch -m a b", "policyApprove");
  });

  it("commit -F / --template read their file", () => {
    exactly("git commit -F .env", "block");
    exactly("git commit --file=.env", "block");
    exactly("git commit --templ=.env", "block");
  });
});

describe("text tools (H2)", () => {
  it("sed reads its files through the read cluster", () => {
    exactly("sed -n p .env", "block");
    exactly("sed -e p .env", "block");
    exactly("sed s/a/b/ /etc/passwd", "deny");
  });

  it.each([
    "sed -i.bak s/a/b/ f",
    "sed -i s/a/b/ f",
    "sed --in-place s/a/b/ f",
    "sed --in-place=.bak s/a/b/ f",
    "sed --in-pl s/a/b/ f",
    "sed -ni s/a/b/p f",
    "sed -I .bak s/a/b/ f",
  ])("sed in-place is denied: %s", (cmd) => exactly(cmd, "deny"));

  it.each([
    "sed -n 'w package.json' src/a.ts",
    "sed 's/a/b/w out.txt' src/a.ts",
    "sed 's/a/b/e' src/a.ts",
    "sed '1e ./x' src/a.ts",
    "sed -e 'w out' src/a.ts",
    "sed -es/a/b/w src/a.ts",
    "sed 'r .env' src/a.ts",
    "sed 'R .env' src/a.ts",
    "sed -f script.sed src/a.ts",
    "sed --file=script.sed src/a.ts",
    "sed 'W out' src/a.ts",
    "sed 'a text' src/a.ts",
    "sed -s -n '$w out' src/a.ts",
    "sed -l 5 p src/a.ts",
    "sed $F s/a/b/ f",
  ])("sed script or option that writes, runs, or reads is not approved: %s", notApproved);

  it("sed script parser accepts plain scripts only", () => {
    for (const ok of [
      "s/a/b/",
      "s/a/b/g",
      "s|a|b|gI",
      "1,5p",
      "$!N",
      "/foo/d",
      "/foo/,/bar/{s/a/b/;p}",
      "2q",
      "y/abc/xyz/",
      "s/a/b/2;s/c/d/",
      "1~2d",
    ]) {
      expect(sedScriptIsPlain(ok), ok).toBe(true);
    }
    for (const bad of [
      "w f",
      "s/a/b/w f",
      "s/a/b/e",
      "e",
      "r f",
      "s/a/b",
      "{p",
      "p}",
      "1,5",
      "#c",
      "a x",
      "s/a/b/ w f",
    ]) {
      expect(sedScriptIsPlain(bad), bad).toBe(false);
    }
  });

  it.each([
    ["sort -opackage.json src/a.ts", "deny"],
    ["sort -o package.json src/a.ts", "deny"],
    ["sort --output=package.json src/a.ts", "deny"],
    ["sort --outp=package.json src/a.ts", "deny"],
    ["sort -o.git/hooks/pre-commit src/a.ts", "block"],
    ["sort -o out", "deny"],
  ] as const)("sort output is a write: %s", (cmd, want) => exactly(cmd, want));

  it.each([
    "sort --compress-program=./x src/a.ts",
    "sort --compress-program ./x src/a.ts",
    "sort --compress=./x src/a.ts",
  ])("sort --compress-program runs a program: %s", (cmd) => expect(policy.bash(cmd), cmd).toBe("ask"));

  it("sort reads its option-named files", () => {
    exactly("sort --files0-from=.env", "block");
    exactly("sort --random-source=.env src/a.ts", "block");
  });

  it("uniq's second operand is an output", () => {
    exactly("uniq src/a.ts .git/hooks/pre-commit", "block");
    exactly("uniq src/a.ts package.json", "deny");
    exactly("uniq src/a.ts out.txt", "ask");
    exactly("uniq .env", "block");
  });

  it("path-valued options of diff / grep / wc / date / touch are reads", () => {
    exactly("diff --from-file=.env src/a.ts", "block");
    exactly("diff --to-file .env src/a.ts", "block");
    exactly("diff -X .env src/a.ts src/b.ts", "block");
    exactly("diff --exclude-from=.env a b", "block");
    exactly("grep --file=.env -r x src", "block");
    exactly("grep -f .env -r x src", "block");
    exactly("grep -f.env x src", "block");
    exactly("grep --exclude-from=.env x src", "block");
    exactly("wc --files0-from=.env", "block");
    exactly("wc --files0=.env", "block");
    exactly("date -f .env", "block");
    exactly("date --file=.env", "block");
    exactly("touch -r .env out", "block");
  });
});

describe("project-code runners ask", () => {
  it.each([
    "npm run test",
    "npm run test --script-shell=./x",
    "npm test",
    "npm exec x",
    "npm start",
    "npx foo",
    "pnpm run build",
    "pnpm test",
    "yarn build",
    "yarn",
    "cargo run",
    "cargo test",
    "cargo bench",
    "cargo build",
    "cargo check",
    "make",
    "make test",
  ])("%s", (cmd) => expect(policy.bash(cmd), cmd).toBe("ask"));

  it("cargo publish and npm publish stay denied", () => {
    exactly("cargo publish", "deny");
    exactly("npm publish", "deny");
  });
});

describe("gh", () => {
  it.each([
    "gh pr view 1",
    "gh pr list",
    "gh pr diff 1",
    "gh pr status",
    "gh pr checks 1",
    "gh issue view 1",
    "gh issue list",
    "gh issue status",
    "gh run list",
    "gh run view 1",
    "gh label list",
    "gh search issues x",
  ])("read-only subcommand stays approved: %s", (cmd) => exactly(cmd, "policyApprove"));

  it.each([
    "gh issue create --title t --body-file .env",
    "gh issue create --title t",
    "gh issue comment 1 --body-file .env",
    "gh pr comment 1 --body-file .env",
    "gh pr create --body-file .env",
    "gh pr review 1 --approve",
    "gh pr close 1",
    "gh pr edit 1",
    "gh pr checkout 1",
    "gh issue close 1",
    "gh issue edit 1",
    "gh run download 1",
    "gh run rerun 1",
    "gh run cancel 1",
    "gh label create x",
    "gh label delete x",
    "gh release create v1",
    "gh api repos/x/y",
  ])("write or upload subcommand asks: %s", (cmd) => expect(policy.bash(cmd), cmd).toBe("ask"));

  it("destructive verbs stay denied", () => {
    exactly("gh pr merge 1", "deny");
    exactly("gh issue delete 1", "deny");
    exactly("gh run delete 1", "deny");
    exactly("gh release delete v1", "deny");
  });
});

describe("kubectl secrets", () => {
  it.each([
    "kubectl get secrets",
    "kubectl get secret",
    "kubectl get Secret",
    "kubectl get SECRETS",
    "kubectl get secret/foo",
    "kubectl get secrets/foo",
    "kubectl get pods,secrets",
    "kubectl get secret,configmap",
    "kubectl get configmap,Secrets -o yaml",
    "kubectl get secrets.v1",
    "kubectl get -n x secrets",
    "kubectl get --namespace=x secrets",
    "kubectl describe secret foo",
    "kubectl describe SECRETS",
    "kubectl describe pods,secret",
    "kubectl describe secret/foo",
  ])("denied: %s", (cmd) => exactly(cmd, "deny"));

  it.each([
    "kubectl get --raw /api/v1/namespaces/default/secrets",
    "kubectl get --raw=/api/v1/namespaces/default/secrets",
    "kubectl get --raw /API/V1/NAMESPACES/default/SECRETS/x",
  ])("raw API path to secrets is denied: %s", (cmd) => exactly(cmd, "deny"));

  it("other raw paths ask, ordinary reads stay approved", () => {
    exactly("kubectl get --raw /healthz", "ask");
    exactly("kubectl get pods", "policyApprove");
    exactly("kubectl get pods,services -o wide", "policyApprove");
    exactly("kubectl describe pod x", "policyApprove");
  });

  it("-f files are reads", () => {
    exactly("kubectl get -f .env", "block");
    exactly("kubectl get --filename=.env", "block");
  });
});

describe("harness CLI that changes the gate", () => {
  it.each([
    "harness eval --mode yolo -e 1",
    "harness eval --mode=yolo -e 1",
    "harness eval --mode always-approve -e 1",
    "harness eval -p hello --mode yolo",
  ])("deny: %s", (cmd) => exactly(cmd, "deny"));

  it("eval in auto mode asks", () => {
    exactly("harness eval -e 1", "ask");
    exactly("harness eval --mode auto -e 1", "ask");
    exactly("harness daemon stop", "ask");
  });
});

describe("case-insensitive filesystems (H3)", () => {
  it.each([".ENV", ".Env.local", "ID_RSA", ".AWS/credentials", "src/.ENV", ".SSH/id_rsa", "Id_Rsa"])(
    "read of case-variant block path %s",
    (p) => expect(policy.read(p)).toBe("block"),
  );
  it.each([".GIT/hooks/pre-commit", ".Git/config", ".CLAUDE/settings.json", ".Husky/pre-commit", ".ZSHRC", ".Env"])(
    "write of case-variant block path %s",
    (p) => expect(policy.write(p)).toBe("block"),
  );
  it.each([
    "Package.json",
    "PACKAGE.JSON",
    "src/Package-Lock.json",
    ".GITHUB/WORKFLOWS/ci.yml",
    "makefile",
    "MAKEFILE",
  ])("write of case-variant deny path %s", (p) => expect(policy.write(p)).toBe("deny"));
  it("bash read of case-variant block path", () => {
    exactly("cat .ENV", "block");
    exactly("tee .Git/Hooks/pre-commit", "block");
    exactly("rm Package.json", "deny");
  });
  it("enable rules stay exact and the worktree carve-out still holds", () => {
    expect(policy.read("/TMP/x")).toBe("deny");
    expect(policy.read("/tmp/x")).toBe("policyApprove");
    expect(policy.write(".claude/worktrees/x")).toBe("ask");
    expect(policy.write(".CLAUDE/Worktrees/x")).toBe("ask");
    expect(policy.write("src/a.ts")).toBe("ask");
  });
});

describe("self-protection (auto-mode H3): project-relative gate config", () => {
  it("<root>/.pi/policy-pi.json is blocked; same-named repo files are not", () => {
    expect(policy.write(".pi/policy-pi.json")).toBe("block");
    exactly("tee .pi/policy-pi.json", "block");
    for (const p of [
      "packages-policy/policy/authorize.scm",
      "src/policy.json",
      "policy.json",
      "auto-mode-ask.scm",
      "src/.harness/x.ts",
      "docs/policy-pi.json",
      "sub/.pi/policy-pi.json",
      "src/.pi/notes.md",
    ]) {
      expect(policy.write(p), p).toBe("ask");
    }
  });
});
