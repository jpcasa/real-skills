// The UAT walkthrough page: every flow, each step with its screenshot and a
// line on what it does, and the under-the-hood summary. Self-contained HTML;
// screenshots are published next to it as shots/<name>.png.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { passed: 'Passed', issues: 'Passed with issues', failed: 'Failed', blocked: 'Blocked', partial: 'Partial', not_run: 'Not run' };

const CSS = `
:root{--bg:#fbfaf8;--surface:#fff;--ink:#1d1c1a;--muted:#6b6862;--line:#e6e2db;--ok:#1f7a4d;--warn:#9a6400;--bad:#b3261e;--accent:#2f5bd3;--shadow:0 1px 2px rgb(0 0 0/.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--surface:#1d1c1b;--ink:#ecebe8;--muted:#a19e97;--line:#33312e;--ok:#5cc690;--warn:#e0a83a;--bad:#f2867d;--accent:#8fa9ff;--shadow:none}}
:root[data-theme="dark"]{--bg:#141413;--surface:#1d1c1b;--ink:#ecebe8;--muted:#a19e97;--line:#33312e;--ok:#5cc690;--warn:#e0a83a;--bad:#f2867d;--accent:#8fa9ff;--shadow:none}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:40px 16px 80px}h1{font-size:1.9rem;line-height:1.2;margin:0 0 8px}h2{font-size:1.3rem;margin:0}
.meta,.muted{color:var(--muted);font-size:.92rem}a{color:var(--accent)}
nav ol{padding-left:1.2rem;margin:20px 0 0}nav li{margin:4px 0}
.badge{display:inline-block;font-size:.78rem;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid currentColor;margin-left:8px;vertical-align:middle}
.passed{color:var(--ok)}.issues,.partial,.blocked{color:var(--warn)}.failed{color:var(--bad)}.not_run{color:var(--muted)}
section.flow{margin-top:48px;padding-top:24px;border-top:1px solid var(--line)}
.goal{margin:8px 0 0}.hood{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:20px 0 0;box-shadow:var(--shadow)}
ol.steps{list-style:none;padding:0;margin:24px 0 0;display:grid;gap:20px}
.step{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}
.step .text{padding:14px 16px}.step .n{font-weight:700;margin-right:6px}.step img{display:block;width:100%;height:auto;border-top:1px solid var(--line)}
.step .res{font-size:.85rem;font-weight:600;margin-left:6px}.pass{color:var(--ok)}.fail{color:var(--bad)}.skipped,.blocked{color:var(--warn)}
code{font-size:.9em;background:var(--line);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
`;

// -> { html, files: { "shots/<name>": <absolute path> } }
export function buildArtifact(run, shotPath) {
  const it = run.item;
  const files = {};
  const flows = run.flows.map((f, i) => {
    const steps = f.steps.map((s) => {
      const r = s.record;
      let img = '';
      if (r?.shot) {
        files[`shots/${s.shot}`] = shotPath(s.shot);
        img = `<img src="shots/${esc(s.shot)}" alt="Step ${s.n}: ${esc(s.action)}" loading="lazy">`;
      }
      return `<li class="step"><div class="text"><span class="n">${s.n}.</span>${esc(s.action)}${r ? `<span class="res ${esc(r.result)}">${esc(r.result)}</span>` : ''}<div class="muted">${esc(r?.what || s.expected)}</div>${r && r.result !== 'pass' && r.actual ? `<div class="muted">Saw: ${esc(r.actual)}</div>` : ''}</div>${img}</li>`;
    });
    const st = f.status || 'not_run';
    return `<section class="flow" id="f${i + 1}"><h2>${i + 1}. ${esc(f.title)}<span class="badge ${st}">${LABEL[st]}</span></h2><p class="goal">${esc(f.goal)}</p><p class="muted">Starts at <code>${esc(f.start_path)}</code></p>${f.summary ? `<div class="hood"><strong>Under the hood.</strong> ${esc(f.summary)}</div>` : ''}<ol class="steps">${steps.join('')}</ol></section>`;
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UAT ${esc(it.slug)}</title><style>${CSS}</style></head><body><main>
<h1>${esc(it.title)}</h1>
<p class="meta">${it.url ? `<a href="${esc(it.url)}">${esc(it.ref)}</a>` : esc(it.ref)}${run.env ? ` · ${esc(run.env)}` : ''} · ${run.mode === 'agent' ? 'Agent clicked' : 'User clicked'} · ${esc(run.date)}</p>
<p>${esc(it.summary)}</p>
<nav aria-label="Flows"><ol>${run.flows.map((f, i) => `<li><a href="#f${i + 1}">${esc(f.title)}</a><span class="badge ${f.status || 'not_run'}">${LABEL[f.status || 'not_run']}</span></li>`).join('')}</ol></nav>
${flows.join('\n')}
</main></body></html>
`;
  return { html, files };
}
