export interface Question {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multiple?: boolean;
  custom?: boolean;
  secret?: boolean;
  placeholder?: string;
}
export interface QuestionRequest { id: string; questions: Question[] }
export type QuestionResponse = { answers: Record<string, string[]> } | { cancelled: true };
export type QuestionState = QuestionRequest & { response?: QuestionResponse };

/** Validate against the pending request, never against question metadata supplied by the browser. */
export function parseQuestionResponse(request: QuestionRequest, value: unknown): QuestionResponse | undefined {
  if (!value || typeof value !== 'object') return;
  if ('cancelled' in value && value.cancelled === true) return { cancelled: true };
  if (!('answers' in value) || !value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers)) return;
  const answers = value.answers as Record<string, unknown>;
  if (Object.keys(answers).length !== request.questions.length) return;
  const entries: [string, string[]][] = [];
  for (const question of request.questions) {
    const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
    if (!Array.isArray(answer) || !answer.length || (!question.multiple && answer.length !== 1)) return;
    if (!answer.every(item => typeof item === 'string' && item.trim() && item.length <= 20_000) || new Set(answer).size !== answer.length) return;
    if (!question.custom && answer.some(item => !question.options.some(option => option.label === item))) return;
    entries.push([question.id, answer]);
  }
  return { answers: Object.fromEntries(entries) };
}
