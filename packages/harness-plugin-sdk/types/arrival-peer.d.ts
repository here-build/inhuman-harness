/**
 * Optional peer `@here.build/arrival`. Present so this package typechecks
 * without installing Arrival. When the peer is installed, its types win.
 */
declare module "@here.build/arrival" {
  export class EnvCapability {
    readonly name: string;
    readonly spec: object;
    exports(): Promise<ReadonlySet<string>>;
  }
}
