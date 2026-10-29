/** Display title. Never the session id. A session with no title and no prompt is a new conversation. */
export function rowTitle(input: {
  readonly live: string;
  readonly title: string;
  readonly lastPrompt: string;
}): string {
  const live = input.live.trim();
  if (live !== "") return live;
  const title = input.title.trim();
  if (title !== "") return title;
  const prompt = input.lastPrompt
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim() !== "");
  if (prompt !== undefined && prompt.trim() !== "") return prompt.trim();
  return NEW_CONVERSATION;
}

export const NEW_CONVERSATION = "New conversation";
