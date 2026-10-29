/** Leftover honor path — see `drivers/mcp/actor.ts`. */
import type { WebExtractExpectation } from "@inhuman.tools/harness-model";
import { DemandIncomplete, ExpectationActor, type PEWDriver } from "@inhuman.tools/plexus-expectations/driver";

import type { WebSearchDriverConnection } from "./connection.js";

export class WebExtractActor extends ExpectationActor<WebExtractExpectation> {
  constructor(
    expectation: WebExtractExpectation,
    readonly web: WebSearchDriverConnection,
  ) {
    super(expectation, web as PEWDriver<WebExtractExpectation>);
  }

  protected async run(): Promise<void> {
    const raw = this.expectation.url.trim();
    DemandIncomplete.invariant(raw !== "", "url");
    if (this.signal.aborted) return;
    const result = await this.web.webExtract({
      url: raw,
      charLimit: this.expectation.charLimit,
      signal: this.signal,
    });
    // Abort after the interned call: complete() still SETTLEs and wins over cancel.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- leftover honor, same as Grok/MCP
    if (this.signal.aborted) return;
    this.complete(result);
  }
}
