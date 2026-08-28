import type { MessagePart, ModelMessage } from "@daydream-code/shared";

function renderPart(part: MessagePart): string {
  switch (part.type) {
    case "text":
    case "marker":
      return part.text;
    // The bytes ride as a separate content block; this keeps the transcript
    // readable and tells the model an image was there.
    case "image":
      return `[image${part.alt ? ` ${part.alt}` : ""}]`;
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

function renderBlocks(messages: readonly ModelMessage[]): string {
  return messages
    .map((message) => `[${message.role}]\n${renderContent(message.content)}`)
    .join("\n\n");
}

/**
 * Render the forked master-thread context as a delimited transcript preamble
 * followed by the task. With no context, the task is the whole prompt.
 *
 * `transcript` is the session's *own* prior conversation, replayed from the
 * journal when no provider-side history exists (the agent driving the thread
 * changed). It gets its own delimiter — labelling it `master-thread` would
 * tell the model its earlier turns were someone else's.
 */
export function renderInitialPrompt(
  context: readonly ModelMessage[],
  task: string,
  transcript: readonly ModelMessage[] = [],
): string {
  const sections: string[] = [];
  if (context.length > 0) {
    sections.push(`<master-thread>\n${renderBlocks(context)}\n</master-thread>`);
  }
  if (transcript.length > 0) {
    sections.push(
      `<prior-transcript>\nThis thread's earlier turns, replayed because the agent driving it changed and the previous agent's provider-side history is not available to you. Continue this conversation as your own.\n\n${renderBlocks(transcript)}\n</prior-transcript>`,
    );
  }
  sections.push(task);
  return sections.join("\n\n");
}
