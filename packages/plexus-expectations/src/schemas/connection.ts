import { z } from "zod";

export const pewConfigurationSchema = z.record(z.string(), z.unknown());
export const pewSecretsSchema = z.record(z.string(), z.unknown());
