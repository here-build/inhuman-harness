/**
 * Pointer-keyed mount table. First encounter constructs; MST destruction
 * disposes. No replicated id. MountLocal lives here, not on PaintLocal.
 */
import { DefaultedWeakMap } from "@here.build/collections";
import type { LayoutNode, ProgressSite } from "@inhuman.tools/quickdraw/layout";
import type { BirthSite } from "@inhuman.tools/quickdraw/runtime";
import { observable, runInAction } from "mobx";
import { addDisposer } from "mobx-state-tree";

import type { PaintNodeInstance } from "./paint-dom.js";
import type { MountLocal } from "./paint-types.js";

export interface PreparedSubtree {
  readonly width: number;
  readonly root: LayoutNode;
  readonly measured: { w: number; h: number };
  readonly birthSites: readonly BirthSite[];
  readonly progressSites: readonly ProgressSite[];
}

export interface RetainedWidget {
  readonly node: PaintNodeInstance;
  prepare(width: number): PreparedSubtree;
  markDirty(): void;
  dispose(): void;
}

export type WidgetFactory = (node: PaintNodeInstance, parent: RetainedWidget | null) => RetainedWidget;

export class WidgetHost {
  readonly #mounted = new WeakMap<PaintNodeInstance, RetainedWidget>();
  readonly #locals = new DefaultedWeakMap<PaintNodeInstance, MountLocal>((node) => {
    this.#hits += 1;
    const local = observable({
      collapsed: defaultCollapsed(node),
      hitKey: `paint:${this.#hits}`,
    });
    this.#byHit.set(local.hitKey, node);
    return local;
  });
  readonly #byHit = new Map<string, PaintNodeInstance>();
  readonly #factory: WidgetFactory;
  #hits = 0;

  constructor(factory: WidgetFactory) {
    this.#factory = factory;
  }

  widgetFor(node: PaintNodeInstance, parent: RetainedWidget | null = null): RetainedWidget {
    const hit = this.#mounted.get(node);
    if (hit !== undefined) return hit;
    const widget = this.#factory(node, parent);
    this.#mounted.set(node, widget);
    addDisposer(node, () => {
      widget.dispose();
      this.forget(node);
    });
    return widget;
  }

  localFor(node: PaintNodeInstance): MountLocal {
    return this.#locals.get(node);
  }

  /**
   * Flip `MountLocal.collapsed` for `blockId`. Exact `#byHit` hit, else strip
   * trailing `:segment`s until one hits — thinking stamps `paint:N:thought`.
   */
  toggleCollapsed(blockId: string): void {
    const node = this.#nodeForCollapsed(blockId);
    if (node === undefined) return;
    const local = this.localFor(node);
    runInAction(() => {
      local.collapsed = !local.collapsed;
    });
    this.#mounted.get(node)?.markDirty();
  }

  #nodeForCollapsed(blockId: string): PaintNodeInstance | undefined {
    let key = blockId;
    const seen = new Set<string>();
    while (true) {
      const node = this.#byHit.get(key);
      if (node !== undefined) return node;
      if (!key.includes(":")) return undefined;
      const parent = key.slice(0, key.lastIndexOf(":"));
      if (seen.has(parent)) return undefined;
      seen.add(parent);
      key = parent;
    }
  }

  forget(node: PaintNodeInstance): void {
    if (this.#locals.has(node)) this.#byHit.delete(this.#locals.get(node).hitKey);
    this.#locals.delete(node);
    this.#mounted.delete(node);
  }
}

function defaultCollapsed(node: PaintNodeInstance): boolean {
  return !("agent" in node && node.agent === true && "indent" in node && node.indent === true);
}
