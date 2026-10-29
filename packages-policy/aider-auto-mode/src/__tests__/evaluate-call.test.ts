import { describe, expect, it, vi } from "vitest";

import { evaluateCall, type Judge } from "../index.js";

const allow: Judge = () => "allow";

describe("evaluateCall", () => {
  it("a floor block denies without calling the judge", async () => {
    const judge = vi.fn(allow);
    expect(await evaluateCall({ kind: "write", path: ".env" }, judge)).toBe("deny");
    expect(judge).not.toHaveBeenCalled();
  });

  it("sudo ls is floor deny, so an allow vote lifts it", async () => {
    const judge = vi.fn(allow);
    expect(await evaluateCall({ kind: "bash", command: "sudo ls" }, judge)).toBe("allow");
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledWith({ kind: "bash", command: "sudo ls", floor: "deny" });
  });

  it("a null judge denies", async () => {
    expect(await evaluateCall({ kind: "bash", command: "git pull" }, null)).toBe("deny");
    expect(await evaluateCall({ kind: "bash", command: "sudo ls" }, null)).toBe("deny");
  });

  it("an allow vote on an ask-shaped command allows", async () => {
    const judge = vi.fn(allow);
    expect(await evaluateCall({ kind: "bash", command: "git pull" }, judge)).toBe("allow");
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledWith({ kind: "bash", command: "git pull", floor: "ask" });
  });

  it("a null vote denies", async () => {
    expect(await evaluateCall({ kind: "bash", command: "git pull" }, () => null)).toBe("deny");
  });

  it("a thrown judge denies", async () => {
    const judge: Judge = () => {
      throw new Error("judge down");
    };
    expect(await evaluateCall({ kind: "bash", command: "git pull" }, judge)).toBe("deny");
  });

  it("an approve does not call the judge", async () => {
    const judge = vi.fn(allow);
    expect(await evaluateCall({ kind: "bash", command: "ls" }, judge)).toBe("allow");
    expect(judge).not.toHaveBeenCalled();
  });
});

describe("evaluateCall: paths are prepared like the harness does", () => {
  const cwd = "/work/proj";

  it.each([
    "src/../.git/hooks/pre-commit",
    ".GIT/hooks/pre-commit",
    "/work/proj/.git/hooks/pre-commit",
    "/work/proj/src/../.env",
  ])("write %s is a floor block, so the judge is never asked", async (target) => {
    const judge = vi.fn(allow);
    expect(await evaluateCall({ kind: "write", path: target, cwd }, judge)).toBe("deny");
    expect(judge).not.toHaveBeenCalled();
  });

  it("a read of a secret is a floor block; an in-tree read is approved", async () => {
    const judge = vi.fn(allow);
    expect(await evaluateCall({ kind: "read", path: "src/../.env", cwd }, judge)).toBe("deny");
    expect(await evaluateCall({ kind: "read", path: "src/index.ts", cwd }, judge)).toBe("allow");
    expect(judge).not.toHaveBeenCalled();
  });

  it("a judge that never answers is denied at the deadline", async () => {
    const hung: Judge = () => new Promise(() => undefined);
    expect(await evaluateCall({ kind: "bash", command: "git pull" }, hung, 20)).toBe("deny");
  });
});
