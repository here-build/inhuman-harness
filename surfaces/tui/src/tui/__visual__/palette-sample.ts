import type { LayoutNode } from "@inhuman.tools/quickdraw/layout";

/** Collect every concrete fg color painted under a prepared root. */
export function paletteOf(node: LayoutNode | null): Set<string> {
  const out = new Set<string>();
  if (node === null) return out;
  const visit = (n: LayoutNode): void => {
    const style = "style" in n ? (n.style as unknown) : undefined;
    if (style !== null && typeof style === "object") {
      const s = style as { fgRgb?: { r: number; g: number; b: number }; fg?: number };
      if (s.fgRgb !== undefined) out.add(`${s.fgRgb.r},${s.fgRgb.g},${s.fgRgb.b}`);
      else if (s.fg !== undefined) out.add(`i${s.fg}`);
    }
    if ("children" in n && n.children !== undefined) for (const child of n.children) visit(child);
    if ("summary" in n && n.summary !== undefined) visit(n.summary);
  };
  visit(node);
  return out;
}
