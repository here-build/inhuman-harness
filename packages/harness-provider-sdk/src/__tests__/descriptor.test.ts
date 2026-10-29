import { DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import {
  applyDriverDefinition,
  isCompatibleContract,
  isProviderDescriptor,
  parseProviderDescriptor,
  PROVIDER_SDK_CONTRACT,
  providerBrand,
} from "../index.js";

const openaiCompat = {
  id: "openai-compat",
  name: "OpenAI-compatible",
  description: "OpenAI-compatible chat completions",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: "openai-compat",
      description: "OpenAI-compatible chat completions",
      abilityClaim: ["completion"],
      multiplicity: "add-as-secondary",
    },
  ],
};

describe("parseProviderDescriptor", () => {
  it("parses a provider and defaults importPath to the driver name", () => {
    const descriptor = parseProviderDescriptor(openaiCompat);
    expect(isProviderDescriptor(descriptor)).toBe(true);
    expect(descriptor[providerBrand.descriptor]).toBe(true);
    expect(descriptor).toMatchObject({
      id: "openai-compat",
      name: "OpenAI-compatible",
      contract: 1,
    });
    expect(descriptor.drivers).toEqual([
      {
        name: "openai-compat",
        description: "OpenAI-compatible chat completions",
        abilityClaim: ["completion"],
        multiplicity: "add-as-secondary",
        importPath: "openai-compat",
      },
    ]);
  });

  it("keeps an explicit importPath", () => {
    const descriptor = parseProviderDescriptor({
      ...openaiCompat,
      drivers: [{ ...openaiCompat.drivers[0], importPath: "openai-compat" }],
    });
    expect(descriptor.drivers[0]?.importPath).toBe("openai-compat");
  });

  it("rejects an empty provider id", () => {
    expect(() => parseProviderDescriptor({ ...openaiCompat, id: "  " })).toThrow(/non-empty string required/);
  });

  it("rejects an incompatible contract", () => {
    expect(() => parseProviderDescriptor({ ...openaiCompat, contract: 2 })).toThrow(/incompatible/);
    expect(isCompatibleContract(2)).toBe(false);
    expect(isCompatibleContract(PROVIDER_SDK_CONTRACT)).toBe(true);
  });

  it("rejects an unknown capability token", () => {
    expect(() =>
      parseProviderDescriptor({
        ...openaiCompat,
        drivers: [{ ...openaiCompat.drivers[0], abilityClaim: ["completion", "telepathy"] }],
      }),
    ).toThrow(/abilityClaim/);
  });

  it("rejects colliding driver names inside one descriptor", () => {
    expect(() =>
      parseProviderDescriptor({
        ...openaiCompat,
        drivers: [openaiCompat.drivers[0], { ...openaiCompat.drivers[0], description: "dup" }],
      }),
    ).toThrow(/collides/);
  });

  it("projects onto DriverSpec without touching process facts", () => {
    const descriptor = parseProviderDescriptor(openaiCompat);
    const spec = new DriverSpec();
    applyDriverDefinition(spec, descriptor.drivers[0]!);
    expect({
      name: spec.name,
      description: spec.description,
      importPath: spec.importPath,
      abilityClaim: [...spec.abilityClaim],
      multiplicity: spec.multiplicity,
      readyState: spec.readyState,
      error: spec.error,
    }).toEqual({
      name: "openai-compat",
      description: "OpenAI-compatible chat completions",
      importPath: "openai-compat",
      abilityClaim: ["completion"],
      multiplicity: "add-as-secondary",
      readyState: null,
      error: "",
    });
  });
});
