import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { sessionMintPermissionMode } from "@inhuman.tools/harness-model";
import { IconCornerDownLeft } from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import { observer } from "mobx-react-lite";
import { Button as MenuButton } from "react-aria-components";

import { connectPort } from "./connect-step.js";
import { cloneDraftPicture } from "./draft-slot.js";
import { LinkNotice } from "./link-notice.js";
import { completionWires, naturalName, type ModelChoice } from "./model-choice.js";
import { ModelPicker } from "./model-picker.js";
import {
  dropSession,
  mintedModel,
  queueSession,
  stageOf,
  stagedAgents,
  subscribeStageFocus,
  type StagedPermission,
} from "./new-session.js";
import { sessionHref } from "./path.js";
import { PermissionMode } from "./permission-mode.js";
import { PictureChips } from "./picture-chips.js";
import { adoptPictureFiles, clipboardImageFiles } from "./picture-draft.js";
import { PictureDrop } from "./picture-drop.js";
import { useProjectSkills } from "./project-skills.js";
import { providerRows } from "./provider-list.js";
import { SkillSlashMenu } from "./skill-slash-menu.js";
import { useSkillSlash } from "./use-skill-slash.js";
import { useDial } from "../client/context.js";
import { Menu, MenuItem, MenuTrigger, NativePopover } from "../components/ui/anchored.js";
import { Button } from "../components/ui/button.js";
import { fieldGlyph } from "../components/ui/glyph.js";
import { Textarea } from "../components/ui/input.js";

const fieldActionClass =
  "absolute right-2 bottom-2 inline-flex size-8 min-h-0 p-0 items-center justify-center rounded-sm text-ink hover:bg-hover disabled:opacity-40 pointer-coarse:right-1 pointer-coarse:bottom-1 pointer-coarse:size-12";

/**
 * The project page before a session exists. The field, model, agent, and
 * permission stay here. Send mints the session and carries them over.
 */
