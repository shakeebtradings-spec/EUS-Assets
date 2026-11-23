/** Web Speech API in, decoded MP3 chunks out, with an analyser for the orb. */
type SR = any;

export class Voice {
  private ctx = new AudioContext();
  private analyser = this.ctx.createAnalyser();
  private rec: SR | null = null;
  private queue: ArrayBuffer[] = [];
  private playing = false;
  private buf = new Uint8Array(256);
  speaking = false;
  onFinal: (text: string) => void = () => {};
  onSpeakingChange: (speaking: boolean) => void = () => {};
  supported = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  constructor() {
    this.analyser.fftSize = 512;
    this.analyser.connect(this.ctx.destination);
  }

  async enable() { await this.ctx.resume(); this.listen(); }

  private listen() {
    const C = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!C) return;
    const r: SR = (this.rec = new C());
    r.continuous = true; r.interimResults = false; r.lang = 'en-GB';
    r.onresult = (e: any) => {
      if (this.speaking) return; // ignore our own voice coming back through the mic
      const res = e.results[e.results.length - 1];
      const text = res[0].transcript.trim();
      if (res.isFinal && text) this.onFinal(text);
    };
    r.onend = () => setTimeout(() => this.listen(), 300); // Chrome ends sessions on silence
    r.onerror = () => {};
    try { r.start(); } catch { /* already started */ }
  }

  /** Current output loudness 0..1. */
  level(): number {
    this.analyser.getByteTimeDomainData(this.buf);
    let m = 0;
    for (const v of this.buf) m = Math.max(m, Math.abs(v - 128));
    return Math.min(1, m / 80);
  }

  enqueue(data: ArrayBuffer) { this.queue.push(data); void this.pump(); }

  stop() { this.queue = []; this.setSpeaking(false); }

  private setSpeaking(v: boolean) {
    if (this.speaking !== v) { this.speaking = v; this.onSpeakingChange(v); }
  }

  private async pump() {
    if (this.playing) return;
    this.playing = true;
    this.setSpeaking(true);
    while (this.queue.length) {
      try {
        const audio = await this.ctx.decodeAudioData(this.queue.shift()!);
        await new Promise<void>((done) => {
          const src = this.ctx.createBufferSource();
          src.buffer = audio; src.connect(this.analyser); src.onended = () => done(); src.start();
        });
      } catch { /* skip an undecodable chunk */ }
    }
    this.playing = false;
    this.setSpeaking(false);
  }
}
