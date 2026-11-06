// @vitest-environment happy-dom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileSidebar } from "../file-sidebar.js";

function encode(text: string): ArrayBuffer {
  const view = new TextEncoder().encode(text);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

describe("file sidebar", () => {
  let container: HTMLDivElement;
  let view: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    view = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      view.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("highlights code, paints markdown, embeds image and pdf, and leaves binary empty", async () => {
    const files = new Map<string, ArrayBuffer>([
      ["/work/src/a.ts", encode("export const ready = true;\n")],
      ["/work/README.md", encode("# Title\n\nA paragraph.\n")],
      ["/work/notes.txt", encode("plain notes\n")],
      ["/work/payload.foo", Uint8Array.from([0x00, 0x01, 0x02, 0x00]).buffer],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const asked = new URL(input, "http://127.0.0.1").searchParams.get("path") ?? "";
        const body = files.get(asked);
        if (body === undefined) return new Response("not found", { status: 404 });
        return new Response(body, { headers: { "x-harness-file": "1" } });
      }),
    );

    const show = async (path: string, label = path) => {
      await act(async () => {
        view.render(
          createElement(
            StrictMode,
            null,
            createElement(FileSidebar, {
              file: { path, label },
              projectPath: "/work",
              onClose: () => undefined,
            }),
          ),
        );
      });
    };

    await show("src/a.ts");
    await vi.waitFor(() => {
      expect(container.querySelector("pre.mono")?.textContent).toContain("export const ready");
    });

    await show("README.md");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Title");
      expect(container.querySelector(".prose")).not.toBeNull();
    });

    await show("notes.txt");
    await vi.waitFor(() => {
      expect(container.querySelector("pre.tool-body")?.textContent).toBe("plain notes\n");
    });

    await show("shot.png");
    expect(container.querySelector("img.file-image")?.getAttribute("src")).toContain("shot.png");

    await show("notes.pdf");
    expect(container.querySelector("iframe.file-pdf")?.getAttribute("src")).toContain("notes.pdf");

    await show("pack.wasm");
    expect(container.querySelector(".file-sidebar-body")?.textContent).toBe("");

    await show("payload.foo");
    await vi.waitFor(() => {
      expect(container.querySelector(".file-sidebar-body")?.textContent).toBe("");
    });
  });

  it("paints the read snapshot and refuses a vite html shell", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('<!doctype html><html lang="en"><title>inhuman</title></html>', {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    await act(async () => {
      view.render(
        createElement(FileSidebar, {
          file: { path: "src/tui/omnibox-seat.ts", label: "src/tui/omnibox-seat.ts", text: "export const seat = 1;\n" },
          projectPath: "/work",
          onClose: () => undefined,
        }),
      );
    });
    expect(container.textContent).toContain("export const seat = 1;");
    expect(container.textContent).not.toContain("doctype");
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await act(async () => {
      view.render(
        createElement(FileSidebar, {
          file: { path: "src/tui/omnibox-seat.ts", label: "src/tui/omnibox-seat.ts" },
          projectPath: "/work",
          onClose: () => undefined,
        }),
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Could not open this file.");
    });
    expect(container.textContent).not.toContain("doctype");
  });
});