export const StageComposer = observer(function StageComposerView({ path }: { readonly path: string }) {
  const dial = useDial();
  const router = useRouter();
  const stage = stageOf(path);
  const [, repaint] = useState(0);
  const refresh = (): void => repaint((value) => value + 1);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const adoptDrop = useCallback(
    (files: readonly File[]) => {
      void adoptPictureFiles(stage, files, true, () => refreshRef.current());
    },
    [stage],
  );
  const [focusTick, setFocusTick] = useState(0);
  const draftId = useId();
  const statusId = useId();
  const held = dial.project?.root.path === path ? dial.project.root : dial.projects.get(path)?.root;
  const seeded = mintedModel(dial.kernel?.root.kvs, held?.kvs);
  const shown = stage.model ?? seeded;
  const wires = completionWires(dial.kernel?.root.connections);
  const providers = providerRows(dial.kernel?.root.drivers, dial.kernel?.root.connections);
  const agents = stagedAgents(dial.kernel?.root.bots, held?.bots);
  const agentOptions =
    stage.agent !== "" && !agents.some((row) => row.name === stage.agent) ? [{ name: stage.agent }, ...agents] : agents;
  const agentLabel = stage.agent === "" ? "Default" : stage.agent;
  const seedPermission = sessionMintPermissionMode(
    dial.kernel?.root.defaultPermissionMode ?? "",
    held?.defaultPermissionMode ?? "",
  );
  const blocked = dial.link != null;
  const hasBody = stage.draft.trim() !== "" || stage.pictures.length > 0;
  const canSend = !blocked && !stage.sending && hasBody;
  const skills = useProjectSkills(path, stage.draft.startsWith("/"));
  const slash = useSkillSlash({
    scope: path,
    rows: skills,
    value: stage.draft,
    disabled: blocked || stage.sending,
    fieldRef,
    onChange: (value) => {
      stage.draft = value;
      stage.revision += 1;
      refresh();
    },
  });

  useEffect(() => subscribeStageFocus(() => setFocusTick((value) => value + 1)), []);
  // After the model menu's own focus effect, so the draft keeps the caret.
  useEffect(() => {
    fieldRef.current?.focus();
  }, [focusTick]);

  const choose = (next: ModelChoice): void => {
    stage.model = next;
    stage.revision += 1;
    stage.status = "";
    refresh();
  };
  const chooseAgent = (name: string): void => {
    stage.agent = name;
    stage.revision += 1;
    stage.status = "";
    refresh();
  };
  const choosePermission = (mode: StagedPermission): void => {
    stage.permission = mode;
    stage.revision += 1;
    stage.status = "";
    refresh();
  };

  async function send(): Promise<void> {
    if (!canSend) return;
    const prompt = stage.draft;
    const pictures = stage.pictures.map(cloneDraftPicture);
    const revision = stage.revision;
    const id = crypto.randomUUID();
    queueSession(id, { prompt, pictures, model: stage.model, agent: stage.agent, permission: stage.permission });
    stage.sending = true;
    stage.status = "";
    refresh();
    dial.prepareMint(id);
    try {
      await router.navigate({ href: sessionHref(path, id) });
      if (stage.revision === revision) {
        stage.draft = "";
        stage.pictures = [];
        stage.model = null;
        stage.agent = "";
        stage.permission = null;
      }
    } catch (error) {
      dropSession(id);
      stage.status = error instanceof Error ? error.message : "Could not start the session. Your draft is saved.";
    } finally {
      stage.sending = false;
      refresh();
    }
  }

  function onDraftKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (slash.onKeyDown(event)) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) void send();
    }
  }

  return (
    <form
      className="composer sticky bottom-0 z-10"
      hidden={dial.kernel == null}
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="composer-column">
        {dial.kernel == null ? null : <LinkNotice />}
        <output
          id={statusId}
          className={stage.status === "" ? "block text-sm text-muted" : "mb-2 block text-sm text-muted"}
          role="status"
        >
          {stage.status}
        </output>
        <PictureDrop fieldRef={pillRef} enabled={!blocked && !stage.sending} onDrop={adoptDrop}>
          <PictureChips
            disabled={blocked || stage.sending}
            pictures={stage.pictures}
            onRemove={(key) => {
              stage.pictures = stage.pictures.filter((picture) => picture.key !== key);
              stage.revision += 1;
              refresh();
            }}
            onPick={(files) => {
              void adoptPictureFiles(stage, files, true, refresh);
            }}
          />
          <SkillSlashMenu menu={slash.menu} />
          <Textarea
            {...slash.fieldProps}
            ref={fieldRef}
            id={draftId}
            aria-label="Message draft"
            aria-describedby={statusId}
            className="composer-draft rounded-none border-0 bg-transparent px-4 py-3 pr-12 text-base pointer-coarse:py-4 pointer-coarse:pr-14"
            placeholder="Ask or describe a change. / for skills"
            rows={1}
            value={stage.draft}
            onChange={(event) => {
              stage.draft = event.target.value;
              stage.revision += 1;
              slash.track(event.currentTarget);
              refresh();
            }}
            onKeyDown={onDraftKey}
            onPaste={(event) => {
              const files = clipboardImageFiles(event.clipboardData);
              if (files.length === 0) return;
              if (event.clipboardData.getData("text/plain") === "") event.preventDefault();
              void adoptPictureFiles(stage, files, false, refresh);
            }}
          />
          {!hasBody ? null : (
            <Button
              variant="ghost"
              type="button"
              aria-label="Send"
              className={fieldActionClass}
              disabled={!canSend}
              onClick={() => {
                void send();
              }}
            >
              <IconCornerDownLeft {...fieldGlyph} aria-hidden />
            </Button>
          )}
        </PictureDrop>
      </div>
      <div className="composer-lane">
        <div className="composer-picks">
          {wires.length === 0 ? (
            <span className="truncate text-sm font-strong text-ink">
              {shown.model.trim() === "" ? "None" : naturalName(shown.model)}
            </span>
          ) : (
            <ModelPicker
              wires={wires}
              providers={providers}
              current={shown}
              request={connectPort(dial)}
              disabled={blocked}
              onChoose={choose}
              onLook={(connectionIds, driverNames) => dial.look(connectionIds, driverNames)}
            />
          )}
          <MenuTrigger>
            <MenuButton className="agent-trigger touch-target" aria-label={`Agent: ${agentLabel}`}>
              <span className={stage.agent === "" ? "label" : "tracking-normal [font-variant-caps:normal]"}>
                {agentLabel}
              </span>
            </MenuButton>
            <NativePopover style={{ positionArea: "top span-left" }}>
              <Menu
                aria-label="Agent"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={new Set([stage.agent])}
                onAction={(key) => {
                  if (key === "" || agentOptions.some((row) => row.name === key)) chooseAgent(String(key));
                }}
              >
                <MenuItem id="" shouldCloseOnSelect>
                  Default
                </MenuItem>
                {agentOptions.map((row) => (
                  <MenuItem key={row.name} id={row.name} textValue={row.name} shouldCloseOnSelect>
                    <span className="tracking-normal [font-variant-caps:normal]">{row.name}</span>
                  </MenuItem>
                ))}
              </Menu>
            </NativePopover>
          </MenuTrigger>
          <PermissionMode staged={stage.permission} seed={seedPermission} onStage={choosePermission} />
        </div>
      </div>
    </form>
  );
});
