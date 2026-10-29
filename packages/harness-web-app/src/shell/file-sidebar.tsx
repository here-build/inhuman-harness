import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { CodeView } from "./code-view.js";
import { langFromPath } from "./lang.js";
import { Markdown } from "./markdown.js";
import { fileFace, looksBinary, type FileFace } from "./read-line.js";
import { Button } from "../components/ui/button.js";

export type OpenFile = {
  readonly path: string;
  readonly label: string;
  /** Bytes the tool already read. Used when `/file` is the SPA shell. */
  readonly text?: string;
};

type FilePreview = {
  readonly file: OpenFile | null;
  open(file: OpenFile): void;
  close(): void;
};

const FilePreviewContext = createContext<FilePreview | null>(null);

export function FilePreviewProvider({
  children,
  resetKey,
}: {
  readonly children?: ReactNode;
  readonly resetKey: string | null;
}) {
  const [file, setFile] = useState<OpenFile | null>(null);
  useEffect(() => {
    setFile(null);
  }, [resetKey]);
  return (
    <FilePreviewContext.Provider
      value={{
        file,
        open: (next) => {
          if (fileFace(next.path) === "binary") return;
          setFile(next);
        },
        close: () => setFile(null),
      }}
    >
      {children}
    </FilePreviewContext.Provider>
  );
}

export function useFilePreview(): FilePreview {
  const value = useContext(FilePreviewContext);
  if (value == null) throw new Error("FilePreviewProvider missing");
  return value;
}

export function FilePreviewPane({ projectPath }: { readonly projectPath: string }) {
  const { file, close } = useFilePreview();
  if (file == null || projectPath === "") return null;
  return <FileSidebar file={file} onClose={close} projectPath={projectPath} />;
}

type Load =
  | { readonly path: string; readonly kind: "pending" }
  | { readonly path: string; readonly kind: "error"; readonly message: string }
  | { readonly path: string; readonly kind: "binary" }
  | { readonly path: string; readonly kind: "text"; readonly text: string };

export function FileSidebar({
  file,
  projectPath,
  onClose,
}: {
  readonly file: OpenFile;
  readonly projectPath: string;
  readonly onClose: () => void;
}) {
  const face = fileFace(file.path);
  const absolute = file.path.startsWith("/") ? file.path : `${projectPath.replace(/\/$/, "")}/${file.path}`;
  const [load, setLoad] = useState<Load>(
    file.text != null ? { path: file.path, kind: "text", text: file.text } : { path: file.path, kind: "pending" },
  );
  useEffect(() => {
    if (face !== "text") return;
    if (file.text != null) {
      setLoad({ path: file.path, kind: "text", text: file.text });
      return;
    }
    const controller = new AbortController();
    let live = true;
    setLoad({ path: file.path, kind: "pending" });
    void fetch(`/file?path=${encodeURIComponent(absolute)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "File not found." : "Could not open this file.");
        if (response.headers.get("x-harness-file") !== "1") {
          throw new Error("Could not open this file.");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (looksBinary(bytes)) return { path: file.path, kind: "binary" as const };
        return { path: file.path, kind: "text" as const, text: new TextDecoder().decode(bytes) };
      })
      .then((next) => {
        if (live) setLoad(next);
        return undefined;
      })
      .catch((error: unknown) => {
        if (!live || (error instanceof DOMException && error.name === "AbortError")) return;
        const message = error instanceof Error ? error.message : "Could not open this file.";
        setLoad({ path: file.path, kind: "error", message });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [absolute, face, file.path, file.text]);
  const current = load.path === file.path ? load : { path: file.path, kind: "pending" as const };
  const src = `/file?path=${encodeURIComponent(absolute)}`;
  return (
    <aside className="file-sidebar" aria-label="File">
      <header className="file-sidebar-head">
        <h2 className="mono" title={file.path}>
          {file.label}
        </h2>
        <Button variant="ghost" aria-label="Close file" onClick={onClose}>
          Close
        </Button>
      </header>
      <div className="file-sidebar-body">
        <FileBody face={face} src={src} load={current} path={file.path} />
      </div>
    </aside>
  );
}

function FileBody({
  face,
  src,
  load,
  path,
}: {
  readonly face: FileFace;
  readonly src: string;
  readonly load: Load;
  readonly path: string;
}) {
  if (face === "image") return <img className="file-image" alt={path} src={src} />;
  if (face === "pdf") return <iframe className="file-pdf" title={path} src={src} />;
  if (face === "binary" || load.kind === "binary") return null;
  if (load.kind === "pending") return <p className="tool-empty">Opening…</p>;
  if (load.kind === "error") return <p className="tool-empty">{load.message}</p>;
  const lang = langFromPath(path);
  if (lang === "markdown") return <Markdown text={load.text} />;
  if (lang === undefined || lang === "text") {
    return (
      <pre className="tool-body">
        <code>{load.text}</code>
      </pre>
    );
  }
  return <CodeView lang={lang} text={load.text} />;
}
