// @vitest-environment happy-dom

import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DensityScope, EmphasisScope, ProminenceScope, SurfaceScope, Visibility } from "../theme/index.js";
import { VoiceProvider, defineVoiceCatalog, enVoiceCatalog, useVoice } from "../voice/index.js";

function VoiceProbe() {
  const voice = useVoice();
  return h("span", { "data-testid": "voice-probe" }, `${voice.dialog.closeLabel}|${voice.select.emptyText}`);
}

function StatefulProbe() {
  const [count, setCount] = useState(0);
  return h(
    "button",
    {
      type: "button",
      "data-testid": "counter",
      onClick: () => setCount((c) => c + 1),
    },
    String(count),
  );
}

describe("voice and theme foundations", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("merges white-label and localized VoiceProvider overrides cleanly", () => {
    const partial = defineVoiceCatalog({
      dialog: { closeLabel: "Dismiss panel" },
    });

    act(() => {
      root.render(
        h(
          VoiceProvider,
          { catalog: partial },
          h(VoiceProvider, { catalog: { select: { emptyText: "Nothing available" } } }, h(VoiceProbe)),
        ),
      );
    });

    const probe = host.querySelector("[data-testid='voice-probe']");
    expect(probe?.textContent).toBe("Dismiss panel|Nothing available");
    expect(enVoiceCatalog.dialog.closeLabel).toBe("Close dialog");
  });

  it("renders all five Visibility modes while preserving state under React Activity hidden", () => {
    act(() => {
      root.render(h(Visibility, { mode: "visible" }, h(StatefulProbe)));
    });
    const btn = host.querySelector<HTMLButtonElement>("[data-testid='counter']");
    act(() => btn?.click());
    expect(btn?.textContent).toBe("1");

    act(() => {
      root.render(h(Visibility, { mode: "hidden" }, h(StatefulProbe)));
    });
    expect(host.querySelector("[data-testid='counter']")?.textContent).toBe("1");

    act(() => {
      root.render(h(Visibility, { mode: "visible" }, h(StatefulProbe)));
    });
    expect(host.querySelector("[data-testid='counter']")?.textContent).toBe("1");

    act(() => {
      root.render(h(Visibility, { mode: "display-none" }, h(StatefulProbe)));
    });
    const displayNone = host.querySelector("[data-visibility='display-none']");
    expect(displayNone?.getAttribute("aria-hidden")).toBe("true");
    expect(displayNone?.hasAttribute("hidden")).toBe(true);

    act(() => {
      root.render(h(Visibility, { mode: "invisible" }, h(StatefulProbe)));
    });
    const invisible = host.querySelector("[data-visibility='invisible']");
    expect(invisible?.getAttribute("aria-hidden")).toBe("true");

    act(() => {
      root.render(h(Visibility, { mode: "unmounted" }, h(StatefulProbe)));
    });
    expect(host.querySelector("[data-testid='counter']")).toBeNull();
  });

  it("assigns isolated axis scope attributes and boundary classes", () => {
    act(() => {
      root.render(
        h(
          SurfaceScope,
          { surface: "soft" },
          h(
            ProminenceScope,
            { prominence: "raised" },
            h(
              EmphasisScope,
              { emphasis: "accent" },
              h(DensityScope, { density: "compact" }, h("span", null, "Scoped")),
            ),
          ),
        ),
      );
    });

    expect(host.querySelector("[data-surface='soft']")?.className).toContain("surface-boundary");
    expect(host.querySelector("[data-prominence='raised']")?.className).toContain("prominence-boundary");
    expect(host.querySelector("[data-emphasis='accent']")?.className).toContain("emphasis-boundary");
    expect(host.querySelector("[data-density='compact']")?.className).toContain("density-boundary");
  });
});
