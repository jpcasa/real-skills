// The UAT guide page: what the next tester follows to repeat this UAT. Per flow
// who to sign in as, where in the app, where to start, a route map of the steps,
// then each step as the screen looks before it is done, with the element to use
// ringed, and the outcome. Developers get the under-the-hood notes folded away.
// Self-contained HTML; screenshots are published next to it as shots/<name>.png.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { passed: 'Passed', issues: 'Passed, with errors behind the scenes', failed: 'Failed', blocked: 'Blocked', partial: 'Partly done', not_run: 'Not run' };
const RESULT = { pass: 'Worked', fail: 'Did not work', skipped: 'Skipped', blocked: 'Blocked' };
const short = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1).trimEnd()}…` : String(s));

// Authored icons, one stroke weight.
const svg = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  user: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
  place: svg('<path d="M4 6h16M4 12h10M4 18h7"/><path d="m16 15 3 3-3 3"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  alert: svg('<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
};

const CSS = `
:root{color-scheme:light;--paper:#f7f5f0;--sheet:#fffdf9;--ink:#1c1b19;--soft:#5d5a53;--rule:#e4dfd5;--mark:#d9480f;--mark-ink:#fff;--ok:#2b7a4b;--warn:#8a5a00;--bad:#b42318;--chip:#efebe3;--shadow:0 1px 2px rgb(40 30 10/.06),0 8px 24px -12px rgb(40 30 10/.18)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--paper:#161513;--sheet:#1e1d1a;--ink:#ece8df;--soft:#a8a397;--rule:#34312b;--mark:#ff7a3d;--mark-ink:#1a0d05;--ok:#6fcf97;--warn:#e7b04a;--bad:#ff8b80;--chip:#2a2824;--shadow:0 1px 2px rgb(0 0 0/.4),0 8px 24px -12px rgb(0 0 0/.6)}}
:root[data-theme="dark"]{color-scheme:dark;--paper:#161513;--sheet:#1e1d1a;--ink:#ece8df;--soft:#a8a397;--rule:#34312b;--mark:#ff7a3d;--mark-ink:#1a0d05;--ok:#6fcf97;--warn:#e7b04a;--bad:#ff8b80;--chip:#2a2824;--shadow:0 1px 2px rgb(0 0 0/.4),0 8px 24px -12px rgb(0 0 0/.6)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.6 "Public Sans",ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums}
::selection{background:var(--mark);color:var(--mark-ink)}
a{color:inherit;text-decoration-color:var(--mark);text-underline-offset:.2em;text-decoration-thickness:2px}
a:focus-visible,summary:focus-visible,.shot:focus-visible{outline:3px solid var(--mark);outline-offset:3px;border-radius:4px}
main{max-width:880px;margin:0 auto;padding:56px 16px 96px}
h1{font-size:clamp(1.9rem,4.5vw,2.6rem);line-height:1.12;letter-spacing:-.02em;margin:0 0 12px;text-wrap:balance}
h2{font-size:1.5rem;line-height:1.2;letter-spacing:-.01em;margin:0;text-wrap:balance}
h3{font-size:1rem;margin:0}
p{margin:0}.soft{color:var(--soft)}.lede{font-size:1.1rem;max-width:65ch;margin-top:8px}
.meta{color:var(--soft);font-size:.92rem;margin-top:14px}
.i{width:1.15em;height:1.15em;flex:none;vertical-align:-.2em}
.chip{display:inline-flex;align-items:center;gap:.4em;font-size:.8rem;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--chip);white-space:nowrap}
.passed,.pass{color:var(--ok)}.issues,.partial,.blocked,.skipped{color:var(--warn)}.failed,.fail{color:var(--bad)}.not_run{color:var(--soft)}
.review{margin-top:32px;padding:20px 24px;border-radius:14px;background:var(--mark);color:var(--mark-ink)}.review h2{font-size:1.15rem;margin:0 0 6px}.review p{max-width:65ch}
.skip{margin-top:40px}.skip h2{font-size:1.15rem;margin-bottom:8px}.skip ul{margin:0;padding-left:1.2rem;color:var(--soft)}
.start{margin-top:40px;padding:24px;background:var(--sheet);border-radius:14px;box-shadow:var(--shadow)}
.start h2{font-size:1.15rem;margin-bottom:12px}
.start ul{margin:0;padding-left:1.2rem}.start li+li{margin-top:6px}
.legend{display:flex;gap:12px;align-items:center;margin-top:16px;color:var(--soft);font-size:.92rem}
.legend .swatch{width:34px;height:22px;border-radius:6px;outline:3px solid var(--mark);outline-offset:-1px;flex:none}
.index{list-style:none;padding:0;margin:40px 0 0;border-top:1px solid var(--rule)}
.index li{border-bottom:1px solid var(--rule)}
.index a{display:grid;grid-template-columns:2.2rem 1fr auto;gap:12px;align-items:baseline;padding:14px 4px;text-decoration:none}
.index a:hover .t{text-decoration:underline;text-decoration-color:var(--mark)}
.index .n{font-weight:700;color:var(--mark)}.index .t{font-weight:600}.index .sub{display:block;font-size:.88rem;color:var(--soft);font-weight:400}
section.flow{margin-top:88px;scroll-margin-top:24px}
.flow-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.context{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:20px 0 0;padding:0}
.context div{display:grid;grid-template-columns:auto 1fr;column-gap:10px;align-items:start;padding:12px 14px;background:var(--sheet);border-radius:10px;box-shadow:var(--shadow);min-width:0}
.context dt{font-size:.78rem;font-weight:700;color:var(--soft);letter-spacing:.02em}
.context dd{margin:0;font-weight:600;overflow-wrap:anywhere}
.context .i{color:var(--mark);margin-top:3px;grid-row:span 2}
.goal{margin-top:18px;max-width:65ch}
.pre{margin:14px 0 0;padding-left:1.2rem;color:var(--soft)}
.route{display:flex;gap:0;overflow-x:auto;margin:28px 0 0;padding:4px 2px 14px;list-style:none;scrollbar-color:var(--rule) transparent}
.route li{flex:0 0 132px;position:relative;padding-top:42px;font-size:.84rem;line-height:1.35;color:var(--soft)}
.route li::before{content:"";position:absolute;top:15px;left:0;right:0;height:2px;background:var(--rule)}
.route li:first-child::before{left:16px}.route li:last-child::before{right:calc(100% - 16px)}
.route a{text-decoration:none;display:block;padding-right:12px}
.route .dot{position:absolute;top:0;left:0;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:.9rem;background:var(--sheet);color:var(--ink);box-shadow:inset 0 0 0 2px var(--mark)}
.route li.end .dot{background:var(--mark);color:var(--mark-ink);box-shadow:none}
.route a:hover span{color:var(--ink)}
ol.steps{list-style:none;padding:0;margin:40px 0 0}
.step{display:grid;grid-template-columns:44px 1fr;gap:0 18px;position:relative;padding-bottom:48px;scroll-margin-top:24px}
.step::before{content:"";position:absolute;left:21px;top:44px;bottom:0;width:1px;background:var(--rule)}
.step:last-child::before{display:none}
.num{width:44px;height:44px;border-radius:50%;background:var(--mark);color:var(--mark-ink);display:grid;place-items:center;font-weight:700;font-size:1.1rem}
.step.end .num{background:var(--ink);color:var(--paper)}
.do{font-size:1.15rem;font-weight:600;line-height:1.4;padding-top:8px;max-width:60ch}
.see{margin-top:6px;max-width:65ch}.see b{font-weight:600}
.why{margin-top:4px;font-size:.92rem;color:var(--soft)}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.careful{color:var(--warn)}
figure{margin:18px 0 0;grid-column:2}
.shot{display:block;position:relative;border-radius:10px;overflow:hidden;box-shadow:var(--shadow);background:var(--sheet);line-height:0}
.shot img{display:block;width:100%;height:auto}
.ring{position:absolute;border-radius:8px;outline:3px solid var(--mark);outline-offset:3px;box-shadow:0 0 0 9999px rgb(20 15 5/.16)}
.pin{position:absolute;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:50%;background:var(--mark);color:var(--mark-ink);display:grid;place-items:center;font-weight:700;font-size:.85rem;line-height:1;box-shadow:0 2px 6px rgb(0 0 0/.3)}
figcaption{margin-top:8px;font-size:.88rem;color:var(--soft)}
.noshot{grid-column:2;margin-top:14px;padding:14px;border:1px dashed var(--rule);border-radius:10px;color:var(--soft);font-size:.9rem}
details{margin-top:8px;background:var(--sheet);border-radius:12px;box-shadow:var(--shadow)}
summary{cursor:pointer;padding:14px 18px;font-weight:600}
details>div{padding:0 18px 18px;color:var(--soft);max-width:70ch}
details code{font-size:.88em;overflow-wrap:anywhere}
footer{margin-top:96px;padding-top:20px;border-top:1px solid var(--rule);color:var(--soft);font-size:.86rem}
@media (max-width:560px){body{font-size:16px}.step{grid-template-columns:34px 1fr;gap:0 12px}.num{width:34px;height:34px;font-size:.95rem}.step::before{display:none}.do{padding-top:4px}figure,.noshot{grid-column:1/-1}}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}.ring{animation:ring .9s cubic-bezier(.16,1,.3,1) both}@keyframes ring{from{outline-offset:14px;opacity:0}}}
`;

function figure(src, alt, box, n, caption) {
  const ring = box ? `<span class="ring" style="left:${box[0] * 100}%;top:${box[1] * 100}%;width:${box[2] * 100}%;height:${box[3] * 100}%"></span><span class="pin" style="left:${box[0] * 100}%;top:${box[1] * 100}%">${n}</span>` : '';
  return `<figure><a class="shot" href="${esc(src)}" title="Open full size"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">${ring}</a>${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`;
}

