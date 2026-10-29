import { expect, expectTypeOf, test } from "vitest";

import {
  asPrompt,
  asSystemPrompt,
  asUserPrompt,
  prompt,
  type Prompt,
  type SystemPrompt,
  type UserPrompt,
} from "../prompt.js";

test("prompt interpolates like a template string", () => {
  const who = "harness";
  expect(prompt`hello ${who}`).toBe("hello harness");
  expect(prompt.system`sys ${1}`).toBe("sys 1");
  expect(prompt.user`user ${who}`).toBe("user harness");
});

test("asPrompt doors wrap a raw string", () => {
  expect(asPrompt("wide")).toBe("wide");
  expect(asSystemPrompt("sys")).toBe("sys");
  expect(asUserPrompt("usr")).toBe("usr");
  expect(asSystemPrompt("  keep indent")).toBe("  keep indent");
});

test("prompt tags drop source indent", () => {
  const body = prompt.system`
    line one
    line two ${"x"}
  `;
  expect(body).toBe("line one\nline two x");
  expect(prompt.user`
    hello
  `).toBe("hello");
  expect(prompt.user`${"  "}`).toBe("  ");
});

test("kinds assign to Prompt and not to each other", () => {
  const wide = prompt`wide`;
  const system = prompt.system`sys`;
  const user = prompt.user`usr`;

  expectTypeOf(wide).toEqualTypeOf<Prompt>();
  expectTypeOf(system).toEqualTypeOf<SystemPrompt>();
  expectTypeOf(user).toEqualTypeOf<UserPrompt>();
  expectTypeOf(system).toMatchTypeOf<Prompt>();
  expectTypeOf(user).toMatchTypeOf<Prompt>();
  expectTypeOf(system).not.toMatchTypeOf<UserPrompt>();
  expectTypeOf(user).not.toMatchTypeOf<SystemPrompt>();
  expectTypeOf(wide).not.toMatchTypeOf<SystemPrompt>();
  expectTypeOf("bare").not.toMatchTypeOf<Prompt>();
});
