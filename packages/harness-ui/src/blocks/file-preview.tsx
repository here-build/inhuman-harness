import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { CodeBlock } from "./code-block.js";
import { langFromPath } from "./lang.js";
import { MarkdownBlock } from "./markdown-block.js";
import { fileFace, looksBinary, type FileFace } from "./read-line.js";
import { cn } from "../lib/cn.js";
import { Button } from "../primitives/button.js";
import { useVoice } from "../voice/index.js";

/** File descriptor opened in the workspace preview sidebar. */
export interface OpenFile {
  readonly path: string;
  readonly label: string;
  /** Preloaded UTF-8 text supplied when available without a separate fetch. */
  readonly text?: string;
}

/** Active file preview selection and resolver configuration. */
export interface FilePreviewContextValue {
  readonly file: OpenFile | null;
  readonly resolveFileUrl: (absolutePath: string) => string;
  open(file: OpenFile): void;
  close(): void;
}

const defaultResolveUrl = (absolutePath: string): string => absolutePath;

const FilePreviewContext = createContext<FilePreviewContextValue | null>(null);

export interface FilePreviewProviderProps {
  readonly children?: ReactNode;
  readonly resetKey: string | null;
  /** Maps an absolute workspace file path to an HTTP endpoint for fetching or media display. */
  readonly resolveFileUrl?: (absolutePath: string) => string;
}

/** Manages the open file preview drawer state across session/workspace switches. */
export function FilePreviewProvider({
  children,
  resetKey,
  resolveFileUrl = defaultResolveUrl,
}: FilePreviewProviderProps) {
  const [file, setFile] = useState<OpenFile | null>(null);
  useEffect(() => {
    setFile(null);
  }, [resetKey]);
  return (
    <FilePreviewContext.Provider
      value={{
        file,
        resolveFileUrl,
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

/** Reads the nearest {@link FilePreviewProvider} state. */
export function useFilePreview(): FilePreviewContextValue {
  const value = useContext(FilePreviewContext);
  if (value == null) throw new Error("FilePreviewProvider missing");
  return value;
}

export interface FilePreviewPaneProps {
  readonly projectPath: string;
  readonly resolveFileUrl?: (absolutePath: string) => string;
}

/** Renders the active file sidebar whenever a preview file is selected inside a workspace. */
export function FilePreviewPane({ projectPath, resolveFileUrl }: FilePreviewPaneProps) {
  const { file, close, resolveFileUrl: contextResolver } = useFilePreview();
  if (file == null || projectPath === "") return null;
  return (
    <FilePreviewPanel
      file={file}
      onClose={close}
      projectPath={projectPath}
      resolveFileUrl={resolveFileUrl ?? contextResolver}
    />
  );
}

type Load =
  | { readonly path: string; readonly kind: "pending" }
  | { readonly path: string; readonly kind: "error"; readonly message: string }
  | { readonly path: string; readonly kind: "binary" }
  | { readonly path: string; readonly kind: "text"; readonly text: string };

export interface FilePreviewPanelProps {
  readonly file: OpenFile;
  readonly projectPath: string;
  readonly resolveFileUrl?: (absolutePath: string) => string;
  readonly onClose: () => void;
  readonly className?: string;
}

/** Pure white-label file inspector sidebar for source code, Markdown, images, and PDFs. */
export function FilePreviewPanel({
  file,
  projectPath,
  resolveFileUrl = defaultResolveUrl,
  onClose,
  className,
}: FilePreviewPanelProps) {
  const voice = useVoice();
  const face = fileFace(file.path);
  const [retry, setRetry] = useState(0);
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
    void fetch(resolveFileUrl(absolute), { signal: controller.signal })
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
  }, [absolute, face, file.path, file.text, resolveFileUrl, retry]);

  const current = load.path === file.path ? load : { path: file.path, kind: "pending" as const };
  const src = resolveFileUrl(absolute);

  return (
    <aside className={cn("file-sidebar", className)} aria-label="File">
      <header className="file-sidebar-head">
        <h2 className="mono" title={file.path}>
          {file.label}
        </h2>
        <Button variant="ghost" aria-label="Close file" onClick={onClose}>
          {voice.common.close}
        </Button>
      </header>
      <div className="file-sidebar-body" aria-busy={face === "text" && current.kind === "pending"}>
        <FileBody
          face={face}
          src={src}
          load={current}
          path={file.path}
          loadingLabel={voice.transcript.openingLabel}
          retryLabel={voice.common.tryAgain}
          onRetry={() => setRetry((count) => count + 1)}
        />
      </div>
    </aside>
  );
}

/** Alias kept for reference shell compatibility. */
export const FileSidebar = FilePreviewPanel;

function FileBody({
  face,
  src,
  load,
  path,
  loadingLabel,
  retryLabel,
  onRetry,
}: {
  readonly face: FileFace;
  readonly src: string;
  readonly load: Load;
  readonly path: string;
  readonly loadingLabel: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}) {
  if (face === "image") return <img className="file-image" alt={path} src={src} />;
  if (face === "pdf") return <iframe className="file-pdf" title={path} src={src} />;
  if (face === "binary" || load.kind === "binary") return null;
  if (load.kind === "pending") {
    return (
      <p className="tool-empty" role="status">
        {loadingLabel}
      </p>
    );
  }
  if (load.kind === "error") {
    return (
      <div className="tool-empty flex flex-col items-start gap-2">
        <p role="alert">{load.message}</p>
        <Button variant="secondary" onClick={onRetry}>
          {retryLabel}
        </Button>
      </div>
    );
  }
  const lang = langFromPath(path);
  if (lang === "markdown") return <MarkdownBlock text={load.text} />;
  if (lang === undefined || lang === "text") {
    return (
      <pre className="tool-body">
        <code>{load.text}</code>
      </pre>
    );
  }
  return <CodeBlock lang={lang} text={load.text} />;
}
