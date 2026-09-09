type ToolResult = { state?: string; output?: unknown };

export function toolOutput({ state, output }: ToolResult, commandOutput?: string): string {
  if (state === 'output-available' && output && typeof output === 'object' && !Array.isArray(output) && 'content' in output && Array.isArray(output.content)) {
    const content = output.content;
    // pi's final text includes native truncation notices and can replace the streamed prefix.
    if (content.every((part): part is { type: 'text'; text: string } => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')) return content.map(part => part.text).join('\n');
  }
  return commandOutput ?? (typeof output === 'string' ? output : output !== undefined ? JSON.stringify(output, null, 2) : '');
}
