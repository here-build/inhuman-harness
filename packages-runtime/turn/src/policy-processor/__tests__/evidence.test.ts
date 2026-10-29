/**
 * Privileged cut for inner scheme tools. The bag is not classified;
 * empty eval prompt uses the owning ProgrammaticJob expr.
 */
import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  ProgrammaticJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { evidenceCuts } from "../evidence.js";

beforeEach(() => resetLocalIDs());

function nest(opts: { readonly prompt: string; readonly expr: string }): {
  readonly inner: SystemToolJob;
  [Symbol.dispose](): void;
} {
  const root = new SessionRoot({ sessionId: "s-ev", path: "/tmp/ev" });
  const plexus = Plexus.bootstrap(root);
  const inner = new SystemToolJob({
    name: "list_dir",
    argsJson: JSON.stringify({ path: ".." }),
  });
  const program = new ProgrammaticJob({
    toolCallId: "program",
    argsJson: JSON.stringify({ expr: opts.expr }),
  });
  program.pushInvocation(inner);
  root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`${opts.prompt}`,
    queue: [program],
  });
  return {
    inner,
    [Symbol.dispose]() {
      plexus.destroy();
    },
  };
}

describe("evidenceCuts scheme inner", () => {
  it("eval empty prompt uses owning ProgrammaticJob expr as privileged", () => {
    using bag = nest({ prompt: "", expr: '(list_dir "..")' });
    expect(evidenceCuts(bag.inner).privileged).toBe('(list_dir "..")');
  });

  it("turn prompt outranks the program expr", () => {
    using bag = nest({ prompt: "list the project", expr: '(list_dir "..")' });
    expect(evidenceCuts(bag.inner).privileged).toBe("list the project");
  });

  it("a turn-level tool with no prompt and no tail stays empty", () => {
    const root = new SessionRoot({ sessionId: "s-bare", path: "/tmp/bare" });
    const plexus = Plexus.bootstrap(root);
    const leaf = new SystemToolJob({
      name: "list_dir",
      argsJson: JSON.stringify({ path: ".." }),
    });
    root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user``,
      queue: [leaf],
    });
    expect(evidenceCuts(leaf).privileged).toBe("");
    plexus.destroy();
  });

  it("continue empty prompt uses tail user messages", () => {
    const root = new SessionRoot({ sessionId: "s-cont", path: "/tmp/cont" });
    const plexus = Plexus.bootstrap(root);
    const prior = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`what do you think about the tools`,
      queue: [],
    });
    const head = new SessionTurn({
      turnTail: prior,
      prompt: prompt.user``,
      queue: [],
    });
    const leaf = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "curl x" }),
    });
    root.head = head;
    head.enqueue(leaf);
    expect(evidenceCuts(leaf).privileged).toBe("what do you think about the tools");
    head.prompt = prompt.user`fix the vocabulary first`;
    expect(evidenceCuts(leaf).privileged).toBe("what do you think about the tools\nfix the vocabulary first");
    plexus.destroy();
  });
});

describe("evidenceCuts policy PIP", () => {
  it("keeps concrete findings and drops Tirith no-verdicts", () => {
    const leaf = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "curl x" }),
    });
    leaf.policyEvidenceJson = JSON.stringify({
      tirith: {
        action: "warn",
        findings: [
          {
            rule_id: "plain_http",
            severity: "MEDIUM",
            title: "Unencrypted download",
            description: "The command downloads over HTTP.",
            remediation: "Use HTTPS.",
          },
        ],
      },
    });
    expect(evidenceCuts(leaf).policy).toContain("The command downloads over HTTP.");
    leaf.policyEvidenceJson = JSON.stringify({
      tirith: {
        action: "warn",
        findings: [
          {
            rule_id: "analysis_incomplete",
            severity: "MEDIUM",
            title: "Package threat intelligence could not be completed",
            description: "Lookups were skipped by offline mode.",
            evidence: [{ type: "threat_intel" }],
          },
        ],
      },
    });
    expect(evidenceCuts(leaf).policy).toBe("");
    leaf.policyEvidenceJson = JSON.stringify({
      tirith: {
        action: "block",
        findings: [
          {
            rule_id: "analysis_incomplete",
            severity: "HIGH",
            title: "Nested executable body could not be resolved",
            description: "Could not prove the complete executable body.",
            evidence: [{ matched: "echo 'a()'|sed", type: "command_pattern" }],
          },
        ],
      },
    });
    expect(evidenceCuts(leaf).policy).toBe("");
  });
});
