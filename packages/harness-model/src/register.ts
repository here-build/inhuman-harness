/**
 * Evaluate every `@syncing` class the documents can name.
 * A named import of `KernelPlexus` alone lets the bundler drop the rest;
 * `Plexus.connect` then throws `Invariant failed` on `entityClasses.get`.
 */
import * as pew from "@inhuman.tools/plexus-expectations";

import * as models from "./index.js";
import { registerModelExports } from "./register-models.js";

registerModelExports(models);
registerModelExports(pew);
