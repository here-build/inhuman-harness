/** Process-local brands. Not an expectation intern slot and not a vendor provider. */
export const connectionsBrand = {
  registry: Symbol.for("@/connections:registry"),
} as const;
