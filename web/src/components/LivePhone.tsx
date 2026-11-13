// Schermo del telefono dal vivo durante un collaudo: legge il flusso H.264 da Regia, lo decodifica con WebCodecs
// e lo disegna su un canvas. Si riconnette da solo finché il collaudo è in corso; si ingrandisce con un clic.
import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Smartphone } from 'lucide-react';
import { NalSplitter, avcCodec, nalType } from '../../../shared/annexb.ts';
import { useI18n } from '../i18n.tsx';

type State = 'connecting' | 'live' | 'unsupported' | 'error';

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const same = (a?: Uint8Array, b?: Uint8Array) => Boolean(a && b && a.length === b.length && a.every((x, i) => x === b[i]));

export function LivePhone({ url }: { url: string }) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<State>('connecting');
  const [big, setBig] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (typeof VideoDecoder === 'undefined') { setState('unsupported'); return; }
    const ctrl = new AbortController();
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    let decoder: VideoDecoder | undefined;
    let sps: Uint8Array | undefined;
    let pps: Uint8Array | undefined;
    let configured: Uint8Array | undefined;
    let waitingKey = true;
    let ts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const setup = () => {
      decoder?.close();
      decoder = new VideoDecoder({
        output: (frame) => {
          if (cv.width !== frame.displayWidth || cv.height !== frame.displayHeight) { cv.width = frame.displayWidth; cv.height = frame.displayHeight; }
          ctx.drawImage(frame, 0, 0);
          frame.close();
          setState('live');
        },
        error: () => { waitingKey = true; },
      });
      decoder.configure({ codec: avcCodec(sps!), optimizeForLatency: true });
      configured = sps;
      waitingKey = true;
    };
    const decode = (data: Uint8Array, key: boolean) => {
      if (!decoder || decoder.state !== 'configured') return;
      // Se la pagina resta indietro (scheda in secondo piano) si salta al prossimo fotogramma chiave.
      if (!key && decoder.decodeQueueSize > 8) { waitingKey = true; return; }
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (ts += 33_333), data }));
    };
    const splitter = new NalSplitter((nal) => {
      const type = nalType(nal);
      if (type === 7) { sps = nal; return; }
      if (type === 8) { pps = nal; return; }
      if (type === 5 && sps && pps) {
        // Cambio di risoluzione (rotazione del telefono): nuovo SPS, si riconfigura il decoder.
        if (!same(sps, configured)) setup();
        waitingKey = false;
        decode(join([sps, pps, nal]), true);
      } else if (type === 1 && !waitingKey) {
        decode(nal, false);
      }
    });

    void (async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) splitter.push(value);
        }
        throw new Error('ended');
      } catch {
        if (ctrl.signal.aborted) return;
        setState((s) => (s === 'live' ? 'connecting' : 'error'));
        retry = setTimeout(() => setAttempt((x) => x + 1), 2000);
      }
    })();
    return () => { ctrl.abort(); clearTimeout(retry); try { decoder?.close(); } catch { /* già chiuso */ } };
  }, [url, attempt]);

  useEffect(() => {
    if (!big) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setBig(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [big]);

  return (
    <div className={`phone-live ${big ? 'big' : ''}`} onClick={big ? () => setBig(false) : undefined}>
      <div className="phone-live-head">
        <Smartphone /><strong>{t('run.uat.liveTitle')}</strong>
        <span className={`dot ${state === 'live' ? 'on' : ''}`} />
        <span className="muted small">{t(`run.uat.live.${state}`)}</span>
        <span className="grow" />
        {state === 'live' && (
          <button className="icon-btn ghost" onClick={(e) => { e.stopPropagation(); setBig((b) => !b); }} title={t(big ? 'run.uat.shrink' : 'run.uat.enlarge')} aria-label={t(big ? 'run.uat.shrink' : 'run.uat.enlarge')}>
            {big ? <Minimize2 /> : <Maximize2 />}
          </button>
        )}
      </div>
      <canvas ref={canvas} className={state === 'live' ? '' : 'hidden'} onClick={(e) => { if (!big) { e.stopPropagation(); setBig(true); } }} />
    </div>
  );
}
