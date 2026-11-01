/** Provider-declared input support. Missing fields remain unknown, not text-only. */
export type ModelCapabilities = {
  inputModalities?: string[];
  supportsVision?: boolean;
};

export function modelCapabilitiesOf(row: object): ModelCapabilities | undefined {
  const rec = row as Record<string, unknown>;
  const architecture = rec.architecture;
  const routed =
    typeof architecture === "object" && architecture !== null
      ? (architecture as Record<string, unknown>).input_modalities
      : undefined;
  const inputModalities = modalitiesOf(rec.input_modalities) ?? modalitiesOf(routed);
  const supportsVision = typeof rec.supports_vision === "boolean" ? rec.supports_vision : undefined;
  if (inputModalities === undefined && supportsVision === undefined) return undefined;
  return {
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(supportsVision === undefined ? {} : { supportsVision }),
  };
}

function modalitiesOf(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string => typeof item === "string" && item.trim() !== "")
  ) {
    return undefined;
  }
  return value.map((item) => item.trim().toLowerCase());
}
