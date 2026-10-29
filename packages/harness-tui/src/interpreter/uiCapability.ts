/**
 * ONE NODE, TWO CONSTRUCTORS. Chrome branches on visible children, not on
 * which constructor minted the node. Activate is Enter on this node: children
 * present → drill; none → fire `:action` (a list of named leaves, in order)
 * and pass composer text as `:input`. The list is the sequence; Tea walks it.
 * Does not apply. Action names and params are plugin-owned — this capability
 * does not lower them.
 *
 * Callback chunks (`harness/confirm`, `harness/input`, `harness/open-url`,
 * `harness/notice`) are sugar over the same node. They bake `ui/resolve`
 * leaves; Tea evals them with `pending` in the env.
 */
import { EnvCapability } from "@here.build/arrival";
import { arrival } from "@here.build/arrival/host-internals";
import { keywordsOf } from "@inhuman.tools/harness-scheme/keywords";
import { z } from "zod";

@arrival.private
export class UiNode {
  constructor(
    readonly name: string,
    readonly description: string,
    readonly aliases: readonly string[],
    readonly health: "ok" | "degraded" | "failed",
    readonly healthAnnotation: string,
    readonly hotkey: string | undefined,
    readonly action: readonly UiNode[],
    readonly alternateActions: readonly UiNode[],
    readonly choices: readonly UiNode[],
    readonly op: string | null,
    readonly params: Readonly<Record<string, unknown>>,
    readonly secret: boolean = false,
    readonly annotation: string = "",
  ) {}
}

function resolveLeaf(name: string, pending: string, params: Record<string, unknown>, hotkey?: string): UiNode {
  return new UiNode(name, "", [], "ok", "", hotkey, [], [], [], "ui/resolve", { pending, ...params });
}

export const uiCapability = EnvCapability.define("harness/ui", {
  configuration: {
    pending: z.string().optional(),
  },
  symbols: (symbol, sz) => {
    const nodes = sz.list(sz.instance(UiNode)).default([]);
    const health = sz.foldName.pipe(sz.enum(["ok", "degraded", "failed"])).default("ok");
    const params = sz.dictRecord(sz.foldName, sz.union([sz.foldName, sz.string, sz.box])).default({});
    return {
      "harness/choice": symbol.rosetta`harness/choice: a place — chrome, optional activate, children`(
        {
          input: [],
          inputRest: {
            name: sz.string.default(""),
            description: sz.string.default(""),
            annotation: sz.string.default(""),
            alias: sz.list(sz.string).default([]),
            "health-status": health,
            "health-annotation": sz.string.default(""),
            hotkey: sz.string.optional(),
            action: nodes,
            "alternate-actions": nodes,
            choices: nodes,
            secret: sz.boolean.default(false),
          },
          output: [sz.instance(UiNode)],
          provenance: "pipe",
        },
        (kwargs) =>
          new UiNode(
            kwargs.name,
            kwargs.description,
            kwargs.alias,
            kwargs["health-status"],
            kwargs["health-annotation"],
            kwargs.hotkey,
            kwargs.action,
            kwargs["alternate-actions"],
            kwargs.choices,
            null,
            {},
            kwargs.secret,
            kwargs.annotation,
          ),
      ),
      "harness/action": symbol.rosetta`harness/action: a named plugin action; does not apply`(
        {
          input: [sz.foldName],
          inputRest: sz.dynamic,
          output: [sz.instance(UiNode)],
          provenance: "pipe",
        },
        (op, ...rest) => {
          const kwargs = keywordsOf("harness/action", rest, {
            name: sz.string.optional(),
            description: sz.string.default(""),
            hotkey: sz.string.optional(),
            alias: sz.list(sz.string).default([]),
            params,
          });
          return new UiNode(
            kwargs.name ?? op,
            kwargs.description,
            kwargs.alias,
            "ok",
            "",
            kwargs.hotkey,
            [],
            [],
            [],
            op,
            kwargs.params,
          );
        },
      ),
      // The four callback sugar verbs are `source`, not `pipe`: each reads
      // `this.configuration.pending` into the minted node — external config
      // data enters the result, so the crossing mints an origin.
      "harness/confirm": symbol.rosetta`harness/confirm: callback confirm in the omnibox`(
        {
          input: [],
          inputRest: {
            title: sz.string.default("Confirm"),
            name: sz.string.optional(),
            description: sz.string.default(""),
          },
          output: [sz.instance(UiNode)],
          provenance: "source",
        },
        function (kwargs) {
          const pending = this.configuration.pending ?? "";
          const title = kwargs.name ?? kwargs.title;
          return new UiNode(
            title,
            kwargs.description,
            [],
            "ok",
            "",
            undefined,
            [resolveLeaf("Confirm", pending, { kind: "accept" })],
            [resolveLeaf("Cancel", pending, { kind: "cancel" }, "escape")],
            [],
            null,
            {},
          );
        },
      ),
      "harness/input": symbol.rosetta`harness/input: callback text in the omnibox remainder`(
        {
          input: [],
          inputRest: {
            name: sz.string.default("Input"),
            description: sz.string.default(""),
            secret: sz.boolean.default(false),
          },
          output: [sz.instance(UiNode)],
          provenance: "source",
        },
        function (kwargs) {
          const pending = this.configuration.pending ?? "";
          return new UiNode(
            kwargs.name,
            kwargs.description,
            [],
            "ok",
            "",
            undefined,
            [resolveLeaf(kwargs.name, pending, { kind: "text", input: "" })],
            [resolveLeaf("Cancel", pending, { kind: "cancel" }, "escape")],
            [],
            null,
            {},
            kwargs.secret,
          );
        },
      ),
      "harness/open-url": symbol.rosetta`harness/open-url: open a link; optional text/password remainder`(
        {
          input: [],
          inputRest: {
            url: sz.string,
            name: sz.string.default("Continue"),
            description: sz.string.default(""),
            input: sz.foldName.pipe(sz.enum(["text", "password"])).optional(),
          },
          output: [sz.instance(UiNode)],
          provenance: "source",
        },
        function (kwargs) {
          const pending = this.configuration.pending ?? "";
          const wantsInput = kwargs.input !== undefined;
          return new UiNode(
            kwargs.name,
            kwargs.description,
            [],
            "ok",
            "",
            undefined,
            [
              resolveLeaf(
                "Continue",
                pending,
                wantsInput ? { kind: "text", input: "" } : { kind: "opened", url: kwargs.url },
              ),
            ],
            [resolveLeaf("Cancel", pending, { kind: "cancel" }, "escape")],
            [],
            null,
            { url: kwargs.url },
            kwargs.input === "password",
          );
        },
      ),
      "harness/notice": symbol.rosetta`harness/notice: callback notice in the omnibox`(
        {
          input: [],
          inputRest: {
            message: sz.string.default(""),
            name: sz.string.optional(),
            description: sz.string.default(""),
          },
          output: [sz.instance(UiNode)],
          provenance: "source",
        },
        function (kwargs) {
          const pending = this.configuration.pending ?? "";
          const title = kwargs.name ?? (kwargs.message === "" ? "Notice" : kwargs.message);
          return new UiNode(
            title,
            kwargs.description === "" ? kwargs.message : kwargs.description,
            [],
            "ok",
            "",
            undefined,
            [resolveLeaf("Dismiss", pending, { kind: "dismiss" })],
            [resolveLeaf("Dismiss", pending, { kind: "dismiss" }, "escape")],
            [],
            null,
            {},
          );
        },
      ),
    };
  },
});
