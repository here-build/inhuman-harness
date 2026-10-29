/**
 * Live canvas attunement. Ground RGB/L and depth are facts; the solved
 * {@link Theme} and paint binding are computed. Dual-dirty recolor is
 * "read `binding` again" — do not cache resolved RGB across a ground change.
 *
 * Renderer holds one of these and reacts: drop the structural buffer
 * always, drop the Frame when polarity flips (shiki must re-highlight).
 * `setActiveTheme` is not this store; the host is the sink.
 */
import { action, computed, observable } from "mobx";

import { attuneTheme, type ThemeBinding } from "./paint_theme.js";
import type { ColorDepth } from "../capabilities/index.js";
import type { Rgb } from "../lexicon/index.js";
import { buildTheme, groundFromRgb, REFERENCE_GROUND, type Theme } from "../theme/index.js";

export type ThemeAttuneOpts = {
  ground?: number;
  groundRgb?: Rgb;
  depth?: ColorDepth;
};

function rgbEq(a: Rgb | undefined, b: Rgb | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

export class ThemeStore {
  @observable accessor ground = REFERENCE_GROUND;
  @observable.ref accessor groundRgb: Rgb | undefined = undefined;
  @observable.ref accessor depth: ColorDepth = "truecolor";

  constructor(opts: ThemeAttuneOpts & { theme?: Theme } = {}) {
    if (opts.theme !== undefined) {
      this.ground = opts.theme.ground;
      this.groundRgb = opts.theme.groundRgb;
      if (opts.depth !== undefined) this.depth = opts.depth;
      return;
    }
    this.attune(opts);
  }

  @computed
  get theme(): Theme {
    return buildTheme({ ground: this.ground, groundRgb: this.groundRgb });
  }

  @computed
  get binding(): ThemeBinding {
    return attuneTheme({ theme: this.theme, depth: this.depth });
  }

  @action
  attune(opts: ThemeAttuneOpts): void {
    const nextDepth = opts.depth ?? this.depth;
    let nextGround = this.ground;
    let nextRgb = this.groundRgb;
    if (opts.groundRgb !== undefined) {
      nextRgb = opts.groundRgb;
      nextGround = groundFromRgb(opts.groundRgb.r, opts.groundRgb.g, opts.groundRgb.b);
    } else if (opts.ground !== undefined) {
      nextGround = opts.ground;
      nextRgb = undefined;
    }
    if (nextDepth === this.depth && nextGround === this.ground && rgbEq(nextRgb, this.groundRgb)) return;
    this.depth = nextDepth;
    this.ground = nextGround;
    this.groundRgb = nextRgb;
  }
}
