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
  onStatus: (msg: string) => void = () => {};
  onSpeakingChange: (speaking: boolean) => void = () => {};
  supported = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  constructor() {
    this.analyser.fftSize = 512;
    this.analyser.connect(this.ctx.destination);
  }

  private wanted = false;
  private starting = false;
  onHearing: (text: string) => void = () => {};

  async enable() { await this.ctx.resume(); this.wanted = true; this.listen(); }

  /** One utterance per recognition session, restarted automatically: far more
   *  reliable in Chrome than continuous mode, which silently dies. */
  private listen() {
    const C = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!C) { this.onStatus('This browser has no speech recognition. Use Chrome.'); return; }
    if (!this.wanted || this.speaking || this.starting) return;
    this.starting = true;
    const r: SR = (this.rec = new C());
    r.continuous = false; r.interimResults = true; r.lang = 'en-GB'; r.maxAlternatives = 1;
    let fatal = false;
    r.onstart = () => { this.starting = false; this.onStatus(''); this.onHearing('Listening...'); };
    r.onresult = (e: any) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      if (interim) this.onHearing('Hearing: ' + interim);
      if (final.trim() && !this.speaking) { this.onHearing('Heard: ' + final.trim()); this.onFinal(final.trim()); }
    };
    r.onerror = (e: any) => {
      const why: Record<string, string> = {
        'not-allowed': 'Microphone blocked. Click the lock icon in the address bar, allow Microphone, then reload.',
        'service-not-allowed': 'Microphone blocked. Click the lock icon in the address bar, allow Microphone, then reload.',
        'audio-capture': 'No microphone found. Check Windows Settings > Privacy > Microphone and your default input device.',
        'network': 'Chrome speech recognition needs internet access (it uses Google servers).',
      };
      if (why[e.error]) { this.onStatus(why[e.error]); if (e.error !== 'network' && e.error !== 'audio-capture') fatal = true; }
      else if (e.error !== 'no-speech' && e.error !== 'aborted') this.onStatus(`Speech error: ${e.error}`);
    };
    r.onend = () => {
      this.starting = false;
      if (this.wanted && !fatal) setTimeout(() => this.listen(), 250);
    };
    try { r.start(); } catch { this.starting = false; setTimeout(() => this.listen(), 500); }
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
    if (this.speaking !== v) {
      this.speaking = v;
      if (v) { try { this.rec?.abort(); } catch { /* not running */ } }
      else setTimeout(() => this.listen(), 400);
      this.onSpeakingChange(v);
    }
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
