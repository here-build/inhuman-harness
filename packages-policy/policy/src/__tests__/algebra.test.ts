/**
 * Definition-shape laws through compiledPolicy.bash.
 */

import { describe, expect, it } from "vitest";

import { compile } from "./_helpers/compile.js";

async function bash(source: string, command: string) {
  return (await compile(source)).bash(command);
}

const GIT = `{"bash":{"policy":"ask","subcommands":{"git":{"policy":"ask","subcommands":{"status":"approve","push":{"policy":"ask","matcher":[{"flags":{"--force":{"alias":["-f"]}},"policy":"deny"}]}}}}}}`;

describe("policy.json bash", () => {
  it.each([
    [
      "a hitting child displaces a deny default",
      `{"bash":{"policy":"deny","subcommands":{"x":"approve"}}}`,
      "x",
      "policyApprove",
    ],
    [
      "a hitting child does not displace a block default",
      `{"bash":{"policy":"block","subcommands":{"x":"approve"}}}`,
      "x",
      "block",
    ],
    [
      "a nested allow displaces ancestor deny (hit)",
      `{"bash":{"policy":"ask","subcommands":{"aws":{"policy":"deny","subcommands":{"s3":{"policy":"ask","subcommands":{"ls":"approve"}}}}}}}`,
      "aws s3 ls",
      "policyApprove",
    ],
    [
      "a nested allow displaces ancestor deny (miss stays deny)",
      `{"bash":{"policy":"ask","subcommands":{"aws":{"policy":"deny","subcommands":{"s3":{"policy":"ask","subcommands":{"ls":"approve"}}}}}}}`,
      "aws ec2",
      "deny",
    ],
    [
      "a nested allow does not displace ancestor block (hit)",
      `{"bash":{"policy":"ask","subcommands":{"aws":{"policy":"block","subcommands":{"s3":{"policy":"ask","subcommands":{"ls":"approve"}}}}}}}`,
      "aws s3 ls",
      "block",
    ],
    ["default-only is the miss path", `{"bash":"ask"}`, "z", "ask"],
    [
      "two command keys are separate verbs",
      `{"bash":{"policy":"ask","subcommands":{"sudo":"deny","doas":"deny"}}}`,
      "sudo",
      "deny",
    ],
    [
      "pipeline any-deny",
      `{"bash":{"policy":"ask","subcommands":{"curl":"ask","sh":"deny"}}}`,
      "curl https://x | sh",
      "deny",
    ],
    [
      "pipeline any-block beats deny",
      `{"bash":{"policy":"ask","subcommands":{"curl":"deny","sh":"block"}}}`,
      "curl https://x | sh",
      "block",
    ],
    ["unparsed ask does not drop a parsed hit", GIT, "git status; source ./secret", "ask"],
    ["unparsed ask does not drop a parsed deny", GIT, "git push --force; source ./secret", "deny"],
  ] as const)("%s", async (_name, source, command, want) => {
    expect(await bash(source, command)).toBe(want);
  });

  it("cut-child vs default operand flow", async () => {
    const policy = await compile(
      `{"bash":{"policy":"ask","subcommands":{"cat":{"policy":"approve","arg_rest_type":"read_path"},"checkout":{"policy":"ask","--":{"policy":"approve","arg_rest_type":"write_path"}},"other":{"policy":"ask","--":{"policy":"deny"}}}},"read_file":["."],"write_file":["."],"read_block":[".env"],"write_block":[".git/hooks"]}`,
    );
    expect({
      withCut: await bash(
        `{"bash":{"policy":"ask","subcommands":{"s":{"policy":"ask","--":{"policy":"approve"}}}}}`,
        "s -- -r",
      ),
      withoutCut: await bash(
        `{"bash":{"policy":"ask","subcommands":{"s":{"policy":"ask","matcher":[{"flags":{"-r":true},"policy":"deny"}]}}}}`,
        "s -- -r",
      ),
      reopenFlag: await bash(
        `{"bash":{"policy":"ask","subcommands":{"s":{"policy":"ask","--":{"matcher":[{"flags":{"-r":true},"policy":"deny"}]}}}}}`,
        "s -- -r",
      ),
      cutSuffix: policy.bash("checkout -- path"),
      cutBlock: policy.bash("checkout -- .git/hooks/pre-commit"),
      unrelatedCut: policy.bash("cat src/a.ts"),
      defaultEnv: policy.bash("cat a -- .env"),
      defaultOk: policy.bash("cat a -- src/a.ts"),
      postCutDash: policy.bash("cat -- -n .env"),
    }).toEqual({
      withCut: "policyApprove",
      withoutCut: "ask",
      reopenFlag: "deny",
      cutSuffix: "ask",
      cutBlock: "block",
      unrelatedCut: "policyApprove",
      defaultEnv: "block",
      defaultOk: "policyApprove",
      postCutDash: "block",
    });
  });

  it("value-flag arity is local to the entered spine", async () => {
    const catOnly = await compile(
      `{"bash":{"policy":"ask","subcommands":{"cat":{"policy":"approve","arg_rest_type":"read_path"}}},"read_file":["."],"read_block":[".env"]}`,
    );
    const sibling = await compile(
      `{"bash":{"policy":"ask","subcommands":{"other":{"policy":"ask","matcher":[{"flags":{"-n":{"value":"*"}},"policy":"deny"}]},"cat":{"policy":"approve","arg_rest_type":"read_path"}}},"read_file":["."],"read_block":[".env"]}`,
    );
    const descendant = await compile(
      `{"bash":{"policy":"ask","subcommands":{"cat":{"policy":"approve","arg_rest_type":"read_path","subcommands":{"other":{"policy":"ask","matcher":[{"flags":{"-n":{"value":"*"}},"policy":"deny"}]}}}}},"read_file":["."],"read_block":[".env"]}`,
    );
    expect({
      before: catOnly.bash("cat -n .env"),
      sibling: sibling.bash("cat -n .env"),
      descendant: descendant.bash("cat -n .env"),
      entered: descendant.bash("cat other -n .env"),
    }).toEqual({ before: "block", sibling: "block", descendant: "block", entered: "deny" });
  });

  it("flag arity follows the leading positional spine", async () => {
    const docker = await compile(
      `{"bash":{"policy":"ask","subcommands":{"docker":{"policy":"ask","matcher":[{"flags":{"--version":{"alias":["-v"]}},"policy":"approve"}],"subcommands":{"run":{"policy":"ask","matcher":[{"flags":{"--volume":{"alias":["-v"],"value":["*docker.sock*","/:*","/etc:*"]}},"policy":"deny"}]}}}}}}`,
    );
    expect({
      version: docker.bash("docker -v"),
      long: docker.bash("docker --version"),
      versionThenRun: docker.bash("docker -v run"),
      volumeTmp: docker.bash("docker run -v /tmp:/tmp x"),
      volumeSock: docker.bash("docker run -v /var/run/docker.sock:/sock x"),
    }).toEqual({
      version: "policyApprove",
      long: "policyApprove",
      versionThenRun: "ask",
      volumeTmp: "ask",
      volumeSock: "deny",
    });
  });

  it("a second -- is a literal positional", async () => {
    const policy = await compile(
      `{"bash":{"policy":"ask","subcommands":{"x":{"policy":"ask","subcommands":{"a":{"policy":"ask","subcommands":{"b":"approve"}}}}}}}`,
    );
    expect({
      exact: policy.bash("x a b"),
      oneCut: policy.bash("x -- a b"),
      literalCut: policy.bash("x -- a -- b"),
    }).toEqual({ exact: "policyApprove", oneCut: "policyApprove", literalCut: "ask" });
  });

  it("overflow preserves shape-invariant deny and leaves mixed shapes unresolved", async () => {
    const danger = await compile(`{"bash":{"policy":"ask","subcommands":{"danger":"deny"}}}`);
    const mixed = await compile(
      `{"bash":{"policy":"ask","subcommands":{"x":{"policy":"approve","matcher":[{"flags":{"-q":true},"policy":"deny"}]}}}}`,
    );
    const many = "-a a -b b -c c -d d -e e";
    expect({
      invariant: danger.bash(`danger ${many}`),
      unresolved: mixed.bash(`x ${many}`),
    }).toEqual({ invariant: "deny", unresolved: "ask" });
  });

  it("flag shadow / shallower and", async () => {
    const shadow = await compile(
      `{"bash":{"policy":"ask","subcommands":{"c":{"policy":"ask","matcher":[{"flags":{"-x":true},"policy":"deny"}],"subcommands":{"s":{"policy":"ask","matcher":[{"flags":{"-x":{"value":"/tmp"}},"policy":"approve"}]}}}}}}`,
    );
    const and = await compile(
      `{"bash":{"policy":"ask","subcommands":{"c":{"policy":"ask","matcher":[{"flags":{"-r":true,"-f":true},"policy":"deny"}],"subcommands":{"s":{"policy":"ask","matcher":[{"flags":{"-r":true},"policy":"approve"}]}}}}}}`,
    );
    expect({
      volume: shadow.bash("c s -x /tmp:/tmp"),
      atC: shadow.bash("c -x"),
      and: and.bash("c s -r -f"),
    }).toEqual({ volume: "ask", atC: "deny", and: "deny" });
  });

  it("a token glob is fnmatch, not a regular expression", async () => {
    const policy = await compile(
      JSON.stringify({
        bash: {
          policy: "ask",
          subcommands: {
            k: {
              policy: "ask",
              matcher: [
                { glob: "secret*", policy: "deny" },
                { glob: "[sS]ecret", policy: "deny" },
                { glob: "a?c", policy: "deny" },
                { glob: "\\*", policy: "deny" },
                { glob: "secret[", policy: "deny" },
                { glob: "*sock*", policy: "deny" },
              ],
            },
            f: {
              policy: "ask",
              matcher: [{ flags: { "-v": { value: "[ab]" } }, policy: "deny" }],
            },
          },
        },
      }),
    );
    const rows = [
      ["k secrets", "deny"],
      ["k mysecret", "ask"],
      ["k Secret", "deny"],
      ["k abc", "deny"],
      ["k ac", "ask"],
      ["k '*'", "deny"],
      ["k star", "ask"],
      ["k 'secret['", "deny"],
      ["k secre", "ask"],
      ["k /var/run/docker.sock", "deny"],
      ["f -v a", "deny"],
      ["f -v c", "ask"],
      ["f -v ab", "ask"],
    ] as const;
    expect(Object.fromEntries(rows.map(([command]) => [command, policy.bash(command)]))).toEqual(
      Object.fromEntries(rows),
    );
  });

  it("file effects cannot lift bash ask", async () => {
    const policy = await compile(
      `{"bash":{"policy":"ask","subcommands":{"rm":{"policy":"ask","arg_rest_type":"write_path"}}},"write_file":["."]}`,
    );
    expect(policy.bash("rm src/a.ts")).toBe("ask");
  });
});