function flowSection(run, f, i, files, shotPath) {
  const id = `f${i + 1}`;
  const st = f.status || 'not_run';
  const who = f.observed?.signed_in_as ? `${f.role} · ${f.observed.signed_in_as}` : f.role;
  const url = `${run.base_url || ''}${f.start_path}`;
  const route = [
    ...f.steps.map((s) => `<li><a href="#${id}-s${s.n}"><span class="dot">${s.n}</span><span>${esc(short(s.action, 54))}</span></a></li>`),
    `<li class="end"><a href="#${id}-end"><span class="dot">${svg('<path d="m5 12 4.5 4.5L19 7"/>')}</span><span>${esc(short(f.steps.at(-1)?.expected || 'Done', 54))}</span></a></li>`,
  ].join('');
  const steps = f.steps.map((s) => {
    const r = s.record;
    let pic = '';
    if (r?.shot) {
      files[`shots/${s.shot}`] = shotPath(s.shot);
      pic = figure(`shots/${s.shot}`, `Screen before step ${s.n}: ${s.action}`, r.box, s.n, r.box ? 'The ringed area is what to use.' : 'The screen before this step.');
    } else if (r) pic = '<p class="noshot">No screenshot was saved for this step.</p>';
    const chips = [
      r ? `<span class="chip ${esc(r.result)}">${RESULT[r.result]}</span>` : '',
      s.confirm ? `<span class="chip careful">${ICON.alert}Changes or sends data</span>` : '',
    ].join('');
    return `<li class="step" id="${id}-s${s.n}"><span class="num" aria-hidden="true">${s.n}</span><div><p class="do"><span class="sr">Step ${s.n}: </span>${esc(s.action)}</p><p class="see"><b>You should see:</b> ${esc(s.expected)}</p>${r?.what ? `<p class="why">${esc(r.what)}</p>` : ''}${r && r.result !== 'pass' && r.actual ? `<p class="why ${esc(r.result)}">What happened: ${esc(r.actual)}</p>` : ''}${chips ? `<div class="row">${chips}</div>` : ''}</div>${pic}</li>`;
  });
  let end = '';
  if (f.end) {
    files[`shots/${f.end_shot}`] = shotPath(f.end_shot);
    end = figure(`shots/${f.end_shot}`, `Outcome of ${f.title}`, null, 0, '');
  }
  steps.push(`<li class="step end" id="${id}-end"><span class="num" aria-hidden="true">${ICON.flag}</span><div><p class="do">Where you end up</p><p class="see">${esc(f.steps.at(-1)?.expected || '')}</p></div>${end}</li>`);
  return `<section class="flow" id="${id}" aria-labelledby="${id}-h">
<div class="flow-head"><h2 id="${id}-h">${i + 1}. ${esc(f.title)}</h2>${run.approved ? `<span class="chip ${st}">${LABEL[st]}</span>` : `<span class="chip">${f.steps.length} steps</span>`}</div>
<dl class="context">
<div>${ICON.user}<dt>Sign in as</dt><dd>${esc(who)}</dd></div>
<div>${ICON.place}<dt>Where in the app</dt><dd>${esc(f.observed?.section || f.section)}</dd></div>
<div>${ICON.link}<dt>Start at</dt><dd>${run.base_url ? `<a href="${esc(url)}">${esc(f.start_path)}</a>` : esc(f.start_path)}</dd></div>
</dl>
<p class="goal">${esc(f.goal)}</p>
${f.preconditions.length ? `<ul class="pre">${f.preconditions.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
<ol class="route" aria-label="Steps at a glance">${route}</ol>
<ol class="steps">${steps.join('')}</ol>
${f.summary ? `<details><summary>For developers: what happened behind the scenes</summary><div><p>${esc(f.summary)}</p>${f.facts?.failed?.length ? `<p style="margin-top:8px">Failed calls: ${f.facts.failed.map((x) => `<code>${esc(x)}</code>`).join(', ')}</p>` : ''}</div></details>` : ''}
</section>`;
}

// -> { html, files: { "shots/<name>": <absolute path> } }
export function buildArtifact(run, shotPath) {
  const it = run.item;
  const files = {};
  const roles = [...new Set(run.flows.map((f) => f.role))];
  const draft = !run.approved;
  const notes = run.notes || { requires: [], not_covered: [] };
  const sections = run.flows.map((f, i) => flowSection(run, f, i, files, shotPath));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UAT ${esc(it.slug)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>${CSS}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}</style></head><body><main>
<h1>${esc(it.title)}</h1>
<p class="lede">${esc(it.summary)}</p>
<p class="meta">${it.url ? `<a href="${esc(it.url)}">${esc(it.ref)}</a>` : esc(it.ref)}${draft ? ` · drafted ${esc(run.date)} · not walked yet` : ` · ${esc(run.env || '')} · tested ${esc(run.date)} · ${run.mode === 'agent' ? 'walked by the agent' : 'walked by a person'}`}</p>
${draft ? `<aside class="review" role="note"><h2>Draft for review</h2><p>Read the flows below, then answer in the chat: approve them as they are, or say what to add, drop or change. Screenshots and results fill in after the walk, on this same page.</p></aside>` : ''}
<aside class="start" aria-labelledby="start-h">
<h2 id="start-h">Before you start</h2>
<ul>
${run.base_url ? `<li>Open <a href="${esc(run.base_url)}">${esc(run.base_url)}</a>${run.env ? ` (${esc(run.env)})` : ''}.</li>` : ''}
<li>Have a login for ${roles.map((r) => `<b>${esc(r)}</b>`).join(', ')}. Use a test account, never a customer's.</li>
${notes.requires.map((r) => `<li>${esc(r)}</li>`).join('')}
<li>Go through the flows in order.${draft ? '' : ' Each step shows the screen as it looks just before you act.'}</li>
</ul>
${draft ? '' : '<p class="legend"><span class="swatch" aria-hidden="true"></span>A ringed area is what to click or fill in for that step.</p>'}
</aside>
<ol class="index">${run.flows.map((f, i) => `<li><a href="#f${i + 1}"><span class="n">${i + 1}</span><span><span class="t">${esc(f.title)}</span><span class="sub">${esc(f.role)} · ${esc(f.observed?.section || f.section)}</span></span>${draft ? `<span class="chip">${f.steps.length} steps</span>` : `<span class="chip ${f.status || 'not_run'}">${LABEL[f.status || 'not_run']}</span>`}</a></li>`).join('')}</ol>
${notes.not_covered.length ? `<section class="skip" aria-labelledby="skip-h"><h2 id="skip-h">Not covered here</h2><ul>${notes.not_covered.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>` : ''}
${sections.join('\n')}
<footer>Made with /lets-do-uat from run ${esc(run.run_id)}. The same flows live in <code>${esc(`${run.docs_dir}/${it.slug}/flows.md`)}</code>.</footer>
</main></body></html>
`;
  return { html, files };
}
