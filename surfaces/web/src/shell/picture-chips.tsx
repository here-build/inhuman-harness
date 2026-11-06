import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";

import type { DraftPicture } from "./draft-slot.js";
import { chipLabel, picturePreviewUrl } from "./picture-draft.js";
import { Button } from "../components/ui/button.js";
import { glyph } from "../components/ui/glyph.js";
import { NativeDialog } from "../components/ui/native-dialog.js";

/** The file input and the chips that sit with the field. */
export function PictureChips({
  pictures,
  onRemove,
  onPick,
  disabled = false,
}: {
  readonly pictures: readonly DraftPicture[];
  readonly onRemove: (key: string) => void;
  readonly onPick: (files: readonly File[]) => void;
  readonly disabled?: boolean;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = pictures.find((picture) => picture.key === openKey) ?? null;
  const openPreview = open == null ? null : picturePreviewUrl(open);

  return (
    <>
      <input
        className="composer-file sr-only"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label="Add image"
        tabIndex={-1}
        multiple
        disabled={disabled}
        onChange={(event) => {
          const chosen = event.currentTarget.files;
          const files = chosen == null ? [] : [...chosen];
          event.currentTarget.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
      {pictures.length === 0 ? null : (
        <ul className="composer-chips" aria-label="Pictures">
          {pictures.map((picture) => {
            const preview = picturePreviewUrl(picture);
            const label = chipLabel(picture);
            return (
              <li key={picture.key} className="composer-chip" title={label}>
                <Button
                  variant="ghost"
                  className="composer-chip-open focus-visible:-outline-offset-2 data-[focus-visible]:-outline-offset-2"
                  aria-label={label}
                  disabled={disabled || preview == null}
                  onClick={() => setOpenKey(picture.key)}
                >
                  {preview == null ? null : <img className="composer-chip-preview" src={preview} alt="" />}
                </Button>
                <Button
                  variant="ghost"
                  className="composer-chip-remove p-0 focus-visible:-outline-offset-2 data-[focus-visible]:-outline-offset-2"
                  aria-label={`Remove ${label}`}
                  disabled={disabled}
                  onClick={() => onRemove(picture.key)}
                >
                  <IconX {...glyph} aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {open == null || openPreview == null ? null : (
        <PicturePreview url={openPreview} label={chipLabel(open)} onClose={() => setOpenKey(null)} />
      )}
    </>
  );
}

function PicturePreview({
  url,
  label,
  onClose,
}: {
  readonly url: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const [node, setNode] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (node == null || node.open) return;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
  }, [node]);
  return (
    <NativeDialog
      ref={setNode}
      className="picture-preview"
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <img src={url} alt={label} />
    </NativeDialog>
  );
}
