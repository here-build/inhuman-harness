import { expect, test } from "vitest";

import type { ColorDepth } from "../../capabilities/index.js";
import { birthLive, type LayoutNode } from "../../layout/index.js";
import type { PaintSnapshot } from "../frame.js";
import {
  demoteDepth,
  detectTransport,
  resolvePresentConfig,
  type PresentConfig,
  type Transport,
} from "../present_profile.js";
import { stepThoughtBirthFromSnapshot } from "../thought_birth.js";

type ProfileRow =
  | {
      name: string;
      env: NodeJS.ProcessEnv;
      transport?: Transport;
      probedDepth?: ColorDepth;
      probedSync2026?: boolean;
      config?: Partial<PresentConfig>;
    }
  | { name: string; demote: readonly [ColorDepth, ColorDepth, ColorDepth] };

test.each<ProfileRow>([
  {
    name: "local",
    env: {},
    probedDepth: "truecolor",
    probedSync2026: true,
    transport: "local",
    config: {
      profile: "local",
      targetFps: 120,
      colorDepth: "truecolor",
      flourish: "full",
      flourishHz: 30,
    },
  },
  {
    name: "SSH_CONNECTION",
    env: { SSH_CONNECTION: "10.0.0.1 1 2 3" },
    probedDepth: "truecolor",
    transport: "ssh",
    config: {
      profile: "ssh",
      targetFps: 30,
      colorDepth: "ansi256",
      flourish: "sparse",
      flourishHz: 15,
    },
  },
  {
    name: "QD_PROFILE force ssh",
    env: { QD_PROFILE: "ssh", SSH_CONNECTION: "" },
    transport: "ssh",
  },
  {
    name: "QD_PROFILE force local",
    env: { QD_PROFILE: "local", SSH_CONNECTION: "1 2 3 4" },
    transport: "local",
  },
  {
    name: "QD_FPS/QD_COLOR",
    env: { QD_FPS: "60", QD_COLOR: "ansi16", QD_FLOURISH: "off" },
    probedDepth: "truecolor",
    config: { targetFps: 60, colorDepth: "ansi16", flourishHz: 0 },
  },
  {
    name: "NO_COLOR local",
    env: { NO_COLOR: "1" },
    config: { colorDepth: "mono", colorSource: "default" },
  },
  {
    name: "NO_COLOR ssh",
    env: { NO_COLOR: "1", SSH_CONNECTION: "10.0.0.1 1 2 3" },
    config: { colorDepth: "mono" },
  },
  { name: "cap truecolor→ansi256", demote: ["truecolor", "ansi256", "ansi256"] },
  { name: "cap keeps ansi16", demote: ["ansi16", "ansi256", "ansi16"] },
  { name: "cap same truecolor", demote: ["truecolor", "truecolor", "truecolor"] },
  { name: "mono floor vs ansi256", demote: ["mono", "ansi256", "mono"] },
  { name: "mono floor vs truecolor", demote: ["mono", "truecolor", "mono"] },
])("present profile: $name", (row) => {
  if ("demote" in row) {
    expect(demoteDepth(row.demote[0], row.demote[1])).toEqual(row.demote[2]);
    return;
  }
  if (row.transport !== undefined) {
    expect(detectTransport(row.env)).toEqual(row.transport);
  }
  if (row.config !== undefined) {
    expect(
      resolvePresentConfig({
        env: row.env,
        probedDepth: row.probedDepth,
        probedSync2026: row.probedSync2026,
      }),
    ).toMatchObject(row.config);
  }
});

test("thought birth collects sites and advances W", () => {
  const node: LayoutNode = {
    type: "text",
    content: "abcdefghijklmnop",
    live: birthLive({
      siteId: "s1",
      T: 40,
      offset: 0,
      target: 0.6,
      birthFloor: 0.12,
      falloff: 0.8,
      tipWindow: 12,
    }),
  };
  const snapshot: PaintSnapshot = {
    tree: { root: node, boxes: {} },
    getBox: () => undefined,
  };
  const frontiers = new Map();
  const a = stepThoughtBirthFromSnapshot(snapshot, frontiers, 0);
  const w0 = a.get("s1")?.W ?? 0;
  const b = stepThoughtBirthFromSnapshot(snapshot, frontiers, 200);
  expect({
    sites: [...a.keys()],
    advanced: (b.get("s1")?.W ?? 0) > w0,
    T: node.live && "T" in node.live ? node.live.T : null,
  }).toEqual({ sites: ["s1"], advanced: true, T: 40 });
});
