/** Kernel and session reads only. Choice/action constructors are `harness/ui`. */
import { EnvCapability } from "@here.build/arrival";
import { KernelRoot, SessionRoot } from "@inhuman.tools/harness-model";
import { DriverSpec } from "@inhuman.tools/plexus-expectations";
import { z } from "zod";

export const imageCapability = EnvCapability.define("harness/image", {
  configuration: {
    kernel: z.instanceof(KernelRoot),
    session: z.instanceof(SessionRoot).optional(),
  },
  symbols: (symbol, sz) => ({
    "harness/kernel/connections": symbol.rosetta`harness/kernel/connections: live ConnectionSpec list`(
      { input: [], output: [sz.list(sz.box)], provenance: "source" },
      function () {
        return Object.values(this.configuration.kernel.connections);
      },
    ),
    "harness/kernel/drivers": symbol.rosetta`harness/kernel/drivers: live DriverSpec list`(
      {
        input: [],
        inputRest: { abilityClaim: sz.foldName.optional() },
        output: [sz.list(sz.box)],
        provenance: "source",
      },
      function ({ abilityClaim: want }) {
        const all = Object.values(this.configuration.kernel.drivers);
        return want === undefined ? all : all.filter((item) => item.abilityClaim.includes(want));
      },
    ),
    // pipe, not source: pure projection of the driver ARGUMENT — mints nothing.
    "harness/kernel/offers": symbol.rosetta`harness/kernel/offers: class-bootstrap offers on a driver`(
      { input: [sz.box.pipe(z.instanceof(DriverSpec))], output: [sz.list(sz.box)], provenance: "pipe" },
      function (driver) {
        return [...driver.offers];
      },
    ),
    // Total read over a possibly-empty image: sessionless eval (kernel-scope
    // commands) and a missing key both read as "" — connect.scm's
    // `(equal? last "")` pins that contract. Not a door candidate.
    "harness/session/get-current":
      symbol.rosetta`harness/session/get-current: immutable current kv; "" when unset or sessionless`(
        { input: [sz.foldName], output: [sz.string], provenance: "source" },
        function (key) {
          const session = this.configuration.session;
          if (session === undefined) return "";
          return session.kvs[key] ?? "";
        },
      ),
    // Same total-read contract as get-current. A session reads its own snapshot
    // (mint + this conversation's writes); sessionless eval reads the live
    // kernel index. connect.scm falls back to a version-derived default.
    "harness/session/last-used-model":
      symbol.rosetta`harness/session/last-used-model: model last used on a connection; "" when none`(
        { input: [sz.foldName], output: [sz.string], provenance: "source" },
        function (connection) {
          const session = this.configuration.session;
          if (session?.lastUsedConnectionModel[connection] !== undefined) {
            return session.lastUsedConnectionModel[connection]!;
          }
          return this.configuration.kernel.lastUsedConnectionModel[connection] ?? "";
        },
      ),
  }),
});
