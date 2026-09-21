import claudeCode from '@lobehub/icons-static-svg/icons/claudecode.svg?url';
import codex from '@lobehub/icons-static-svg/icons/codex.svg?url';
import openCode from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import pi from '@lobehub/icons-static-svg/icons/pi.svg?url';
import hermes from '@lobehub/icons-static-svg/icons/hermesagent.svg?url';
import openclaw from '@lobehub/icons-static-svg/icons/openclaw.svg?url';
import type { HarnessId } from '../../shared/types';

const icons: Record<HarnessId, string> = { 'claude-code': claudeCode, codex, opencode: openCode, pi, hermes, openclaw };

export function HarnessIcon({ harness }: { harness: HarnessId }) {
  // A mask lets upstream brand artwork inherit the selected button's accessible theme color.
  return <span aria-hidden="true" className="size-5 shrink-0 bg-current" style={{ mask: `url("${icons[harness]}") center / contain no-repeat` }} />;
}
