/**
 * Official-registry rows become one install string adopt can parse.
 * Remotes win over packages. Package commands pin the published version.
 */
import { expect, it } from "vitest";

import { parseMcpEndpoint } from "../adopt.js";
import { searchOfficialRegistry, serversFromRegistry, type RegistryFetch } from "../registry.js";

const REMOTE = {
  server: {
    name: "com.0xpi.sdsentry/sds-lookup",
    title: "SDSentry — SDS Lookup",
    description: "Free SDS lookup.",
    remotes: [
      { type: "sse", url: "https://sdsentry.0xpi.com/sse" },
      { type: "streamable-http", url: "https://sdsentry.0xpi.com/mcp-sds" },
    ],
    packages: [{ registryType: "npm", identifier: "unused", version: "1.0.0" }],
  },
};

const NPM = {
  server: {
    name: "com.pulsemcp/remote-filesystem",
    title: null,
    description: "Remote filesystem\n  operations.",
    packages: [
      {
        registryType: "npm",
        identifier: "remote-filesystem-mcp-server",
        version: "0.1.5",
        runtimeHint: "npx",
        runtimeArguments: [{ type: "positional", value: "-y" }],
        packageArguments: [{ type: "positional", value: "{workspace}" }],
        environmentVariables: [{ name: "GCS_BUCKET", isRequired: true }],
      },
    ],
  },
};

const PYPI = {
  server: {
    name: "com.mcparmory/sentry",
    description: "Track errors.",
    packages: [
      { registryType: "pypi", identifier: "mcparmory-sentry", version: "1.0.2", runtimeHint: "uvx" },
      { registryType: "oci", identifier: "ghcr.io/mcparmory/sentry:1.0.2", runtimeHint: "docker" },
    ],
  },
};

it("prefers a streamable remote over an earlier SSE URL and over packages", () => {
  const [hit] = serversFromRegistry({ servers: [REMOTE] });
  expect(hit).toMatchObject({
    name: "com.0xpi.sdsentry/sds-lookup",
    title: "SDSentry — SDS Lookup",
    description: "Free SDS lookup.",
    install: "https://sdsentry.0xpi.com/mcp-sds",
  });
  expect(parseMcpEndpoint(hit.install)).toEqual({
    driver: "mcp-http",
    settings: { url: "https://sdsentry.0xpi.com/mcp-sds" },
  });
});

it("builds an npx command from a package and keeps the published version", () => {
  const [hit] = serversFromRegistry({ servers: [NPM] });
  expect(hit).toMatchObject({
    title: "remote-filesystem",
    description: "Remote filesystem operations.",
    install: "npx -y remote-filesystem-mcp-server@0.1.5",
  });
  expect(parseMcpEndpoint(hit.install)).toEqual({
    driver: "mcp-stdio",
    settings: { command: "npx", args: ["-y", "remote-filesystem-mcp-server@0.1.5"] },
  });
});

it("uses the first installable package and leaves a tagged image alone", () => {
  const [pypi] = serversFromRegistry({ servers: [PYPI] });
  expect(pypi.install).toBe("uvx mcparmory-sentry@1.0.2");
  const [image] = serversFromRegistry({
    servers: [
      {
        server: {
          name: "com.example/box",
          packages: [{ registryType: "oci", identifier: "ghcr.io/example/box:1.2.3", version: "1.2.3" }],
        },
      },
    ],
  });
  expect(image.install).toBe("docker run -i --rm ghcr.io/example/box:1.2.3");
  expect(parseMcpEndpoint(image.install).settings).toEqual({
    command: "docker",
    args: ["run", "-i", "--rm", "ghcr.io/example/box:1.2.3"],
  });
});

it("keeps a server that published no install", () => {
  const [hit] = serversFromRegistry({
    servers: [{ server: { name: "com.example/bare", description: "No transport." } }],
  });
  expect(hit).toMatchObject({ title: "bare", install: "" });
});

it("asks the official registry for the latest name match", async () => {
  let seen = "";
  const fetchImpl: RegistryFetch = async (url) => {
    seen = url.toString();
    return Response.json({ servers: [NPM] });
  };
  const hits = await searchOfficialRegistry("  Filesystem ", { fetch: fetchImpl, limit: 50 });
  const query = seen.slice(seen.indexOf("?"));
  expect(seen.startsWith("https://registry.modelcontextprotocol.io/v0.1/servers?")).toBe(true);
  expect(queryParam(query, "search")).toBe("Filesystem");
  expect(queryParam(query, "version")).toBe("latest");
  expect(queryParam(query, "limit")).toBe("20");
  expect(hits[0]?.install).toBe("npx -y remote-filesystem-mcp-server@0.1.5");
});

it("does not call the registry for an empty query", async () => {
  let called = false;
  const fetchImpl: RegistryFetch = async () => {
    called = true;
    return Response.json({ servers: [] });
  };
  await expect(searchOfficialRegistry("   ", { fetch: fetchImpl })).resolves.toEqual([]);
  expect(called).toBe(false);
});

function queryParam(query: string, key: string): string {
  for (const part of query.slice(1).split("&")) {
    const eq = part.indexOf("=");
    if (decodeURIComponent(part.slice(0, eq)) === key) return decodeURIComponent(part.slice(eq + 1));
  }
  return "";
}

it("reports a registry that did not answer", async () => {
  const fetchImpl: RegistryFetch = async () => new Response("no", { status: 503 });
  await expect(searchOfficialRegistry("sentry", { fetch: fetchImpl })).rejects.toThrow(/didn’t answer \(503\)/);
});
