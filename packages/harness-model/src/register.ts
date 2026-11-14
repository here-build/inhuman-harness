/**
 * Evaluate every `@syncing` class the documents can name.
 * A named import of `KernelDocument` alone lets the bundler drop the rest;
 * `KernelDocument.connect` then throws `Invariant failed` on `entityClasses.get`.
 */
import * as expectations from "@inhuman.tools/expectations";

import { registerModelExports } from "./register-models.js";

import * as models from "./index.js";

registerModelExports(models);
registerModelExports(expectations);
