import { PEWDriver, type ExpectationActor } from "@inhuman.tools/plexus-expectations/driver";

/** Test-only PEW subclass. Not a vendor completion class. */
export class TestDriverConnection extends PEWDriver {
  override async bootstrap(): Promise<void> {}
  protected override resolve(): ExpectationActor<any> {
    throw new Error("test driver has no actor");
  }
}
