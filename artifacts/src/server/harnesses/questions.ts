import type { Question } from '../../shared/questions.js';
import { record, string } from './common.js';

/** Keep protocol-specific answer keys while projecting only fields the shared form can render. */
export function nativeQuestions(value: unknown, harness: 'codex' | 'claude' | 'opencode'): Question[] {
  if (!Array.isArray(value) || !value.length) throw new Error('The harness returned an empty questionnaire');
  const questions = value.map((item, index): Question => {
    const question = record(item), options = Array.isArray(question.options) ? question.options.map(value => {
      const option = record(value);
      if (!string(option.label).trim()) throw new Error('The harness returned an invalid question option');
      return { label: string(option.label), description: string(option.description), preview: string(option.preview) };
    }) : [];
    const id = harness === 'codex' ? string(question.id) : String(index);
    if (!id || !string(question.question).trim()) throw new Error('The harness returned an invalid question');
    return { id, question: string(question.question), header: string(question.header), options, multiple: harness === 'claude' ? question.multiSelect === true : question.multiple === true,
      custom: harness === 'codex' ? question.isOther === true || !options.length : harness === 'claude' || question.custom !== false, secret: question.isSecret === true };
  });
  if (new Set(questions.map(question => question.id)).size !== questions.length) throw new Error('The harness returned duplicate question IDs');
  return questions;
}
