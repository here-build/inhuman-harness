import { z } from "zod";

export const driverConfigurationSchema = z.record(z.string(), z.unknown());
export const driverSecretsSchema = z.record(z.string(), z.unknown());
