import { syncing } from "@here.build/plexus";
import { WorkContainer } from "@inhuman.tools/plexus-expectations";

@syncing("harness:session:react")
export class ReACTChunk extends WorkContainer {
  get work(): WorkContainer[] {
    return [];
  }

  /**
   * Speculative OPEN PAGE round, enqueued before same-round task__* jobs.
   * Reducer no-ops unless an active page remains after those jobs.
   */
  @syncing accessor openPage: boolean = false;
  /** A conditional continuation resolved without opening another model round. */
  @syncing accessor skipped: boolean = false;

  /**
   * Text-only intern nudge. Not OPEN PAGE. Reducer keeps this round and
   * stamps the intern system note.
   */
  @syncing accessor intentContinue: boolean = false;

  /**
   * The previous round stopped on the provider's output limit. This round
   * continues it; the stop reason is a fact on that completion.
   */
  @syncing accessor truncated: boolean = false;

  constructor(
    props?:
      | {
          readonly openPage?: boolean;
          readonly intentContinue?: boolean;
          readonly truncated?: boolean;
          readonly skipped?: boolean;
        }
      | symbol,
  ) {
    super(props);
  }
}
