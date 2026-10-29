import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../components/ui/button.js";

/** What to run. The daemon registers a project only when `harness` starts in its directory. */
export function harnessCommand(directory: string): string {
  const trimmed = directory.trim();
  if (trimmed === "") return "harness";
  return `cd ${quoteShell(trimmed)}\nharness`;
}

function quoteShell(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

export function AddProjectDialog({ onDismiss }: { readonly onDismiss: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [directory, setDirectory] = useState("");
  const [copied, setCopied] = useState(false);
  const command = harnessCommand(directory);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog == null || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);
  const copy = (): void => {
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
        return undefined;
      },
      () => {
        setCopied(false);
        return undefined;
      },
    );
  };
  return (
    <dialog ref={ref} className="add-project" aria-labelledby={titleId} onClose={onDismiss}>
      <h2 id={titleId} className="text-lg">
        Add a project
      </h2>
      <p className="mt-3 text-sm text-muted">
        A project shows up here after you run <code>harness</code> in its directory. This page can’t open one on its own
        yet.
      </p>
      <label className="mt-4 block text-sm" htmlFor="add-project-directory">
        Directory
        <input
          id="add-project-directory"
          className="mt-1 w-full rounded-sm border border-edge bg-field px-3 py-1"
          value={directory}
          placeholder="/path/to/the/project"
          spellCheck={false}
          onChange={(event) => setDirectory(event.target.value)}
        />
      </label>
      <pre className="mt-3 overflow-x-auto rounded-sm border border-line bg-wash px-3 py-2 text-sm">{command}</pre>
      <div className="mt-4 flex items-center justify-end gap-2">
        <p className="mr-auto text-sm text-subtle" role="status">
          {copied ? "Copied" : ""}
        </p>
        <Button variant="secondary" onClick={copy}>
          Copy command
        </Button>
        <form method="dialog">
          <Button variant="ghost" type="submit">
            Close
          </Button>
        </form>
      </div>
    </dialog>
  );
}
