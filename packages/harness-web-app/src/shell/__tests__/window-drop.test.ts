// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { bindWindowFileDrop, dragCarriesFiles, type WindowDropPhase } from "../window-drop.js";

function drag(
  type: string,
  target: EventTarget,
  data: DataTransfer | null,
  related: EventTarget | null = null,
): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, relatedTarget: related });
  if (data != null) Object.defineProperty(event, "dataTransfer", { value: data });
  target.dispatchEvent(event);
  return event;
}

function filesData(): DataTransfer {
  const data = new DataTransfer();
  data.items.add(new File(["a"], "shot.png", { type: "image/png" }));
  return data;
}

describe("window file drop", () => {
  const phases: WindowDropPhase[] = [];
  const dropped: File[][] = [];
  let stop = (): void => undefined;

  afterEach(() => {
    stop();
    phases.length = 0;
    dropped.length = 0;
    document.body.replaceChildren();
  });

  it("ignores a drag that carries no files", () => {
    const hot = document.createElement("div");
    document.body.append(hot);
    stop = bindWindowFileDrop({
      hot: () => hot,
      onPhase: (phase) => phases.push(phase),
      onDrop: (files) => dropped.push([...files]),
    });
    drag("dragenter", document.documentElement, new DataTransfer());
    expect(phases).toEqual([]);
    expect(dragCarriesFiles(null)).toBe(false);
    expect(dragCarriesFiles(filesData())).toBe(true);
  });

  it("dims the window, heats the field, and adopts the drop anywhere", () => {
    const hot = document.createElement("div");
    const away = document.createElement("div");
    document.body.append(hot, away);
    stop = bindWindowFileDrop({
      hot: () => hot,
      onPhase: (phase) => phases.push(phase),
      onDrop: (files) => dropped.push([...files]),
    });

    const enter = drag("dragenter", document.documentElement, filesData());
    expect(enter.defaultPrevented).toBe(true);
    expect(phases).toEqual(["over"]);

    drag("dragover", hot, filesData());
    expect(phases).toEqual(["over", "hot"]);

    drag("dragover", away, filesData());
    expect(phases).toEqual(["over", "hot", "over"]);

    const data = filesData();
    drag("drop", away, data);
    expect(phases).toEqual(["over", "hot", "over", "idle"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.[0]?.name).toBe("shot.png");
  });

  it("returns to idle when the drag leaves the window", () => {
    const hot = document.createElement("div");
    document.body.append(hot);
    stop = bindWindowFileDrop({
      hot: () => hot,
      onPhase: (phase) => phases.push(phase),
      onDrop: (files) => dropped.push([...files]),
    });
    drag("dragenter", hot, filesData());
    expect(phases).toEqual(["hot"]);
    drag("dragleave", document.body, filesData(), null);
    expect(phases).toEqual(["hot", "idle"]);
    window.dispatchEvent(new DragEvent("dragend"));
    expect(dropped).toEqual([]);
  });

  it("does not report the same phase twice", () => {
    const hot = document.createElement("div");
    document.body.append(hot);
    const onPhase = vi.fn();
    stop = bindWindowFileDrop({ hot: () => hot, onPhase, onDrop: () => undefined });
    drag("dragover", document.body, filesData());
    drag("dragover", document.body, filesData());
    expect(onPhase.mock.calls.map((call) => call[0])).toEqual(["over"]);
  });
});
