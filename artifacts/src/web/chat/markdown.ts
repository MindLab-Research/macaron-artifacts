import { cjk } from '@streamdown/cjk';
import { createMathPlugin } from '@streamdown/math';

// Leave single dollars literal so prices do not become formulas.
export const markdownPlugins = { cjk, math: createMathPlugin({ errorColor: 'var(--muted)' }) };
