import {
  FilePreviewPane as BaseFilePreviewPane,
  FilePreviewPanel,
  FilePreviewProvider as BaseFilePreviewProvider,
  type FilePreviewPaneProps,
  type FilePreviewPanelProps,
  type FilePreviewProviderProps,
} from "@inhuman.tools/harness-ui/blocks/file-preview";

import { appLocation } from "../client/location.js";

export {
  type FilePreviewContextValue,
  type FilePreviewPaneProps,
  FilePreviewPanel,
  type FilePreviewPanelProps,
  type FilePreviewProviderProps,
  type OpenFile,
  useFilePreview,
} from "@inhuman.tools/harness-ui/blocks/file-preview";

const resolveWebFileUrl = (path: string): string => appLocation(globalThis.location).fileUrl(path);

/** Reference web provider seeding `/file` HTTP URL resolution from {@link appLocation}. */
export function FilePreviewProvider({ resolveFileUrl = resolveWebFileUrl, ...props }: FilePreviewProviderProps) {
  return <BaseFilePreviewProvider resolveFileUrl={resolveFileUrl} {...props} />;
}

/** Reference web file sidebar container preserving `/file` URL resolution when mounted standalone. */
export function FilePreviewPane({ resolveFileUrl = resolveWebFileUrl, ...props }: FilePreviewPaneProps) {
  return <BaseFilePreviewPane resolveFileUrl={resolveFileUrl} {...props} />;
}

/** Standalone file inspector panel defaulting to {@link appLocation} URL resolution. */
export function FileSidebar({ resolveFileUrl = resolveWebFileUrl, ...props }: FilePreviewPanelProps) {
  return <FilePreviewPanel resolveFileUrl={resolveFileUrl} {...props} />;
}
