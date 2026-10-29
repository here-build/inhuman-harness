#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { hookOptionsFromEnv, runHook } from "@inhuman.tools/policy-crush/hook";

import { sageJudge } from "./index.js";

const budget = 20_000;
const raw = readFileSync(0, "utf8");
const decision = await runHook(raw, sageJudge(process.env), budget, hookOptionsFromEnv(process.env, raw));
if (decision !== undefined) process.stdout.write(JSON.stringify(decision));
process.exit(0);
