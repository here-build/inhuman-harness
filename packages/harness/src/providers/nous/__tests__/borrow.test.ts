import { describe, expect, it } from "vitest";

import { borrowedEnsureKey, memoBorrowedEnsure } from "../borrow.js";

describe("memoBorrowedEnsure", () => {
  it("with no source, only intern runs", async () => {
    const order: string[] = [];
    const memos = new Map<string, Promise<string>>();
    const remints: string[] = [];
    const result = await memoBorrowedEnsure(
      memos,
      "web-nous",
      null,
      async () => {
        order.push("source");
      },
      async () => {
        order.push("intern");
        return "ok";
      },
      () => {
        remints.push("remint");
      },
    );
    expect({
      result,
      order,
      remints,
      memo: memos.has(borrowedEnsureKey("web-nous", null)),
    }).toEqual({
      result: "ok",
      order: ["intern"],
      remints: [],
      memo: true,
    });
  });

  it("ensures source then intern; source failure still mints intern; PEW ticks share one chain", async () => {
    const order: string[] = [];
    const memos = new Map<string, Promise<string>>();
    let intern = 0;
    let source = 0;
    let releaseSource!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    const ensureSource = async (id: string) => {
      source += 1;
      order.push(`source:${id}`);
      await gate;
    };
    const ensureIntern = async () => {
      intern += 1;
      order.push("intern");
      return "minted";
    };
    const first = memoBorrowedEnsure(memos, "web-nous", "nous-portal", ensureSource, ensureIntern);
    const second = memoBorrowedEnsure(memos, "web-nous", "nous-portal", ensureSource, ensureIntern);
    expect(first).toBe(second);
    releaseSource();
    expect(await Promise.all([first, second])).toEqual(["minted", "minted"]);
    expect({ intern, source, order }).toEqual({
      intern: 1,
      source: 1,
      order: ["source:nous-portal", "intern"],
    });

    const failed: string[] = [];
    const failMemos = new Map<string, Promise<string>>();
    const recovered = await memoBorrowedEnsure(
      failMemos,
      "web-nous",
      "nous-portal",
      async () => {
        failed.push("source");
        throw new Error("oidc bootstrap failed");
      },
      async () => {
        failed.push("intern");
        return "minted-anyway";
      },
    );
    expect({ recovered, failed }).toEqual({
      recovered: "minted-anyway",
      failed: ["source", "intern"],
    });
  });

  it("source A→B ensures B, remints intern, and no-source cannot retain A", async () => {
    const order: string[] = [];
    const memos = new Map<string, Promise<string>>();
    const remints: string[] = [];
    let bound = "none";
    const run = (source: string | null) =>
      memoBorrowedEnsure(
        memos,
        "web-nous",
        source,
        async (id) => {
          order.push(`source:${id}`);
          bound = id;
        },
        async () => {
          order.push(`intern:${bound}`);
          return bound;
        },
        () => {
          remints.push(`drop:${bound}`);
          bound = "none";
        },
      );

    expect(await run("nous-a")).toBe("nous-a");
    expect(await run("nous-b")).toBe("nous-b");
    expect(await run(null)).toBe("none");
    expect({ order, remints }).toEqual({
      order: ["source:nous-a", "intern:nous-a", "source:nous-b", "intern:nous-b", "intern:none"],
      remints: ["drop:nous-a", "drop:nous-b"],
    });
  });
});
