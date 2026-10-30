import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { isAllowedEmail } from "../allowlist.js";
import { buildDevCredential, parseDevCredential } from "../auth/dev.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { seal, unseal } from "../auth/seal.js";
import { isMachineId } from "../machine-id.js";
import { CLIENT_ID, makeIssuer } from "./helpers.js";

describe("allowlist", () => {
  it("matches case-insensitively and trims", () => {
    expect(isAllowedEmail("A@x.com", " a@x.com , b@x.com")).toBe(true);
    expect(isAllowedEmail("c@x.com", "a@x.com,b@x.com")).toBe(false);
  });
  it("empty list or missing email admits nobody", () => {
    expect(isAllowedEmail("a@x.com", "")).toBe(false);
    expect(isAllowedEmail("a@x.com", " , ")).toBe(false);
    expect(isAllowedEmail(undefined, "a@x.com")).toBe(false);
  });
});

describe("machine id", () => {
  it("accepts url-safe bounded ids", () => {
    expect(isMachineId("m-1_A")).toBe(true);
    expect(isMachineId("a".repeat(64))).toBe(true);
  });
  it("rejects empty, long and unsafe ids", () => {
    for (const bad of ["", "a".repeat(65), "a/b", "a b", "a.b", "..", "a%2Fb"]) expect(isMachineId(bad)).toBe(false);
  });
});

describe("seal", () => {
  const pw = "0123456789abcdef0123456789abcdef";
  it("round-trips", async () => {
    const sealed = await seal({ a: 1 }, pw);
    expect(await unseal(sealed, pw)).toEqual({ a: 1 });
  });
  it("rejects a wrong password, tampering and junk", async () => {
    const sealed = await seal({ a: 1 }, pw);
    expect(await unseal(sealed, "x".repeat(32))).toBeUndefined();
    expect(await unseal(`${sealed.slice(0, -2)}AA`, pw)).toBeUndefined();
    expect(await unseal("junk", pw)).toBeUndefined();
  });
  it("refuses short passwords", async () => {
    await expect(seal({}, "short")).rejects.toThrow(/32/);
  });
});

describe("dev credential", () => {
  it("parses sub and a dotted email", () => {
    const c = buildDevCredential("s3", "u1", "a.b@x.com");
    expect(parseDevCredential(c, "s3")).toEqual({ sub: "u1", email: "a.b@x.com" });
  });
  it("is unreachable without the secret or with a wrong one", () => {
    const c = buildDevCredential("s3", "u1", "a@x.com");
    expect(parseDevCredential(c, undefined)).toBeUndefined();
    expect(parseDevCredential(c, "")).toBeUndefined();
    expect(parseDevCredential(c, "other")).toBeUndefined();
    expect(parseDevCredential("dev.s3.u1", "s3")).toBeUndefined();
  });
});

describe("verifyAccessToken", () => {
  it("accepts a valid token and returns sub", async () => {
    const { jwks, sign } = await makeIssuer();
    expect(await verifyAccessToken(await sign("u1"), CLIENT_ID, jwks)).toEqual({ ok: true, sub: "u1" });
  });
  it("flags expiry", async () => {
    const { jwks, sign } = await makeIssuer();
    const t = await sign("u1", { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    expect(await verifyAccessToken(t, CLIENT_ID, jwks)).toEqual({ ok: false, expired: true });
  });
  it("rejects wrong issuer, foreign key and junk", async () => {
    const a = await makeIssuer();
    const b = await makeIssuer();
    expect(await verifyAccessToken(await a.sign("u1", { issuer: "https://evil" }), CLIENT_ID, a.jwks)).toEqual({
      ok: false,
      expired: false,
    });
    expect(await verifyAccessToken(await b.sign("u1"), CLIENT_ID, a.jwks)).toEqual({ ok: false, expired: false });
    expect(await verifyAccessToken("junk", CLIENT_ID, a.jwks)).toEqual({ ok: false, expired: false });
  });
  it("rejects alg none", async () => {
    const { jwks } = await makeIssuer();
    const t = new SignJWT({}).setProtectedHeader({ alg: "none" }).setSubject("u1").toString();
    expect((await verifyAccessToken(String(t), CLIENT_ID, jwks)).ok).toBe(false);
  });
});
