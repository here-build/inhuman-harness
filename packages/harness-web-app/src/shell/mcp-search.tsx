import { useEffect, useRef, useState } from "react";

import type { Request } from "./connect-step.js";
import {
  mcpCopies,
  registryAddLabel,
  registryAddWord,
  registryHits,
  registryStatus,
  type McpFace,
  type RegistryHit,
} from "./mcp-registry.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

const SEARCH_WAIT_MS = 300;

/**
 * Official-registry search. Add adopts the install string again, so a server
 * that is already connected can be added as another copy with its own login.
 */
export function RegistrySearch({
  request,
  rows,
  disabled,
  onNotice,
  onAdopt,
}: {
  readonly request: Request | null;
  readonly rows: readonly (readonly [string, McpFace])[];
  readonly disabled: boolean;
  readonly onNotice: (message: string) => void;
  readonly onAdopt: (hit: RegistryHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RegistryHit[]>([]);
  const [pending, setPending] = useState(false);
  const requestRef = useRef(request);
  const noticeRef = useRef(onNotice);
  requestRef.current = request;
  noticeRef.current = onNotice;
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setHits([]);
      setPending(false);
      return;
    }
    let live = true;
    setHits([]);
    setPending(true);
    const timer = setTimeout(() => {
      const current = requestRef.current;
      if (!live) return;
      if (current == null) {
        setPending(false);
        noticeRef.current("The daemon is not connected.");
        return;
      }
      void current("mcp-server/search", { query: q }).then(
        (result) => {
          if (!live) return undefined;
          setPending(false);
          setHits(registryHits(result));
          noticeRef.current("");
          return undefined;
        },
        (error: unknown) => {
          if (!live) return undefined;
          setPending(false);
          setHits([]);
          noticeRef.current(error instanceof Error ? error.message : "The registry didn’t answer.");
          return undefined;
        },
      );
    }, SEARCH_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const status = registryStatus(query, pending, hits.length);
  return (
    <div className="text-sm">
      <label className="block">
        Search servers
        <Input
          className="mt-1"
          value={query}
          placeholder="Name"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p className="mt-1 text-sm text-muted">
        Searches server names in the official registry. Each server you add signs in on its own.
      </p>
      {status === "" ? null : <p className="mt-2 text-sm text-muted">{status}</p>}
      {hits.length === 0 ? null : (
        <div className="settings-list mt-2">
          {hits.map((hit) => {
            const copies = mcpCopies(rows, hit.install);
            return (
              <div key={hit.name} className="settings-row">
                <p className="text-sm font-strong">{hit.title}</p>
                {hit.description === "" ? null : <p className="settings-clamp text-sm text-muted">{hit.description}</p>}
                {copies.length === 0 ? (
                  <p className="text-sm text-muted">Not connected</p>
                ) : (
                  copies.map((copy) => (
                    <p key={copy.id} className="text-sm text-muted">
                      {copy.name} · {copy.login}
                    </p>
                  ))
                )}
                <Button
                  className="self-start"
                  variant="secondary"
                  aria-label={registryAddLabel(hit.title, hit.install, copies.length)}
                  disabled={disabled || hit.install.trim() === ""}
                  onClick={() => onAdopt(hit)}
                >
                  {registryAddWord(hit.install, copies.length)}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
