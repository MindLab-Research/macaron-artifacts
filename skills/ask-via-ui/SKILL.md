---
name: ask-via-ui
description: "Whenever you would ask the user a question — pick between options, confirm a plan, fill in fields, disambiguate a target, adjust a value — render an interactive card via `mcp__macaron.render_ui` and collect the answer through `sendUserMessage`. The built-in `AskUserQuestion` tool is DISABLED in this environment; text-only 'reply with your choice' prompts are also NOT allowed. Every question the user has to answer must be a clickable widget."
---

# Ask via UI (never as plain text)

`AskUserQuestion` is disabled here. Text prompts like "which one?", "reply 1/2/3", "should I do X or Y?" are equally forbidden — a plain-text question forces the user to type a reply, when a widget could resolve it in one click and carry richer context (form values, adjusted sliders, selected chips) back to the next turn.

**Rule**: If your turn would end with the user needing to answer, that answer must arrive via a widget you rendered.

## When this fires (non-exhaustive)

- **Commit / push gate**: "want me to commit this?", "should I push?", "open a PR?" — the end-of-work hand-off. Two buttons, and optionally a default with a countdown (template C).
- **Choice**: "Pick a framework", "which of these files did you mean", "A or B?", boolean confirms.
- **Form**: any request for structured input — name/email/config values, migration parameters, tuning knobs.
- **Adjustment**: pick a color, resize a padding, choose a threshold. Slider / color picker / preview + apply beats "give me a number".
- **Disambiguation**: 3 matching functions, 2 possible interpretations, several branches you could take.
- **Confirmation before a destructive action**: "apply this migration?" → render the diff summary + Apply / Cancel buttons.
- **Sequential wizard**: multi-step configuration — render one step at a time, each step's Continue button posts the state.

## The pattern

Every widget you render for an answer must:
1. Show the question clearly at the top (one sentence).
2. Present the answer surface (buttons / inputs / sliders / whatever fits) using `$macaron/ui` components.
3. On submit / click, call `sendUserMessage(...)` with a natural-language sentence that includes every value the next turn needs. Fold structured data (JSON fenced block) into that string when the fields don't compress into prose.
4. End your assistant text after render with a one-sentence ack ("Pick one above.", "Fill out the form."). Do NOT restate the options in prose.

## Templates

### A. Choice picker (2–5 options)

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Stack, Button } from '$macaron/ui';
import { sendUserMessage } from '$macaron/chat';

const options = [
  { id: 'a', label: 'Option A', hint: 'why this one', reply: 'Go with option A' },
  { id: 'b', label: 'Option B', hint: 'why this one', reply: 'Go with option B' },
];

export default function App() {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Pick one</CardTitle>
        <CardDescription>The decision, in one sentence.</CardDescription>
      </CardHeader>
      <CardContent>
        <Stack className="gap-2">
          {options.map((o) => (
            <Button
              key={o.id}
              variant="outline"
              className="justify-start h-auto py-3 text-left"
              onClick={() => sendUserMessage(o.reply)}
            >
              <div className="flex flex-col items-start gap-0.5">
                <span className="font-medium">{o.label}</span>
                <span className="text-xs opacity-70">{o.hint}</span>
              </div>
            </Button>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
```

### B. Form (structured input)

```tsx
import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, Stack, Input, Label, Button, Switch } from '$macaron/ui';
import { sendUserMessage } from '$macaron/chat';

export default function App() {
  const [name, setName] = useState('');
  const [port, setPort] = useState('3000');
  const [ssl, setSsl] = useState(true);

  const submit = () => {
    const payload = { name, port: Number(port), ssl };
    sendUserMessage(
      `Configure with: ${name} on :${port} (ssl=${ssl}).\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
    );
  };

  return (
    <Card className="max-w-md">
      <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
      <CardContent>
        <Stack className="gap-3">
          <div><Label>Service name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-api" /></div>
          <div><Label>Port</Label><Input type="number" value={port} onChange={(e) => setPort(e.target.value)} /></div>
          <div className="flex items-center justify-between"><Label>Enable SSL</Label><Switch checked={ssl} onCheckedChange={setSsl} /></div>
          <Button onClick={submit} disabled={!name}>Apply</Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
```

### C. Commit gate (with a default + countdown)

The most common question a coding agent asks — "want me to commit this?" — is also the one most often typed as prose. It is two buttons.

Add the countdown ONLY when the session gives you evidence the user wants the default to just happen: they said "just commit" / "don't ask me", or they've approved the same thing several times already. No evidence → same card, drop the `useAutoSend` line and the `(Ns)` suffix.

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Row, Button, Text } from '$macaron/ui';
import { sendUserMessage, useAutoSend } from '$macaron/chat';

const COMMIT = 'Commit it.';
const SKIP = "Don't commit — leave the changes in the working tree.";

export default function App() {
  // Counts down and sends COMMIT if the user does nothing; `left` is the seconds
  // remaining, or null when nothing is counting (e.g. a re-opened transcript —
  // the host refuses to arm there, so the buttons stay but the timer doesn't).
  const left = useAutoSend(COMMIT, 30);

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Commit these changes?</CardTitle>
        <CardDescription>3 files, +82 −14 — `feat: add retry to the upload queue`</CardDescription>
      </CardHeader>
      <CardContent>
        <Row className="gap-2 justify-end items-center">
          {left !== null && <Text className="text-xs opacity-60 mr-auto">Committing automatically in {left}s</Text>}
          <Button variant="ghost" onClick={() => sendUserMessage(SKIP)}>Don't commit</Button>
          <Button onClick={() => sendUserMessage(COMMIT)}>Commit{left !== null ? ` (${left}s)` : ''}</Button>
        </Row>
      </CardContent>
    </Card>
  );
}
```

Show the file/diff summary in the card — the user is approving a specific change, and a bare "Commit?" makes the button meaningless. Same shape for push / open-a-PR / apply-migration gates.

### D. Confirm before destructive

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Row, Button } from '$macaron/ui';
import { sendUserMessage } from '$macaron/chat';

export default function App() {
  return (
    <Card className="max-w-md border-amber-200">
      <CardHeader>
        <CardTitle>Delete 12 files?</CardTitle>
        <CardDescription>This can't be undone.</CardDescription>
      </CardHeader>
      <CardContent>
        <Row className="gap-2 justify-end">
          <Button variant="outline" onClick={() => sendUserMessage("Cancel, don't delete anything.")}>Cancel</Button>
          <Button variant="destructive" onClick={() => sendUserMessage('Yes, delete the 12 files.')}>Delete 12 files</Button>
        </Row>
      </CardContent>
    </Card>
  );
}
```

## Common failure modes to avoid

- Writing "Which one? 1. A  2. B  3. C" then waiting. — Fail. Render buttons.
- Rendering the widget AND ALSO listing the options in prose. — Redundant; the card is the answer surface.
- Making buttons that just log or alert instead of calling `sendUserMessage`. — The next turn never sees the click.
- Forgetting to import `sendUserMessage` (`import { sendUserMessage } from '$macaron/chat';`). Bare call also works via `globalThis.sendUserMessage`, but the import is the documented path.
- Emitting a widget without a `reply` payload string on each option — the next turn can't tell what was chosen.
- Arming a countdown the user never asked for, or one whose remaining seconds aren't visible on the button. Both turn "convenient" into "it committed behind my back".
- Passing a different string to `useAutoSend` than to the default button's `sendUserMessage` — clicking early then does something other than what the label promised.
- Rolling your own `setTimeout` inside the widget instead of `useAutoSend` — a widget-local timer re-fires every time the transcript is re-opened.
