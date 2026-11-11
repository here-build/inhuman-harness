import { ExamProgramError } from "@/extensions/surface-error";

export function taskExamDoor(error: ExamProgramError, name: string, raw: unknown, verbose = true): string | null {
  if (name !== "task__create" && name !== "task__validate") return null;
  const taskId =
    raw !== null && typeof raw === "object" && "taskId" in raw && typeof raw.taskId === "string"
      ? JSON.stringify(raw.taskId)
      : "the taskId";
  const recovery =
    error.phase === "capture"
      ? `No task was created. Retry task__create with taskId ${taskId} and a corrected validationProgram.`
      : `The saved validationProgram cannot be replaced. Call task__drop for ${taskId} with a reason, then task__create with a new taskId and a corrected validationProgram; call task__start and task__validate on that new ID.`;
  const fact = `validationProgram is Scheme source evaluated by the task examiner. ${error.message}`;
  if (!verbose) return `${fact}\n${recovery}`;
  return [
    fact,
    `1. ${recovery}`,
    '2. Write checks as Scheme calls: (read_file "path") returns file text; (equal? actual expected) compares values. Finish with (tasks/write-completion-verdict ok "evidence").',
    '3. Adapt this working shape to the task requirements: (tasks/write-completion-verdict (equal? (read_file "status.txt") "ready") "status.txt must contain exactly ready")',
    "The program is JSON string data at the tool boundary; its contents use Scheme syntax. It runs later during task__validate, after task__start.",
  ].join("\n");
}
