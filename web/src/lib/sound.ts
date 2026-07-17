// Per-event audio cues. Complements the in-app NotifyStack: a long-running
// agent that finishes, needs permission, or errors while the tab is
// backgrounded is easy to miss visually, so we also play a short sound.
//
// Sounds are SYNTHESIZED with the Web Audio API rather than bundled as audio
// files — a "pack" is just a set of oscillator recipes. That keeps the whole
// feature asset-free (nothing to commit, works offline, no load/CORS gate)
// and makes adding a pack a few lines of data.
//
// Prefs live in localStorage as a single global blob (not per-project, unlike
// canvas.ts) and are exposed through a subscribable store + `useSoundPrefs`
// hook, mirroring the notify.ts store shape.

import { useEffect, useState } from 'react';

export type SoundEvent = 'complete' | 'permission' | 'error';

export const SOUND_EVENTS: { key: SoundEvent; label: string; hint: string }[] = [
  { key: 'complete', label: 'Turn complete', hint: 'A session finishes a turn' },
  { key: 'permission', label: 'Permission needed', hint: 'A tool is waiting for your approval' },
  { key: 'error', label: 'Error', hint: 'A stream fails or the agent reports an error' },
];

// One note in a cue. `at` is the offset (seconds) from cue start so a pack can
// sequence a short melody. A soft attack/release envelope avoids the click a
// raw gate would produce.
type Note = { freq: number; at: number; dur: number; type: OscillatorType; gain: number };

export type SoundPack = {
  id: string;
  label: string;
  hint: string;
  notes: Record<SoundEvent, Note[]>;
};

// Distinct timbre per pack; within a pack each event has its own shape so the
// three cues stay tellable apart by ear — complete rises, permission is a
// two-tap attention ping, error falls.
export const SOUND_PACKS: SoundPack[] = [
  {
    id: 'chime',
    label: 'Chime',
    hint: 'Warm sine bells',
    notes: {
      complete: [
        { freq: 587.33, at: 0, dur: 0.14, type: 'sine', gain: 0.5 },
        { freq: 880, at: 0.11, dur: 0.22, type: 'sine', gain: 0.5 },
      ],
      permission: [
        { freq: 784, at: 0, dur: 0.12, type: 'sine', gain: 0.55 },
        { freq: 784, at: 0.18, dur: 0.12, type: 'sine', gain: 0.55 },
      ],
      error: [
        { freq: 440, at: 0, dur: 0.16, type: 'sine', gain: 0.5 },
        { freq: 311.13, at: 0.13, dur: 0.26, type: 'sine', gain: 0.5 },
      ],
    },
  },
  {
    id: 'blip',
    label: 'Blip',
    hint: 'Retro square beeps',
    notes: {
      complete: [
        { freq: 660, at: 0, dur: 0.07, type: 'square', gain: 0.28 },
        { freq: 990, at: 0.08, dur: 0.1, type: 'square', gain: 0.28 },
      ],
      permission: [
        { freq: 880, at: 0, dur: 0.06, type: 'square', gain: 0.3 },
        { freq: 880, at: 0.12, dur: 0.06, type: 'square', gain: 0.3 },
        { freq: 880, at: 0.24, dur: 0.08, type: 'square', gain: 0.3 },
      ],
      error: [
        { freq: 392, at: 0, dur: 0.09, type: 'square', gain: 0.28 },
        { freq: 233.08, at: 0.1, dur: 0.16, type: 'square', gain: 0.28 },
      ],
    },
  },
  {
    id: 'marimba',
    label: 'Marimba',
    hint: 'Woody triangle taps',
    notes: {
      complete: [
        { freq: 523.25, at: 0, dur: 0.12, type: 'triangle', gain: 0.6 },
        { freq: 783.99, at: 0.09, dur: 0.18, type: 'triangle', gain: 0.6 },
      ],
      permission: [
        { freq: 698.46, at: 0, dur: 0.1, type: 'triangle', gain: 0.6 },
        { freq: 698.46, at: 0.16, dur: 0.14, type: 'triangle', gain: 0.6 },
      ],
      error: [
        { freq: 415.3, at: 0, dur: 0.13, type: 'triangle', gain: 0.6 },
        { freq: 277.18, at: 0.11, dur: 0.22, type: 'triangle', gain: 0.6 },
      ],
    },
  },
];

