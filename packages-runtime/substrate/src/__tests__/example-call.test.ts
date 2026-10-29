// synthesizeExampleCall(qualifiedName, schema) → one call string.

import { describe, expect, it } from "vitest";

import { synthesizeExampleCall } from "../example-call.js";
import type { ToolJsonSchema } from "../tool-schema.js";

interface ExampleRow {
  name: string;
  tool: string;
  schema: ToolJsonSchema | undefined;
  expr: string;
}

function example(name: string, tool: string, schema: ToolJsonSchema | undefined, expr: string): ExampleRow {
  return { name, tool, schema, expr };
}

const EXAMPLE_ROWS: readonly ExampleRow[] = [
  example("no schema", "filesystem_read_text_file", undefined, "(filesystem_read_text_file)"),
  example("empty object schema", "ping_check", { type: "object" }, "(ping_check)"),
  example(
    "all-optional schema",
    "search_run",
    { type: "object", properties: { verbose: { type: "boolean" }, limit: { type: "number" } } },
    "(search_run)",
  ),
  example(
    "string hole",
    "filesystem_read_text_file",
    { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    "(filesystem_read_text_file :path #|string|#)",
  ),
  example(
    "number and integer holes",
    "paginate",
    {
      type: "object",
      properties: { count: { type: "number" }, page: { type: "integer" } },
      required: ["count", "page"],
    },
    "(paginate :count #|number|# :page #|number|#)",
  ),
  example(
    "numeric bounds do not change the hole",
    "billing_charge",
    {
      type: "object",
      properties: { amount: { type: "number", minimum: 5, maximum: 10 } },
      required: ["amount"],
    },
    "(billing_charge :amount #|number|#)",
  ),
  example(
    "boolean hole",
    "deploy",
    { type: "object", properties: { dryRun: { type: "boolean" } }, required: ["dryRun"] },
    "(deploy :dryRun #|boolean|#)",
  ),
  example(
    "enum uses the first member",
    "weather_get_forecast",
    {
      type: "object",
      properties: { unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
      required: ["unit"],
    },
    '(weather_get_forecast :unit "celsius")',
  ),
  example(
    "missing type falls back to a string hole",
    "misc_tool",
    { type: "object", properties: { payload: {} }, required: ["payload"] },
    "(misc_tool :payload #|string|#)",
  ),
  example(
    "array of strings",
    "label_apply",
    {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    },
    "(label_apply :tags [#|string|#])",
  ),
  example(
    "array with no items schema",
    "slack_send",
    { type: "object", properties: { channels: { type: "array" } }, required: ["channels"] },
    "(slack_send :channels [#|string|#])",
  ),
  example(
    "minItems 3",
    "label_apply",
    {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" }, minItems: 3 } },
      required: ["tags"],
    },
    "(label_apply :tags [#|string|# #|string|# #|string|#])",
  ),
  example(
    "minItems 0 still shows one item",
    "label_apply",
    {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" }, minItems: 0 } },
      required: ["tags"],
    },
    "(label_apply :tags [#|string|#])",
  ),
  example(
    "maxItems 0",
    "label_apply",
    {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" }, maxItems: 0 } },
      required: ["tags"],
    },
    "(label_apply :tags [])",
  ),
  example(
    "maxItems above the one-item floor",
    "label_apply",
    {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" }, maxItems: 2 } },
      required: ["tags"],
    },
    "(label_apply :tags [#|string|#])",
  ),
  example(
    "minItems greater than maxItems lands on maxItems",
    "label_apply",
    {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" }, minItems: 5, maxItems: 2 } },
      required: ["tags"],
    },
    "(label_apply :tags [#|string|# #|string|#])",
  ),
  example(
    "minItems repeats an object item",
    "airline_book",
    {
      type: "object",
      properties: {
        flights: {
          type: "array",
          minItems: 2,
          items: { type: "object", properties: { origin: { type: "string" } }, required: ["origin"] },
        },
      },
      required: ["flights"],
    },
    "(airline_book :flights [{:origin #|string|#} {:origin #|string|#}])",
  ),
  example(
    "const wins over examples, default, and enum",
    "t",
    {
      type: "object",
      properties: {
        unit: {
          type: "string",
          const: "kelvin",
          examples: ["celsius"],
          default: "fahrenheit",
          enum: ["celsius", "fahrenheit"],
        },
      },
      required: ["unit"],
    },
    '(t :unit "kelvin")',
  ),
  example(
    "examples[0] wins over default and enum",
    "t",
    {
      type: "object",
      properties: {
        unit: { type: "string", examples: ["celsius", "fahrenheit"], default: "fahrenheit", enum: ["a", "b"] },
      },
      required: ["unit"],
    },
    '(t :unit "celsius")',
  ),
  example(
    "default wins over enum",
    "t",
    {
      type: "object",
      properties: { unit: { type: "string", default: "fahrenheit", enum: ["a", "b"] } },
      required: ["unit"],
    },
    '(t :unit "fahrenheit")',
  ),
  example(
    "null const renders nil",
    "t",
    { type: "object", properties: { parent: { type: "string", const: null } }, required: ["parent"] },
    "(t :parent nil)",
  ),
  example(
    "numeric zero default is kept",
    "t",
    {
      type: "object",
      properties: { offset: { type: "number", default: 0, minimum: 5 } },
      required: ["offset"],
    },
    "(t :offset 0)",
  ),
  example(
    "optional params are omitted",
    "search_run",
    {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
    "(search_run :query #|string|#)",
  ),
  example(
    "a later required field still comes first",
    "t",
    {
      type: "object",
      properties: { b: { type: "number" }, a: { type: "string" } },
      required: ["a"],
    },
    "(t :a #|string|#)",
  ),
  example(
    "required fields keep declared order",
    "t",
    {
      type: "object",
      properties: { z: { type: "string" }, a: { type: "string" } },
      required: ["z", "a"],
    },
    "(t :z #|string|# :a #|string|#)",
  ),
  example(
    "object param recurses into its required fields",
    "search_run",
    {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" }, includeArchived: { type: "boolean" } },
          required: ["status"],
        },
      },
      required: ["filter"],
    },
    "(search_run :filter {:status #|string|#})",
  ),
  example(
    "nested optional fields are omitted",
    "search_run",
    {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" }, note: { type: "string" } },
          required: ["status"],
        },
      },
      required: ["filter"],
    },
    "(search_run :filter {:status #|string|#})",
  ),
  example(
    "a second object level collapses",
    "configure",
    {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            inner: { type: "object", properties: { deep: { type: "string" } }, required: ["deep"] },
          },
          required: ["inner"],
        },
      },
      required: ["config"],
    },
    "(configure :config {:inner {}})",
  ),
  example(
    "array of objects",
    "airline_book_reservation",
    {
      type: "object",
      properties: {
        flights: {
          type: "array",
          items: {
            type: "object",
            properties: { origin: { type: "string" }, destination: { type: "string" }, seatCount: { type: "number" } },
            required: ["origin", "destination"],
          },
        },
      },
      required: ["flights"],
    },
    "(airline_book_reservation :flights [{:origin #|string|# :destination #|string|#}])",
  ),
  example(
    "a second object level through an array collapses",
    "grid_fill",
    {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              cells: {
                type: "array",
                items: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
              },
            },
            required: ["cells"],
          },
        },
      },
      required: ["rows"],
    },
    "(grid_fill :rows [{:cells [{}]}])",
  ),
  example(
    "two array levels before an object still bound object nesting",
    "grid_fill",
    {
      type: "object",
      properties: {
        matrix: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                foo: { type: "object", properties: { bar: { type: "string" } }, required: ["bar"] },
              },
              required: ["foo"],
            },
          },
        },
      },
      required: ["matrix"],
    },
    "(grid_fill :matrix [[{:foo {}}]])",
  ),
  example(
    "three array levels terminate",
    "cube_fill",
    {
      type: "object",
      properties: {
        cube: { type: "array", items: { type: "array", items: { type: "array", items: { type: "string" } } } },
      },
      required: ["cube"],
    },
    "(cube_fill :cube [[[#|string|#]]])",
  ),
  example(
    "properties without an object type are still an object",
    "t",
    {
      type: "object",
      properties: { meta: { properties: { id: { type: "string" } }, required: ["id"] } },
      required: ["meta"],
    },
    "(t :meta {:id #|string|#})",
  ),
  example(
    "dict and list literals leave holes unquoted",
    "t",
    {
      type: "object",
      properties: {
        meta: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["meta", "tags"],
    },
    "(t :meta {:name #|string|#} :tags [#|string|#])",
  ),
  example(
    "a string const is escaped",
    "t",
    {
      type: "object",
      properties: { note: { type: "string", const: 'a "quoted" value\nwith a newline' } },
      required: ["note"],
    },
    String.raw`(t :note "a \"quoted\" value\nwith a newline")`,
  ),
  example(
    "a non-bare key inside a const object is quoted",
    "t",
    {
      type: "object",
      properties: { meta: { type: "object", const: { "weird key!": 1 } } },
      required: ["meta"],
    },
    '(t :meta {"weird key!" 1})',
  ),
  example(
    "a non-bare top-level key degrades to a bare call",
    "t",
    { type: "object", properties: { "weird key!": { type: "string" } }, required: ["weird key!"] },
    "(t)",
  ),
  example(
    "two non-bare top-level keys degrade to a bare call",
    "t",
    {
      type: "object",
      properties: { "a b": { type: "string" }, "c d": { type: "number" } },
      required: ["a b", "c d"],
    },
    "(t)",
  ),
  example(
    "a non-bare key nested in an object is quoted",
    "t",
    {
      type: "object",
      properties: {
        meta: { type: "object", properties: { "weird key!": { type: "string" } }, required: ["weird key!"] },
      },
      required: ["meta"],
    },
    '(t :meta {"weird key!" #|string|#})',
  ),
  example(
    "contradictory numeric bounds still render a number hole",
    "t",
    { type: "object", properties: { n: { type: "number", minimum: 10, maximum: 5 } }, required: ["n"] },
    "(t :n #|number|#)",
  ),
  example(
    "an empty enum falls through to the declared type",
    "t",
    { type: "object", properties: { u: { type: "string", enum: [] } }, required: ["u"] },
    "(t :u #|string|#)",
  ),
  example(
    "an enum of numbers wins over a string type",
    "weather_get",
    { type: "object", properties: { unit: { type: "string", enum: [1, 2, 3] } }, required: ["unit"] },
    "(weather_get :unit 1)",
  ),
  example(
    "a required name with no property is dropped",
    "t",
    { type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] },
    "(t :a #|string|#)",
  ),
  example(
    "string hole beside an enum member",
    "clinicaltrials/list_studies",
    {
      type: "object",
      properties: {
        term: { type: "string" },
        status: { type: "string", enum: ["RECRUITING", "COMPLETED"] },
      },
      required: ["term", "status"],
    },
    '(clinicaltrials/list_studies :term #|string|# :status "RECRUITING")',
  ),
];

describe("synthesizeExampleCall", () => {
  it.each(EXAMPLE_ROWS)("$name", ({ tool, schema, expr }) => {
    expect(synthesizeExampleCall(tool, schema)).toEqual(expr);
  });
});
