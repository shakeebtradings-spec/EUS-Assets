import { Orb, OrbState } from './orb';
import { Voice } from './voice';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const orb = new Orb($<HTMLCanvasElement>('orb'));
const voice = new Voice();
let ws: WebSocket;
let serverState: 'idle' | 'thinking' = 'idle';

function render() {
  const s: OrbState = voice.speaking ? 'speaking' : serverState === 'thinking' ? 'thinking' : voice.supported ? 'listening' : 'idle';
  orb.state = s;
  $('state').textContent = s;
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) return voice.enqueue(e.data);
    const m = JSON.parse(e.data);
    if (m.type === 'state') { serverState = m.state; render(); }
    else if (m.type === 'transcript' && m.role === 'jarvis') $('line').textContent = m.text;
    else if (m.type === 'error') $('err').textContent = m.message;
  };
  ws.onclose = () => setTimeout(connect, 1500);
}

function send(text: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  voice.stop();
  $('err').textContent = '';
  ws.send(JSON.stringify({ type: 'user_text', text }));
}

voice.onFinal = send;
voice.onSpeakingChange = render;
$('start').addEventListener('click', async () => { $('start').remove(); await voice.enable(); render(); });
$<HTMLFormElement>('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const i = $<HTMLInputElement>('t');
  if (i.value.trim()) send(i.value.trim());
  i.value = '';
});
(function tick() { orb.level = voice.speaking ? voice.level() : 0; requestAnimationFrame(tick); })();
connect();
render();
