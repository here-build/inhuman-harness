/** Leftover honor path — see `drivers/mcp/actor.ts`. */
import type { WebSearchExpectation } from "@inhuman.tools/harness-model";
import { DemandIncomplete, ExpectationActor, type PEWDriver } from "@inhuman.tools/plexus-expectations/driver";

import type { WebSearchDriverConnection } from "./connection.js";

export class WebSearchActor extends ExpectationActor<WebSearchExpectation> {
  constructor(
    expectation: WebSearchExpectation,
    readonly web: WebSearchDriverConnection,
  ) {
    super(expectation, web as PEWDriver<WebSearchExpectation>);
  }

  protected async run(): Promise<void> {
    const query = this.expectation.query.trim();
    DemandIncomplete.invariant(query !== "", "query");
    if (this.signal.aborted) return;
    const result = await this.web.webSearch({
      query,
      limit: this.expectation.limit,
      signal: this.signal,
    });
    // Abort after the interned call: complete() still SETTLEs and wins over cancel.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- leftover honor, same as Grok/MCP
    if (this.signal.aborted) return;
    this.complete(result);
  }
}
