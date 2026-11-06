import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AckBlock } from "../ack-block.js";
import { ackCopy, answerRequest, choiceByKey, promptKind, storeChoices, ttlText } from "../ack-prompt.js";

const SEND = { kind: "mcp", server: "gmail", tool: "send_email" } as const;
const ANY = { kind: "mcp", server: "gmail" } as const;
const options = [
  { subject: SEND, label: "gmail · send_email" },
  { subject: ANY, label: "gmail · every tool" },
];

describe("promptKind", () => {
  it("tells an ack-only, a combined and an ordinary prompt apart", () => {
    expect(promptKind({ ackPending: true, baseLicenseDetail: { decision: true } })).toBe("ack");
    expect(promptKind({ ackPending: true, baseLicenseDetail: { decision: null } })).toBe("ask+ack");
    expect(promptKind({ ackPending: true, baseLicenseDetail: { decision: false } })).toBe("ask+ack");
    expect(promptKind({ ackPending: false, baseLicenseDetail: { decision: null } })).toBe("ask");
  });
});

describe("storeChoices", () => {
  it("offers each subject at session, project and global with the ttl", () => {
    const choices = storeChoices(options, { bot: false });
    expect(choices).toHaveLength(6);
    expect(choices.map((c) => c.scope)).toEqual(["session", "project", "global", "session", "project", "global"]);
    expect(choices[0]!.text).toBe("gmail · send_email · this session");
    expect(choices[1]!.ttl).toBe("7 days");
    expect(choices[1]!.text).toContain("this project · 7 days");
  });

  it("adds bot scope only for a bot", () => {
    const choices = storeChoices(options.slice(0, 1), { bot: true });
    expect(choices.map((c) => c.scope)).toEqual(["session", "project", "bot", "global"]);
  });

  it("offers nothing without options and finds a choice by key", () => {
    expect(storeChoices([], { bot: true })).toEqual([]);
    const choices = storeChoices(options, { bot: false });
    expect(choiceByKey(choices, "1:project")?.subject).toEqual(ANY);
    expect(choiceByKey(choices, "")).toBeNull();
  });

  it("words ttls", () => {
    expect(ttlText(null)).toBe("this session");
    expect(ttlText("1d")).toBe("1 day");
    expect(ttlText("7d")).toBe("7 days");
  });
});

describe("answerRequest", () => {
  const base = { sessionId: "s1", jobId: "j1" };
  const remember = storeChoices(options, { bot: false })[1]!;

  it("acknowledges an ack-only prompt over ack/answer", () => {
    expect(answerRequest({ ...base, kind: "ack", yes: true })).toEqual({
      method: "ack/answer",
      params: { sessionId: "s1", jobId: "j1", ackId: "j1", accept: true },
    });
  });

  it("refuses with a comment and never stores", () => {
    expect(answerRequest({ ...base, kind: "ack", yes: false, comment: " not now ", remember })).toEqual({
      method: "ack/answer",
      params: { sessionId: "s1", jobId: "j1", ackId: "j1", accept: false, comment: "not now" },
    });
  });

  it("remembers an acknowledgement with scope and subject", () => {
    expect(answerRequest({ ...base, kind: "ack", yes: true, remember }).params).toEqual({
      sessionId: "s1",
      jobId: "j1",
      ackId: "j1",
      accept: true,
      store: { scope: "project", subject: SEND },
    });
  });

  it("answers a combined prompt over ask/answer, remembering the ack as ackStore", () => {
    expect(answerRequest({ ...base, kind: "ask+ack", yes: true, remember })).toEqual({
      method: "ask/answer",
      params: { sessionId: "s1", jobId: "j1", allow: true, ackStore: { scope: "project", subject: SEND } },
    });
    expect(answerRequest({ ...base, kind: "ask+ack", yes: false, remember }).params).toEqual({
      sessionId: "s1",
      jobId: "j1",
      allow: false,
    });
  });

  it("keeps the plain ask exactly as before", () => {
    expect(answerRequest({ ...base, kind: "ask", yes: true, remember })).toEqual({
      method: "ask/answer",
      params: { sessionId: "s1", jobId: "j1", allow: true },
    });
  });
});

describe("copy and block", () => {
  it("says the call is allowed but needs acknowledgement", () => {
    const copy = ackCopy("ack", false);
    expect(copy.lede).toContain("allows this call");
    expect([copy.yes, copy.no]).toEqual(["Acknowledge", "Refuse"]);
    expect(ackCopy("ask+ack", true).lede).toContain("every time");
    expect(ackCopy("ask", false).yes).toBe("Allow");
  });

  it("renders flag labels, why, and the remember choices as escaped text", () => {
    const html = renderToStaticMarkup(
      createElement(AckBlock, {
        flags: [{ label: "gmail · send_email", why: "emails <b>leave</b> the company" }],
        choices: storeChoices(options, { bot: false }),
        remember: "0:global",
        disabled: false,
        onRemember: () => undefined,
      }),
    );
    expect(html).toContain("gmail · send_email");
    expect(html).toContain("emails &lt;b&gt;leave&lt;/b&gt; the company");
    expect(html).toContain("Just this once");
    expect(html).toContain("everywhere · 7 days");
    expect(html).toContain('<option value="0:global" selected');
  });
});
