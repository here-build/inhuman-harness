const installed = new URL("./modules/", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? "";
  if (parent.startsWith(installed) && specifier === "@inhuman.tools/harness-model") {
    throw new Error(`Portable runtime imported the aggregate model entry from ${parent}`);
  }
  if (parent.startsWith(installed) && /^(?:node:)?(?:fs(?:\/promises)?|child_process|worker_threads)$/.test(specifier)) {
    throw new Error(`Portable runtime imported a local host service: ${specifier} from ${parent}`);
  }
  const resolved = await nextResolve(specifier, context);
  if (parent.startsWith(installed) && /\.tsx?(?:\?|$)/.test(resolved.url)) {
    throw new Error(`Installed runtime imported source code instead of its compiled entry: ${resolved.url}`);
  }
  if (parent.startsWith(installed) && resolved.url.startsWith("file:") && !resolved.url.startsWith(installed)) {
    throw new Error(`Installed runtime escaped its isolated dependency closure: ${resolved.url}`);
  }
  if (/\/dist\/(?:kernel\/|source-fs\.js)/.test(resolved.url)) {
    throw new Error(`Portable runtime loaded a kernel or filesystem implementation: ${resolved.url} from ${parent}`);
  }
  return resolved;
}
