---
name: ui-preview
description: "Use whenever the user asks to CHANGE or REDESIGN an existing UI component / page / section — reword copy, adjust layout, restyle, add a control, tighten spacing, migrate from one component library to another, etc. Render the PROPOSED result inline via `mcp__macaron.render_ui` BEFORE writing any code to disk. The user confirms via Apply / Tweak / Discard buttons; only Apply writes files. Do NOT jump straight to Edit/Write — preview first, ship on confirm."
---

# UI Preview (see it before you write it)

Frontend edits are a class of change where "read the diff to know if it's right" is much slower than "look at it". This skill inverts the usual write-first-then-user-eyeballs flow: render the proposed after-state in chat as a working preview, and only touch files when the user clicks Apply.

## When this fires

Any request to modify an existing UI area:
- "Redesign this button / card / hero / modal"
- "Change the login form to have avatars on the left"
- "Make this list more compact / spacier / dark-mode / mobile-first"
- "Move the submit button to the top"
- "Add a settings panel to the sidebar"
- "Migrate from Material to shadcn / from Tailwind v2 to v3"
- "Improve the copy on this landing page hero"
- "Tighten spacing across the dashboard cards"

Does NOT fire for:
- Non-visual code changes (business logic, API handlers, tests).
- Brand-new files with no existing UI to compare against — that's a normal render_ui.
- Purely visual TODO you're asked to just describe, not implement.

## The flow

**Step 1: read the current source.** Find the target component(s). Read enough surrounding code to know what props / state / classes are in play. If it's a large page, read the specific section only.

**Step 2: render the AFTER state.** Call `render_ui` with a TSX module that IS the proposed replacement — same visual, same interactions, ideally re-using the same `$macaron/ui` components. Inline any state / mock props needed to make it visually complete. Do NOT stub interactive parts as "placeholder" — a preview the user can't play with is useless.

**Step 3: end the widget with 3 buttons.**

```tsx
<Row className="gap-2 justify-end mt-4">
  <Button variant="ghost"
    onClick={() => sendUserMessage("Discard this preview, keep the current UI.")}>
    Discard
  </Button>
  <Button variant="outline"
    onClick={() => sendUserMessage("Tweak this preview: [describe what to change]. Re-render.")}>
    Tweak
  </Button>
  <Button
    onClick={() => sendUserMessage("Apply this preview to the actual file(s). Write the changes now.")}>
    Apply →
  </Button>
</Row>
```

The Tweak button's message is a template — real code should hint at common tweaks (e.g. "Tweak spacing / colors / copy / layout — say which").

**Step 4: ONE-sentence ack.** "Preview above. Click Apply to write, Tweak to iterate, Discard to keep as-is." Do NOT describe the changes in prose; the preview shows them.

**Step 5 (on Apply):** now do the file writes with Edit / Write. The next turn will fire because the button called sendUserMessage. Do the writes, then a one-line "Written to X, Y." confirmation.

## Rules

- **Preview must be the actual proposal, not a mock.** If the user asked for dark mode, render the dark version. If they asked to move the submit button, the moved button IS in the preview.
- **Never Apply-and-Preview in the same turn.** The preview's point is that the user hasn't approved yet.
- **Preserve the component's public API** unless the user explicitly asked to change props. If the current component takes `{ title, onSubmit }`, the preview's showcase should still exercise those.
- **If the change is trivial** (single className tweak, copy edit under 5 chars) skip the preview and Edit directly — otherwise you're adding a click for a no-op review.
- **If multiple files change**, the preview can be just the primary visible piece; mention the other files in a small footer under the buttons ("Also updates: `Header.tsx`, `types.ts`").

## Example flow (compressed)

**User**: "Make the login card more modern — bigger padding, softer shadow, put the logo on top instead of the side."

**You**:
1. Read `src/views/Login.tsx` (silent).
2. `render_ui({ code: "…the redesigned <LoginCard /> with the new layout…" })` — includes the 3-button footer.
3. Assistant text: "Preview above. Click Apply to write, Tweak to iterate, Discard to keep as-is."

**User clicks Apply.**

**You**: `Edit src/views/Login.tsx` with the new JSX. Then: "Written."

## Why this beats write-then-review

- Reviewing a diff for visual changes is slow and error-prone; the eyes catch what code doesn't.
- Iteration cost drops from "revert commit, re-prompt, re-diff" to "click Tweak, describe, click again".
- Locks the model into producing complete, runnable output (the preview HAS to work) instead of half-finished TSX that "looks right in the diff".
