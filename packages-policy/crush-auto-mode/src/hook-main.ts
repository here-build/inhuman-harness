#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { hookOptionsFromEnv, runHook, structuredJudge } from "./hook.js";

const budget = 20_000;
const raw = readFileSync(0, "utf8");
const decision = await runHook(raw, structuredJudge(process.env), budget, hookOptionsFromEnv(process.env, raw));
if (decision !== undefined) process.stdout.write(JSON.stringify(decision));
process.exit(0);
