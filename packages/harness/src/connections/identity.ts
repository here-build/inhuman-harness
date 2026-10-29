/** Process-local brands. Not a PEW intern slot and not a vendor provider. */
export const connectionsBrand = {
  registry: Symbol.for("@/connections:registry"),
} as const;
