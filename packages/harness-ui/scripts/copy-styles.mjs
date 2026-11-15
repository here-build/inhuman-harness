import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const srcStyles = path.join(pkgRoot, "src", "styles");
const distStyles = path.join(pkgRoot, "dist", "styles");

await mkdir(distStyles, { recursive: true });
await cp(srcStyles, distStyles, { recursive: true });
