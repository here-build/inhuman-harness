/**
 * AbortSignal whose `aborted` and `reason` reads track in MobX.
 * Native AbortSignal is an illegal constructor; instances come from
 * AbortController / AbortSignal.abort|timeout|any, then {@link from}.
 */
import { action, createAtom } from "mobx";

const observed = new WeakSet<AbortSignal>();

const abortedDesc = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
const reasonDesc = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason");

function observe(signal: AbortSignal): void {
  if (abortedDesc?.get == null || reasonDesc?.get == null) {
    throw new Error("AbortSignal.aborted/reason are not getters");
  }
  const atom = createAtom("AbortSignal");
  const abortedGet = abortedDesc.get;
  const reasonGet = reasonDesc.get;
  Object.defineProperty(signal, "aborted", {
    configurable: true,
    enumerable: true,
    get(): boolean {
      atom.reportObserved();
      return abortedGet.call(signal);
    },
  });
  Object.defineProperty(signal, "reason", {
    configurable: true,
    enumerable: false,
    get(): unknown {
      atom.reportObserved();
      return reasonGet.call(signal);
    },
  });
  if (!abortedGet.call(signal)) {
    signal.addEventListener(
      "abort",
      action("abort", () => atom.reportChanged()),
      { once: true },
    );
  }
}

export class ObservableAbortSignal extends AbortSignal {
  static from(signal: AbortSignal): ObservableAbortSignal {
    if (!observed.has(signal)) {
      observe(signal);
      observed.add(signal);
    }
    Object.setPrototypeOf(signal, ObservableAbortSignal.prototype);
    return signal as ObservableAbortSignal;
  }

  static override abort(reason?: unknown): ObservableAbortSignal {
    return ObservableAbortSignal.from(AbortSignal.abort(reason));
  }

  static override timeout(milliseconds: number): ObservableAbortSignal {
    return ObservableAbortSignal.from(AbortSignal.timeout(milliseconds));
  }

  static override any(signals: AbortSignal[]): ObservableAbortSignal {
    return ObservableAbortSignal.from(AbortSignal.any(signals));
  }
}
