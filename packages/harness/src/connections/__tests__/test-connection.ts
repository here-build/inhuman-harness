import { ExpectationDriver, type ExpectationActor } from "@inhuman.tools/expectations/driver";

/** Test-only ExpectationDriver subclass. Not a vendor completion class. */
export class TestDriverConnection extends ExpectationDriver {
  override async bootstrap(): Promise<void> {}
  protected override resolve(): ExpectationActor<any> {
    throw new Error("test driver has no actor");
  }
}

export class OtherDriverConnection extends ExpectationDriver {
  override async bootstrap(): Promise<void> {}
  protected override resolve(): ExpectationActor<any> {
    throw new Error("other test driver has no actor");
  }
}
