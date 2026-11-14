import { describe, expect, it } from "vitest";

import { capAuthorization, classOverrideIn, overlayUserLayer, withClassMode } from "../class-modes.js";
import { layersOf } from "../layers.js";
import { resolveCall } from "../resolve.js";

const ask = (texts: { user?: string; project?: string; session?: string }, mode: "manual" | "auto" | "yolo") =>
  resolveCall(layersOf({ user: texts.user ?? "", project: texts.project ?? "", session: texts.session ?? "" }), {
    mode,
    cluster: "bash",
    tier: "ask",
    classes: ["package-install"],
    unattended: false,
  });

describe("class modes", () => {
  it("an override holds in every mode, reads back, and clears to nothing", () => {
    const set = withClassMode(undefined, "package-install", "always");
    const session = JSON.stringify(set);
    expect({
      back: classOverrideIn(set, "package-install"),
      manual: ask({ session }, "manual").resolver.kind,
      auto: ask({ session }, "auto").resolver.kind,
      cleared: withClassMode(set, "package-install", null),
    }).toEqual({ back: "always", manual: "allow", auto: "allow", cleared: {} });
  });

  it("a risky class never stores always", () => {
    expect({
      set: classOverrideIn(withClassMode(undefined, "credential", "always"), "credential"),
      cap: classOverrideIn(capAuthorization({ auto: { classes: { credential: "allow" } } }), "credential"),
    }).toEqual({ set: "auto", cap: "auto" });
  });

  it("a project overlay loosens the user layer, and the repo file still caps it", () => {
    const overlay = JSON.stringify(withClassMode(undefined, "package-install", "auto"));
    const user = overlayUserLayer("", overlay);
    expect({
      loosened: ask({ user }, "manual").resolver.kind,
      capped: ask({ user, project: JSON.stringify({ manual: { classes: { "package-install": "human" } } }) }, "manual")
        .resolver.kind,
      invalidUserStays: overlayUserLayer("{not json", overlay),
    }).toEqual({ loosened: "judge", capped: "human", invalidUserStays: "{not json" });
  });
});
