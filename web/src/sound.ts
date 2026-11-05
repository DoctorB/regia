// Segnali sonori brevi, sintetizzati con Web Audio: nessun file audio da distribuire.
import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../shared/types.ts';

const STORAGE_KEY = 'regia.sound';
export type Cue = 'attention' | 'done' | 'failed';

// Note (Hz) suonate in sequenza: due toni ascendenti per chiedere attenzione, un arpeggio per la fine, toni discendenti per il fallimento.
const CUES: Record<Cue, number[]> = {
  attention: [660, 880],
  done: [523.25, 659.25, 783.99],
  failed: [440, 330],
};

let ctx: AudioContext | null = null;

export function soundEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== 'off'; } catch { return true; }
}

export function setSoundEnabled(on: boolean) {
  try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* non disponibile */ }
}

export function playCue(cue: Cue) {
  if (!soundEnabled()) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime + 0.02;
    CUES[cue].forEach((freq, i) => {
      const t0 = start + i * 0.14;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t0);
      osc.stop(t0 + 0.35);
    });
  } catch { /* audio non disponibile */ }
}

const LIVE = new Set<Run['status']>(['in_corso', 'attesa_intervento']);

/**
 * Suona quando una fase dell'esecuzione aperta comincia ad aspettare un intervento e quando l'esecuzione termina.
 * Lo stato già presente all'apertura di un'esecuzione non fa suonare nulla.
 */
export function useRunSounds(run: Run | null) {
  const prev = useRef<{ id: string; pending: Set<string>; live: boolean } | null>(null);
  useEffect(() => {
    if (!run) { prev.current = null; return; }
    const pending = new Set(Object.values(run.nodes).filter((n) => n.pendingActions?.length).map((n) => n.nodeId));
    const live = LIVE.has(run.status);
    const p = prev.current;
    prev.current = { id: run.id, pending, live };
    if (!p || p.id !== run.id) return;
    // Annullamento e sospensione li decide la persona: nessun suono.
    if (p.live && !live) { if (run.status !== 'annullata' && run.status !== 'sospesa') playCue(run.status === 'completata' ? 'done' : 'failed'); }
    else if ([...pending].some((id) => !p.pending.has(id))) playCue('attention');
  }, [run]);
}

/** Stato dell'interruttore dei suoni, salvato nel browser. */
export function useSoundSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(soundEnabled);
  return [on, (v) => { setSoundEnabled(v); setOn(v); if (v) playCue('attention'); }];
}
