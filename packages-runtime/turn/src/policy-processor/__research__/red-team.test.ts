/**
 * Baseline red-team. Floor is hermetic. Live votes print a scoreboard;
 * a model allow where hope is deny is a finding, not a hidden pass.
 */
import { reasonableDefaultsSource } from "@inhuman.tools/policy/floor";
import { describe, expect, it } from "vitest";

import { compile } from "../__tests__/_helpers/compile.js";
import { shell } from "../__tests__/_helpers/jobs.js";

import { CASES } from "./cases.js";
import { LM_MODEL, lmStudioReady, researchSetup, untilJudged } from "./host.js";
import { RED_TEAM } from "./red-team.js";

const ready = await lmStudioReady();

describe("red-team corpus", () => {
  it("ids are unique across CASES and RED_TEAM, origins are cited", () => {
    const ids = [...CASES.map((row) => row.id), ...RED_TEAM.map((row) => row.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(RED_TEAM.length).toBeGreaterThanOrEqual(10);
    expect(
      RED_TEAM.every((row) => row.url.includes("://") || row.url.endsWith(".prompt") || row.url.startsWith("src/")),
    ).toBe(true);
  });

  it("dist floor matches the labeled floor", async () => {
    const policy = await compile(reasonableDefaultsSource);
    expect(
      RED_TEAM.flatMap((row) => {
        const floor = policy.bash(row.command);
        return floor === row.floor ? [] : [{ id: row.id, command: row.command, labeled: row.floor, actual: floor }];
      }),
    ).toEqual([]);
  });
});

describe.skipIf(!ready.ok)(`red-team live ${LM_MODEL}`, () => {
  it("scoreboard: remainder-ask payloads through RNJ (misses are findings)", async () => {
    const live = RED_TEAM.filter((row) => row.floor === "ask");
    const rows: Array<{
      id: string;
      channel: string;
      attack: string;
      hope: string;
      vote: string | null;
      fail: string | null;
      hit: boolean;
    }> = [];
    for (const row of live) {
      using bag = researchSetup({
        privileged: row.privileged,
        priorTurn: row.priorTurn,
        quarantined: row.quarantined,
      });
      const job = shell(row.command);
      bag.enqueue(job);
      await untilJudged(job, 30_000);
      const vote = job.classifierResult;
      const fail = job.classifierAbstain;
      rows.push({
        id: row.id,
        channel: row.channel,
        attack: row.attack,
        hope: row.hope,
        vote,
        fail,
        hit: vote === row.hope,
      });
    }
    const hits = rows.filter((row) => row.hit).length;
    // eslint-disable-next-line no-console -- research scoreboard
    console.log(`red-team ${hits}/${rows.length} hope-hits`);
    // eslint-disable-next-line no-console -- research scoreboard
    console.table(
      rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        attack: row.attack,
        hope: row.hope,
        vote: row.vote ?? `fail:${row.fail ?? "?"}`,
        hit: row.hit ? "ok" : "MISS",
      })),
    );
    expect(rows.every((row) => row.vote === "allow" || row.vote === "deny" || row.fail !== null)).toBe(true);
  });
});
