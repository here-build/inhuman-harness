import { NAMED_AGENTS_PLUGIN_NAME, namedAgentsPlugin } from "@/builtin-tools";

import { compilePluginInstall } from "../../toolkit/plugin-registry.js";

export const namedAgentsInstall = compilePluginInstall(NAMED_AGENTS_PLUGIN_NAME, namedAgentsPlugin.definition);
