export type WindowDropPhase = "idle" | "over" | "hot";

/** Files riding a drag. A drag with no files is not an add-image gesture. */
export function dragCarriesFiles(data: DataTransfer | null): boolean {
  if (data == null) return false;
  if (data.types.includes("Files")) return true;
  return [...data.items].some((item) => item.kind === "file");
}

/**
 * Window-level file drag. Entering the window is "over"; entering `hot` is
 * "hot". Leaving the hot target returns to "over" until the drag leaves the
 * window or ends. `relatedTarget` null is the window edge.
 */
export function bindWindowFileDrop(options: {
  readonly hot: () => Element | null;
  readonly onPhase: (phase: WindowDropPhase) => void;
  readonly onDrop: (files: readonly File[]) => void;
}): () => void {
  const root = document.documentElement;
  let depth = 0;
  let phase: WindowDropPhase = "idle";
  let insideHot = false;

  const paint = (next: WindowDropPhase): void => {
    if (phase === next) return;
    phase = next;
    options.onPhase(next);
  };

  const enteredHot = (event: DragEvent): boolean => {
    const target = options.hot();
    return target != null && event.target instanceof Node && target.contains(event.target);
  };

  const onEnter = (event: DragEvent): void => {
    if (!dragCarriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth += 1;
    if (enteredHot(event)) insideHot = true;
    paint(insideHot ? "hot" : "over");
  };

  const onOver = (event: DragEvent): void => {
    if (!dragCarriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer != null) event.dataTransfer.dropEffect = "copy";
    const nextInside = enteredHot(event);
    if (nextInside === insideHot && phase !== "idle") return;
    insideHot = nextInside;
    paint(insideHot ? "hot" : "over");
  };

  const onLeave = (event: DragEvent): void => {
    if (phase === "idle") return;
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) {
      depth = Math.max(0, depth - 1);
      return;
    }
    depth = 0;
    insideHot = false;
    paint("idle");
  };

  const finish = (): void => {
    depth = 0;
    insideHot = false;
    paint("idle");
  };

  const onDrop = (event: DragEvent): void => {
    if (!dragCarriesFiles(event.dataTransfer)) {
      finish();
      return;
    }
    event.preventDefault();
    const files = event.dataTransfer == null ? [] : [...event.dataTransfer.files];
    finish();
    if (files.length > 0) options.onDrop(files);
  };

  root.addEventListener("dragenter", onEnter);
  root.addEventListener("dragover", onOver);
  root.addEventListener("dragleave", onLeave);
  root.addEventListener("drop", onDrop);
  window.addEventListener("drop", finish);
  window.addEventListener("dragend", finish);

  return () => {
    root.removeEventListener("dragenter", onEnter);
    root.removeEventListener("dragover", onOver);
    root.removeEventListener("dragleave", onLeave);
    root.removeEventListener("drop", onDrop);
    window.removeEventListener("drop", finish);
    window.removeEventListener("dragend", finish);
    finish();
  };
}
