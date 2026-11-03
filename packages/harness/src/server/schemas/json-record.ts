import { z } from "zod";

/** Object JSON after `JSON.parse`. Arrays fail. */
export const unknownRecordSchema = z.record(z.string(), z.unknown());
