import { describe, expect, it } from "vitest";

import { DoorSession, isUnterminatedDictLiteral, unterminatedDictDoor, UNTERMINATED_DICT_LITERAL } from "../doors.js";

describe("unterminatedDictDoor", () => {
  const door = unterminatedDictDoor();

  it("matches Arrival's frozen reader line and no other parse errors", () => {
    expect(isUnterminatedDictLiteral(UNTERMINATED_DICT_LITERAL)).toBe(true);
    expect(isUnterminatedDictLiteral(`Error: ${UNTERMINATED_DICT_LITERAL}`)).toBe(true);
    expect(isUnterminatedDictLiteral("Parser: expected parenthesis but eof found")).toBe(false);
    expect(isUnterminatedDictLiteral("unterminated string")).toBe(false);
  });

  it("keeps Arrival's diagnosis, names the sampler, and asks for a retry without commas", () => {
    expect(door.code).toBe("envelope/unterminated-dict");
    expect(door.fact).toContain(UNTERMINATED_DICT_LITERAL);
    expect(door.fact).toMatch(/cannot reconstruct/i);
    expect(door.reason).toMatch(/sampler/i);
    expect(door.reason).toMatch(/likely complete/i);
    expect(door.reason).toMatch(/optional/i);
    expect(door.script).toContain("{offset: 90 limit: 40}");
    expect(door.script).toContain("{offset: 90, limit: 40}");
    expect(door.script.toLowerCase()).toContain("spaces instead of commas");
  });

  it("verbose render keeps Error: and teaches Why + retry; repeat collapses to terse", () => {
    const session = new DoorSession(() => {});
    const first = session.render(door, "scheme_repl");
    expect(first).toContain(`Error: ${UNTERMINATED_DICT_LITERAL}`);
    expect(first).toContain("Why:");
    expect(first).toContain("{offset: 90 limit: 40}");
    expect(session.render(door, "scheme_repl")).toBe(`Error: ${door.terse}`);
  });
});
