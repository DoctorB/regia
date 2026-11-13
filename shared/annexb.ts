// Flusso H.264 "Annex B" (il formato grezzo del server di scrcpy): divisione in unità NAL, usata dal server di Regia
// per tenere l'ultimo fotogramma chiave e dalla pagina per passare i fotogrammi al decoder (WebCodecs).

/** Posizione del prossimo codice di inizio (00 00 01 o 00 00 00 01) da `from`, o -1. */
function findStart(b: Uint8Array, from: number): number {
  for (let i = from; i + 2 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0) {
      if (b[i + 2] === 1) return i > from && b[i - 1] === 0 ? i - 1 : i;
      if (b[i + 2] === 0 && i + 3 < b.length && b[i + 3] === 1) return i;
    }
  }
  return -1;
}

/** Divide il flusso in unità NAL complete, ognuna con il suo codice di inizio. */
export class NalSplitter {
  private buf: Uint8Array = new Uint8Array(0);
  constructor(private onNal: (nal: Uint8Array) => void) {}

  push(chunk: Uint8Array) {
    if (this.buf.length) {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf);
      joined.set(chunk, this.buf.length);
      this.buf = joined;
    } else {
      this.buf = chunk;
    }
    let start = findStart(this.buf, 0);
    if (start < 0) return;
    for (;;) {
      const next = findStart(this.buf, start + 3);
      if (next < 0) break;
      this.onNal(this.buf.slice(start, next));
      start = next;
    }
    this.buf = this.buf.slice(start);
  }
}

const headerLength = (nal: Uint8Array) => (nal[2] === 1 ? 3 : 4);

/** Tipo dell'unità NAL: 1 = fotogramma, 5 = fotogramma chiave, 7 = SPS, 8 = PPS. */
export const nalType = (nal: Uint8Array) => nal[headerLength(nal)] & 0x1f;

/** Codec per WebCodecs dai primi byte dell'SPS (profilo, vincoli, livello), es. "avc1.640020". */
export function avcCodec(sps: Uint8Array): string {
  const o = headerLength(sps);
  return `avc1.${[sps[o + 1], sps[o + 2], sps[o + 3]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
