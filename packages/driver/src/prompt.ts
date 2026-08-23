import type { MessagePart, ModelMessage } from "@daydream-code/shared";

function renderPart(part: MessagePart): string {
  switch (part.type) {
    case "text":
    case "marker":
      return part.text;
    case "tool_call":
      return `[tool_call ${part.toolName} ${JSON.stringify(part.args ?? null)}]`;
    case "tool_result":
      return `[tool_result ${part.toolName} ${JSON.stringify(part.result ?? null)}]`;
  }
}

function renderContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map(renderPart).join("\n");
}

/**
 * Render the forked master-thread context as a delimited transcript preamble
 * followed by the task. With no context, the task is the whole prompt.
 */
export function renderInitialPrompt(
  context: readonly ModelMessage[],
  task: string,
): string {
  if (context.length === 0) return task;
  const blocks = context.map(
    (message) => `[${message.role}]\n${renderContent(message.content)}`,
  );
  return `<master-thread>\n${blocks.join("\n\n")}\n</master-thread>\n\n${task}`;
}
