/** Keep every exported model constructor reachable for side-effect registration. */
export function registerModelExports(exports: Readonly<Record<string, unknown>>): void {
  for (const value of Object.values(exports)) {
    if (typeof value === "function") void Reflect.get(value, "modelName");
  }
}
