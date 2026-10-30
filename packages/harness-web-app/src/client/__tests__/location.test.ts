import { describe, expect, it } from "vitest";

import { appLocation } from "../location.js";

const at = (pathname: string, protocol = "https:", host = "harness.inhuman.tools", search = "") => ({
  pathname,
  protocol,
  host,
  search,
});

describe("appLocation", () => {
  it("is remote under /m/<id>/app/", () => {
    const where = appLocation(at("/m/laptop-1/app/p/%2Fwork/s/x"));
    expect(where).toMatchObject({
      remote: true,
      roomOrigin: "wss://harness.inhuman.tools/m/laptop-1/room",
      httpBase: "https://harness.inhuman.tools/m/laptop-1",
      basepath: "/m/laptop-1/app",
    });
    expect(where.fileUrl("/a b/c.ts")).toBe("/m/laptop-1/file?path=%2Fa%20b%2Fc.ts");
  });

  it("uses ws on plain http", () => {
    expect(appLocation(at("/m/x/app/", "http:", "localhost:8787")).roomOrigin).toBe("ws://localhost:8787/m/x/room");
  });

  it("ignores ?dial= when remote", () => {
    expect(appLocation(at("/m/x/app/", "https:", "h", "?dial=ws://evil")).roomOrigin).toBe("wss://h/m/x/room");
  });

  it("is local for anything else, including a bad machine id", () => {
    for (const pathname of ["/", "/p/a", "/m/x/other", "/m/bad.id/app/", `/m/${"a".repeat(65)}/app/`, "/x/m/y/app/"]) {
      const where = appLocation(at(pathname, "http:", "127.0.0.1:7777"));
      expect(where).toMatchObject({ remote: false, roomOrigin: "ws://127.0.0.1:7777", basepath: undefined });
      expect(where.fileUrl("/a")).toBe("/file?path=%2Fa");
    }
  });

  it("keeps ?dial= in local mode", () => {
    const where = appLocation(at("/", "http:", "127.0.0.1:5173", "?dial=ws://127.0.0.1:7777"));
    expect(where.roomOrigin).toBe("ws://127.0.0.1:7777");
    expect(where.httpBase).toBe("http://127.0.0.1:7777");
  });
});
