// Renders arbitrary LLM and file content: createElement / textContent ONLY, never innerHTML.
interface Run { id: string; prompt: string; status: string; cwd: string; result: string | null; error: string | null }
interface Ev { id: number; kind: string; data: Record<string, unknown> }

const list = document.getElementById('list')!;
const detail = document.getElementById('detail')!;
let selected: string | null = null;
let lastEv = 0;

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const j = async <T>(url: string, init?: RequestInit): Promise<T> => (await fetch(url, init)).json();

async function loadRuns() { // reconcile against the API; the websocket is only a hint
  const runs = await j<Run[]>('/api/runs');
  list.replaceChildren(...runs.map((r) => {
    const row = el('div', 'run' + (r.id === selected ? ' sel' : ''));
    row.append(el('span', 'st ' + r.status, r.status), el('span', '', r.prompt.slice(0, 80)));
    row.onclick = () => { selected = r.id; lastEv = 0; detail.replaceChildren(); void loadRuns(); void loadEvents(); };
    return row;
  }));
}

async function loadEvents() {
  if (!selected) return;
  const id = selected;
  const [run, evs] = await Promise.all([j<Run>(`/api/runs/${id}`), j<Ev[]>(`/api/runs/${id}/events?after=${lastEv}`)]);
  if (id !== selected) return;
  if (lastEv === 0) {
    detail.replaceChildren(el('div', 'ev', run.prompt), el('div', 'ev', `cwd: ${run.cwd}`));
    const bar = el('div', 'ev');
    const cancel = el('button', '', 'Cancel');
    cancel.onclick = () => fetch(`/api/runs/${id}/cancel`, { method: 'POST' });
    bar.append(cancel);
    detail.append(bar);
  }
  for (const e of evs) {
    lastEv = e.id;
    const body = e.kind === 'tool_use' ? JSON.stringify(e.data.input) : String(e.data.text ?? JSON.stringify(e.data));
    const row = el('div', 'ev');
    row.append(el('span', 'k', e.kind === 'tool_use' ? `tool:${e.data.name}` : e.kind), document.createTextNode(body));
    detail.append(row);
  }
  if (run.error && run.status !== 'running') detail.append(el('div', 'ev failed', run.error));
}

document.getElementById('f')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = document.getElementById('p') as HTMLInputElement, c = document.getElementById('c') as HTMLInputElement;
  if (!p.value.trim()) return;
  await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' },
                             body: JSON.stringify({ prompt: p.value, cwd: c.value || undefined }) });
  p.value = '';
  void loadRuns();
});

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/runs`);
  ws.onmessage = (m) => { const d = JSON.parse(m.data); void loadRuns(); if (d.run_id === selected) void loadEvents(); };
  ws.onclose = () => setTimeout(connect, 1500);
}
connect();
void loadRuns();
