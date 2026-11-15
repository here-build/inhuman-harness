import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { sessionMintPermissionMode, type ReasoningEffort } from "@inhuman.tools/harness-model";
import { StageComposerBlock, adoptPictureFiles, clipboardImageFiles, useSkillSlash } from "@inhuman.tools/harness-ui";
import { useRouter } from "@tanstack/react-router";
import { observer } from "mobx-react-lite";

import { connectPort } from "./connect-step.js";
import { cloneDraftPicture } from "./draft-slot.js";
import { LinkNotice } from "./link-notice.js";
import { completionWires, naturalName, type ModelChoice } from "./model-choice.js";
import { ModelPicker } from "./model-picker.js";
import {
  dropSession,
  mintedModel,
  mintedReasoningEffort,
  queueSession,
  stageOf,
  subscribeStageFocus,
  type StagedPermission,
} from "./new-session.js";
import { sessionHref } from "./path.js";
import { PermissionMode } from "./permission-mode.js";
import { useProjectSkills } from "./project-skills.js";
import { ReasoningEffortPicker } from "./reasoning-effort.js";
import { useDial } from "../client/context.js";

/**
 * The project page before a session exists. The field, model, and permission
 * stay here. Send mints the session on the default face and carries them over.
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
  const held = dial.project?.root.path === path ? dial.project.root : dial.projects.get(path)?.root;
  const seeded = mintedModel(dial.kernel?.root.kvs, held?.kvs);
  const shown = stage.model ?? seeded;
  const wires = completionWires(dial.kernel?.root.connections);
  const seedEffort = mintedReasoningEffort(dial.kernel?.root.kvs, held?.kvs);
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
  const choosePermission = (mode: StagedPermission): void => {
    stage.permission = mode;
    stage.revision += 1;
    stage.status = "";
    refresh();
  };
  const chooseEffort = (effort: ReasoningEffort | ""): void => {
    stage.reasoningEffort = effort;
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
    queueSession(id, {
      prompt,
      pictures,
      model: stage.model,
      agent: "",
      permission: stage.permission,
      reasoningEffort: stage.reasoningEffort,
    });
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
        stage.reasoningEffort = null;
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
    <StageComposerBlock
      hidden={dial.kernel == null}
      topNotices={dial.kernel == null ? null : <LinkNotice />}
      notice={stage.status}
      fieldRef={fieldRef}
      pillRef={pillRef}
      dropEnabled={!blocked && !stage.sending}
      onDropFiles={adoptDrop}
      pictures={stage.pictures}
      picturesDisabled={blocked || stage.sending}
      onRemovePicture={(key) => {
        stage.pictures = stage.pictures.filter((picture) => picture.key !== key);
        stage.revision += 1;
        refresh();
      }}
      onPickPictures={(files) => {
        void adoptPictureFiles(stage, files, true, refresh);
      }}
      slashMenu={slash.menu}
      slashFieldProps={slash.fieldProps}
      draftLabel="Message draft"
      draftPlaceholder="Ask or describe a change. / for skills"
      draft={stage.draft}
      onDraftChange={(value, element) => {
        stage.draft = value;
        stage.revision += 1;
        slash.track(element);
        refresh();
      }}
      onDraftKeyDown={onDraftKey}
      onDraftPaste={(event) => {
        const files = clipboardImageFiles(event.clipboardData);
        if (files.length === 0) return;
        if (event.clipboardData.getData("text/plain") === "") event.preventDefault();
        void adoptPictureFiles(stage, files, false, refresh);
      }}
      showSend={hasBody}
      canSend={canSend}
      onSend={() => {
        void send();
      }}
      lane={
        <>
          {wires.length === 0 ? (
            <span className="truncate text-sm font-strong text-ink">
              {shown.model.trim() === "" ? "None" : naturalName(shown.model)}
            </span>
          ) : (
            <ModelPicker
              wires={wires}
              current={shown}
              request={connectPort(dial)}
              disabled={blocked}
              onChoose={choose}
              onLook={(connectionIds, driverNames) => dial.look(connectionIds, driverNames)}
            />
          )}
          <ReasoningEffortPicker
            model={shown}
            wires={wires}
            staged={stage.reasoningEffort}
            seed={seedEffort}
            agentEffort={null}
            disabled={blocked}
            onStage={chooseEffort}
          />
        </>
      }
      footer={<PermissionMode staged={stage.permission} seed={seedPermission} onStage={choosePermission} />}
    />
  );
});
