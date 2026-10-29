/**
 * Regression tests for analysis-layer blind spots: env-assignment prefixes, xargs-appended
 * arguments, non-literal words in any argv position, and shell cwd re-basing.
 * Commands use inert placeholders; nothing here executes them.
 */
import { describe, expect, it } from "vitest";

import { bindPolicy } from "../bind.js";
import { reasonableDefaults } from "../reasonable-defaults.js";

const policy = bindPolicy(reasonableDefaults);

describe("controls", () => {
  it.each([
    ["git status", "policyApprove"],
    ["cat src/a.ts", "policyApprove"],
    ["cat .env", "block"],
    ["git commit --no-verify", "deny"],
    ['cat "src/a.ts"', "policyApprove"],
  ] as const)("%s -> %s", (command, want) => {
    expect(policy.bash(command)).toBe(want);
  });
});

describe("env-assignment prefixes", () => {
  it.each([
    "GIT_EXTERNAL_DIFF=./x git diff",
    "GIT_PAGER=./x git log",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=./x git status",
    "DYLD_INSERT_LIBRARIES=./x.dylib cat src/a.ts",
    "LD_PRELOAD=./x.so ls",
    "PATH=./bin git status",
    "NODE_OPTIONS=--require=./x npm run test",
    "env GIT_PAGER=./x git log",
    "env LD_PRELOAD=./x.so ls",
    "npm_config_script_shell=./x npm run test",
    "BASH_ENV=./x bash -c ls",
    "sh -c 'LD_PRELOAD=./x.so ls'",
    "LD_PRELOAD=./x.so sh -c ls",
    "env LD_PRELOAD=./x.so sh -c 'git status'",
    "FOO=bar git status",
  ])("lifts approve to ask: %s", (command) => {
    expect(policy.bash(command)).not.toBe("policyApprove");
  });

  it.each(["LANG=C git status", "LC_ALL=C ls", "TZ=UTC git log", "NO_COLOR=1 git diff", "env CI=1 git status"])(
    "inert variable keeps the verdict: %s",
    (command) => {
      expect(policy.bash(command)).toBe("policyApprove");
    },
  );

  it("an inert name with a non-literal value still asks", () => {
    expect(policy.bash("LANG=$(echo ./x) git status")).not.toBe("policyApprove");
  });

  it("does not soften block or deny", () => {
    expect(policy.bash("LANG=C cat .env")).toBe("block");
    expect(policy.bash("LD_PRELOAD=./x git commit --no-verify")).toBe("deny");
  });
});

describe("xargs appends arguments the floor never sees", () => {
  it.each([
    "echo .env | xargs cat",
    "ls | xargs rm",
    "printf x | xargs -I{} uniq src/a.ts package.json",
    "ls | xargs git status",
  ])("%s", (command) => {
    expect(policy.bash(command)).not.toBe("policyApprove");
  });
});

describe("non-literal words anywhere in argv", () => {
  it.each([
    "git commit $(echo --no-verify) -m m",
    "sed $(printf -- -i) s/a/b/ f",
    "git branch $(echo -D) main",
    "sed $F s/a/b/ f",
    "git log $OPTS",
    "git log `echo -p`",
    'git log "$OPTS"',
    "cat .e{nv,x}",
    "cat .en[v]",
    "git status {a,b}",
    "git log -- src/*.ts",
    "git log -?",
  ])("is not approved: %s", (command) => {
    expect(policy.bash(command)).not.toBe("policyApprove");
  });

  it.each(["git log --format='%H [%an]'", "git log --grep='a*b'", 'git log --grep="a b"', "git log HEAD~2"])(
    "quoted or plain literals stay literal: %s",
    (command) => {
      expect(policy.bash(command)).toBe("policyApprove");
    },
  );
});

describe("shell cwd re-bases relative paths", () => {
  it("a relative write target inside .git re-bases onto the git write block", () => {
    expect(policy.bash("tee hooks/pre-commit", ".git")).toBe("block");
    expect(policy.bash("tee hooks/pre-commit")).not.toBe("block");
  });

  it("a redirect target re-bases too", () => {
    expect(policy.bash("echo x > hooks/pre-commit", ".git")).toBe("block");
  });

  it("root cwd leaves paths alone", () => {
    expect(policy.bash("cat src/a.ts", ".")).toBe("policyApprove");
    expect(policy.bash("cat src/a.ts", "src")).toBe("policyApprove");
  });

  it("absolute paths ignore the cwd", () => {
    expect(policy.bash("cat /etc/passwd", "src")).toBe(policy.bash("cat /etc/passwd"));
  });
});