const DEFAULT_PACK = SOUND_PACKS[0]!.id;

export type SoundPrefs = {
  enabled: boolean;
  pack: string;
  volume: number; // 0..1 master multiplier
  events: Record<SoundEvent, boolean>;
};

const DEFAULT_PREFS: SoundPrefs = {
  enabled: true,
  pack: DEFAULT_PACK,
  volume: 0.6,
  events: { complete: true, permission: true, error: true },
};

const STORAGE_KEY = 'macaron.sound';

function loadPrefs(): SoundPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const j = JSON.parse(raw) as Partial<SoundPrefs>;
    const packOk = SOUND_PACKS.some((p) => p.id === j.pack);
    return {
      enabled: typeof j.enabled === 'boolean' ? j.enabled : DEFAULT_PREFS.enabled,
      pack: packOk ? j.pack! : DEFAULT_PACK,
      volume: typeof j.volume === 'number' ? Math.max(0, Math.min(1, j.volume)) : DEFAULT_PREFS.volume,
      events: {
        complete: j.events?.complete ?? true,
        permission: j.events?.permission ?? true,
        error: j.events?.error ?? true,
      },
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let prefs: SoundPrefs = loadPrefs();
const listeners = new Set<() => void>();

export function getSoundPrefs(): SoundPrefs {
  return prefs;
}

export type SoundPrefsPatch = Partial<Omit<SoundPrefs, 'events'>> & {
  events?: Partial<Record<SoundEvent, boolean>>;
};

export function setSoundPrefs(patch: SoundPrefsPatch): void {
  prefs = { ...prefs, ...patch, events: { ...prefs.events, ...(patch.events ?? {}) } };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota exceeded / disabled — keep the in-memory value */
  }
  for (const l of listeners) l();
}

export function subscribeSoundPrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSoundPrefs(): SoundPrefs {
  const [state, setState] = useState<SoundPrefs>(() => getSoundPrefs());
  useEffect(() => {
    setState(getSoundPrefs());
    return subscribeSoundPrefs(() => setState(getSoundPrefs()));
  }, []);
  return state;
}

// --- Playback ---
// Lazily-created shared AudioContext. Cues fire after the user has already
// interacted with the page (they sent the turn that produced the event), so
// resume() reliably lifts the autoplay suspension.
let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

function renderNotes(notes: Note[], master: number): void {
  if (master <= 0) return;
  const ac = audioCtx();
  if (!ac) return;
  if (ac.state === 'suspended') void ac.resume();
  const t0 = ac.currentTime;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = n.type;
    osc.frequency.value = n.freq;
    const start = t0 + n.at;
    const peak = Math.max(0.0001, Math.min(1, n.gain * master));
    // Linear attack then exponential decay — exponentialRamp can't reach 0,
    // so we floor at a tiny value and stop the node right after.
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
    osc.connect(g).connect(ac.destination);
    osc.start(start);
    osc.stop(start + n.dur + 0.02);
  }
}

function packById(id: string): SoundPack {
  return SOUND_PACKS.find((p) => p.id === id) ?? SOUND_PACKS[0]!;
}

// Play the cue for `event`, honoring the master toggle, per-event toggle, and
// volume. Cheap no-op when disabled — safe to call from any event handler.
export function playSound(event: SoundEvent): void {
  if (!prefs.enabled || !prefs.events[event]) return;
  renderNotes(packById(prefs.pack).notes[event], prefs.volume);
}

// Force-play a cue ignoring the enabled/per-event toggles — for the Settings
// preview button, which is itself a user gesture.
export function previewSound(event: SoundEvent, pack: string, volume: number): void {
  renderNotes(packById(pack).notes[event], volume);
}
