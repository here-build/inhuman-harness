/**
 * License paint from an assembled SessionRoot. No daemon.
 * Cover is needsHuman; votes are not tape words; hatch without a fail is running.
 */
import { SessionSystemPrompt, SystemToolJob, type PermissionMode } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { localClient, openTea, seatTurn } from "./_helpers.js";

function mount(leaf: SystemToolJob, policy: PermissionMode = "manual") {
  const client = localClient();
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: "Patch a.ts and run the unit tests\nfor the login path after the rotate.",
    permissionMode: policy,
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  client.sessionRoot.head = turn;
  client.sessionRoot.permissionMode = policy;
  client.kernelRoot.approvalAskThrottleMs = 0;
  return openTea(client);
}

test("license tape: cover vs chip vs spinner", () => {
  const manualAsk = new SystemToolJob({
    toolCallId: "m",
    name: "edit_file",
    argsJson: JSON.stringify({ path: "a.ts", old_string: "a", new_string: "b" }),
    policyResult: "ask",
  });
  using asked = mount(manualAsk);
  expect(asked).toMatchScreenshot("license-manual-ask");

  const manualDeny = new SystemToolJob({
    toolCallId: "md",
    name: "shell",
    argsJson: '{"command":"rm file"}',
    policyResult: "deny",
  });
  using denyCover = mount(manualDeny);
  expect(denyCover).toMatchScreenshot("license-manual-deny");

  const autoAsk = new SystemToolJob({
    toolCallId: "a",
    name: "edit_file",
    argsJson: '{"path":"a.ts"}',
    policyResult: "ask",
  });
  using remainder = mount(autoAsk, "auto");
  expect(remainder).toMatchScreenshot("license-auto-remainder");

  autoAsk.classifierAbstain = "judge crashed";
  expect(remainder).toMatchScreenshot("license-auto-faulted");

  const hatch = new SystemToolJob({
    toolCallId: "h",
    name: "shell",
    argsJson: '{"command":"npm run test"}',
    policyResult: "policyApprove",
  });
  using hatched = mount(hatch, "auto");
  expect(hatched).toMatchScreenshot("license-hatch");

  hatch.classifierAbstain = "judge crashed";
  expect(hatched).toMatchScreenshot("license-hatch-faulted");

  const denied = new SystemToolJob({
    toolCallId: "d",
    name: "shell",
    argsJson: '{"command":"rm file"}',
    policyResult: "deny",
    outcomeJson:
      '{"ok":false,"text":"Policy prohibits this tool use. Do not try to bypass it; if this is crucial, ask user to do it","code":"policy_denied"}',
    completed: true,
  });
  using deny = mount(denied);
  expect(deny).toMatchScreenshot("license-deny");

  const allowed = new SystemToolJob({
    toolCallId: "ok",
    name: "read_file",
    argsJson: '{"path":"a.ts"}',
    policyResult: "policyApprove",
    classifierResult: "allow",
    outcomeJson: '{"ok":true,"text":"hi"}',
    completed: true,
  });
  using machine = mount(allowed, "auto");
  expect(machine).toMatchScreenshot("license-machine-allow");
});
