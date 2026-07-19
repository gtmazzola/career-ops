#!/usr/bin/env node
// CAREERFAX — teletext front-end for career-ops, rendered into DEVONthink.
// Parses data/applications.md, data/pipeline.md, data/scan-history.tsv and
// emits careerfax/P1xx-*.html (one record per page) plus index.html (terminal).
// Zero dependencies. Run from repo root:  node careerfax/generate.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = HERE;
const W = 40; // teletext columns

// ---------- parse ----------
function parseApplications() {
  const md = readFileSync(join(ROOT, 'data/applications.md'), 'utf8');
  const rows = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const c = line.split('|').map(s => s.trim());
    if (!/^\d+$/.test(c[1])) continue;
    const m = (c[8] || '').match(/\((reports\/[^)]+)\)/);
    rows.push({
      num: +c[1], date: c[2], company: c[3], role: c[4],
      score: parseFloat(c[5]) || 0, status: c[6],
      report: m ? m[1] : null, notes: c.slice(9).join('|') || c[9] || '',
    });
  }
  rows.sort((a, b) => b.num - a.num);
  return rows;
}

function parsePipeline() {
  const md = readFileSync(join(ROOT, 'data/pipeline.md'), 'utf8');
  const cut = md.indexOf('## Procesadas');
  const pend = cut > -1 ? md.slice(0, cut) : md;
  const pending = [], blocked = [];
  for (const line of pend.split('\n')) {
    let m = line.match(/^- \[ \] (\S+) \| ([^|]+) \| (.+)$/);
    if (m) { pending.push({ url: m[1], company: m[2].trim(), title: m[3].trim() }); continue; }
    m = line.match(/^- \[!\] (\S+) \| ([^|]+) \| (.+?) — Error: (.+)$/);
    if (m) blocked.push({ company: m[2].trim(), title: m[3].trim(), reason: m[4].trim() });
  }
  const processed = (md.match(/^- \[x\]/gm) || []).length;
  return { pending, blocked, processed };
}

function parseScanHistory() {
  const tsv = readFileSync(join(ROOT, 'data/scan-history.tsv'), 'utf8').trim().split('\n');
  const portals = {};
  let firstSeen = null;
  for (const line of tsv.slice(1)) {
    const c = line.split('\t');
    if (c.length < 3) continue;
    if (!firstSeen || c[1] < firstSeen) firstSeen = c[1];
    const p = c[2];
    if (p && p !== 'Multi-portal scheduled scan') portals[p.toLowerCase()] = (portals[p.toLowerCase()] || 0) + 1;
  }
  const top = Object.entries(portals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { seen: tsv.length - 1, top, firstSeen };
}

function shortReason(r) {
  const s = r.toLowerCase();
  if (/language|thai|spanish|french|fluen/.test(s)) return 'language';
  if (/deadline|expired|closed/.test(s)) return 'deadline past';
  if (/already underway|filled|no longer|removed/.test(s)) return 'filled/gone';
  const m = s.match(/(\d+)\+?\s*(?:years|yrs|yr)/);
  if (m) return m[1] + 'yr exp reqd';
  if (/resid|relocat|duty station|geograph|citizen|local/.test(s)) return 'geography';
  if (/domain|mismatch|niche|ineligible/.test(s)) return 'domain';
  return clip(r, 12);
}

function classifyBlockers(blocked) {
  const cats = { 'expired deadline': 0, 'experience gap': 0, 'language': 0, 'geography': 0, 'domain mismatch': 0, 'other': 0 };
  for (const b of blocked) {
    const r = b.reason.toLowerCase();
    if (/deadline|expired|closed|already underway|filled|no longer/.test(r)) cats['expired deadline']++;
    else if (/\d+\s*(\+\s*)?(years|yrs|yr)|experience|senior|grade/.test(r)) cats['experience gap']++;
    else if (/language|thai|spanish|french|fluen/.test(r)) cats['language']++;
    else if (/resid|relocat|duty station|geograph|citizen|local|based/.test(r)) cats['geography']++;
    else if (/domain|mismatch|niche|ineligible/.test(r)) cats['domain mismatch']++;
    else cats['other']++;
  }
  return cats;
}

// ---------- 40-col row builder ----------
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function row(...segs) {
  // segs: [text, class, href?] — truncated collectively to 40 cols
  let used = 0, html = '';
  for (const [t, c, href] of segs) {
    if (used >= W) break;
    const take = String(t).slice(0, W - used);
    used += take.length;
    const span = `<span class="${c || 'w'}">${esc(take)}</span>`;
    html += href ? `<a href="${href}">${span}</a>` : span;
  }
  return `<div class="row">${html}</div>`;
}
const blank = () => `<div class="row"> </div>`;
const clip = (t, n) => String(t).length > n ? String(t).slice(0, n) : String(t);
const padE = (t, n) => clip(t, n).padEnd(n);

// ---------- page bodies (arrays of row-html, max 22 rows) ----------
function scoreClass(s) { return s >= 3.2 ? 'g' : s >= 2.5 ? 'y' : 'r'; }

function buildPages(apps, pipe, scan) {
  const P = {};
  const latest = apps.slice(0, 12);
  const picks = apps.filter(a => a.score >= 3.2).sort((a, b) => b.score - a.score || b.num - a.num).slice(0, 9);
  const urgent = apps.find(a => /URGENT/i.test(a.notes));
  const cats = classifyBlockers(pipe.blocked);
  const catTotal = Math.max(1, Object.values(cats).reduce((a, b) => a + b, 0));
  const clearDays = Math.ceil(pipe.pending.length / 10);

  P[100] = {
    name: 'INDEX', link: 'P100-index.html', rows: [
      blank(),
      `<div class="row dh"><span class="y">  CAREERFAX</span><span class="w"> 100</span></div>`,
      blank(),
      row(['  the career-ops teletext service     ', 'c']),
      row([' '.repeat(W), 'bgb']),
      blank(),
      row(['  LATEST EVALUATIONS ', 'w', 'P101-latest.html'], ['........ ', 'b'], ['101', 'y', 'P101-latest.html']),
      row(['  TOP PICKS ≥ 3.2 ', 'w', 'P102-top-picks.html'], ['........... ', 'b'], ['102', 'y', 'P102-top-picks.html']),
      row(['  PIPELINE STATUS ', 'w', 'P103-pipeline.html'], ['............ ', 'b'], ['103', 'y', 'P103-pipeline.html']),
      row(['  SCAN STATISTICS ', 'w', 'P104-stats.html'], ['............ ', 'b'], ['104', 'y', 'P104-stats.html']),
      row(['  BLOCKED / SKIPPED ', 'w', 'P105-blocked.html'], ['.......... ', 'b'], ['105', 'y', 'P105-blocked.html']),
      blank(),
      row(['  QUEUE ', 'c'], [String(pipe.pending.length), 'g'], [' pend ', 'c'],
          [String(pipe.processed), 'g'], [' done ', 'c'], [String(pipe.blocked.length), 'r'], [' blkd', 'c']),
      blank(),
      row(['  Scans nightly 09:00 ICT              ', 'c']),
      row(['  Evaluator follows at 11:00 ICT       ', 'c']),
      blank(),
      ...(urgent ? [row(['  URGENT: ', 'r'], [clip(`#${urgent.num} ${urgent.company}`, 24), 'y', urgent.report ? '../' + urgent.report : 'P101-latest.html'])] : [blank()]),
      blank(),
      row(['  Select a page • built ' + new Date().toISOString().slice(0, 10) + '     ', 'g']),
    ]
  };

  P[101] = {
    name: 'LATEST EVALUATIONS', link: 'P101-latest.html', rows: [
      row(['  LATEST EVALUATIONS                   ', 'bgc']),
      blank(),
      row(['  ### COMPANY     ROLE                SC', 'y']),
      ...latest.map(a => row(
        ['  ' + a.num, 'g', a.report ? '../' + a.report : undefined],
        [' ' + padE(a.company, 10), 'c'],
        [' ' + padE(a.role, 19), 'w'],
        [' ' + a.score.toFixed(1), scoreClass(a.score)]
      )),
      blank(),
      row(['  score ≥3.2 ', 'g'], ['2.5-3.1 ', 'y'], ['<2.5', 'r']),
      row(['  ' + apps.length + ' evaluations on file — click # for', 'c']),
      row(['  the full report                      ', 'c']),
      blank(),
      row(['  Index 100  ', 'g', 'P100-index.html'], ['Picks 102  ', 'g', 'P102-top-picks.html'], ['Pipeline 103', 'g', 'P103-pipeline.html']),
    ]
  };

  const pickNotes = picks.filter(a => /RECOMMEND APPLY/i.test(a.notes)).slice(0, 2);
  P[102] = {
    name: 'TOP PICKS', link: 'P102-top-picks.html', rows: [
      row(['  TOP PICKS  score ≥ 3.2               ', 'bgg']),
      blank(),
      row(['  ### COMPANY         ROLE          SC  ', 'y']),
      ...picks.map(a => row(
        ['  ' + a.num, 'g', a.report ? '../' + a.report : undefined],
        [' ' + padE(a.company, 14), 'c'],
        [' ' + padE(a.role, 13), 'w'],
        [' ' + a.score.toFixed(1), 'g']
      )),
      blank(),
      ...pickNotes.flatMap(a => [
        row(['  ' + a.num + ' ', 'w'], [clip(a.notes.split(';')[0], 34), 'w']),
        row(['      ', 'w'], ['RECOMMEND APPLY', 'bgr']),
      ]),
      blank(),
      row(['  ' + picks.length + ' picks above threshold of ' + apps.length + ' eval  ', 'c']),
      blank(),
      row(['  Index 100  ', 'g', 'P100-index.html'], ['Latest 101  ', 'g', 'P101-latest.html'], ['Stats 104', 'g', 'P104-stats.html']),
    ]
  };

  const done = pipe.processed, pnd = pipe.pending.length, blk = pipe.blocked.length;
  const tot = Math.max(1, done + pnd + blk);
  const bar = n => Math.max(1, Math.round(30 * n / tot));
  P[103] = {
    name: 'PIPELINE', link: 'P103-pipeline.html', rows: [
      row(['  PIPELINE STATUS                      ', 'bgy']),
      blank(),
      row(['  PENDING     ', 'c'], [String(pnd).padStart(3), 'g'], ['  awaiting evaluation ', 'w']),
      row(['  PROCESSED   ', 'c'], [String(done).padStart(3), 'g'], ['  scored + filed      ', 'w']),
      row(['  BLOCKED     ', 'c'], [String(blk).padStart(3), 'r'], ['  skipped w/ reason   ', 'w']),
      blank(),
      row(['  ', 'w'], ['█'.repeat(bar(done)), 'g'], ['█'.repeat(bar(pnd)), 'y'], ['█'.repeat(bar(blk)), 'r']),
      row(['  done         pending        blocked  ', 'c']),
      blank(),
      row(['  NEXT IN QUEUE                        ', 'y']),
      ...pipe.pending.slice(0, 5).map(p => row(
        ['  ' + padE(p.company, 8), 'c'], [clip(p.title, 30), 'w']
      )),
      blank(),
      row(['  Evaluator processes 10 per night     ', 'c']),
      row(['  est. queue clearance: ', 'c'], [clearDays + ' days', 'y']),
      blank(),
      row(['  Index 100  ', 'g', 'P100-index.html'], ['Blocked 105', 'g', 'P105-blocked.html']),
    ]
  };

  P[104] = {
    name: 'SCAN STATS', link: 'P104-stats.html', rows: [
      row(['  SCAN STATISTICS                      ', 'bgc']),
      blank(),
      row(['  URLS SEEN   ', 'c'], [String(scan.seen).padStart(5), 'g'], ['  since ' + (scan.firstSeen || '').slice(5), 'w']),
      row(['  TRACKED     ', 'c'], [String(apps.length).padStart(5), 'g'], ['  evaluations       ', 'w']),
      row(['  REPORT NO.  ', 'c'], [String(apps[0]?.num || 0).padStart(5), 'g'], ['  latest            ', 'w']),
      blank(),
      row(['  TOP PORTALS            hits          ', 'y']),
      ...scan.top.map(([p, n]) => {
        const barLen = Math.max(1, Math.round(8 * n / scan.top[0][1]));
        return row(['  ' + padE(p, 22), 'w'], [String(n).padStart(4) + ' ', 'w'], ['█'.repeat(barLen), 'c']);
      }),
      blank(),
      row(['  LAST BUILD  ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC   ', 'w']),
      row(['  NEXT SCAN   tonight 09:00 ICT        ', 'w']),
      blank(),
      row(['  Index 100  ', 'g', 'P100-index.html'], ['Pipeline 103', 'g', 'P103-pipeline.html']),
    ]
  };

  P[105] = {
    name: 'BLOCKED', link: 'P105-blocked.html', rows: [
      row(['  BLOCKED / SKIPPED                    ', 'bgr']),
      blank(),
      row(['  ORG      ROLE             REASON      ', 'y']),
      ...pipe.blocked.slice(0, 8).map(b => row(
        ['  ' + padE(b.company, 7), 'c'],
        [' ' + padE(b.title, 16), 'w'],
        [' ' + padE(shortReason(b.reason), 13), 'r']
      )),
      blank(),
      row(['  COMMON BLOCKERS                      ', 'y']),
      ...Object.entries(cats).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => {
        const pct = Math.round(100 * n / catTotal);
        return row(['  ' + padE(k, 17), 'w'], ['█'.repeat(Math.max(1, Math.round(pct / 8))), 'r'], [' ' + pct + '%', 'r']);
      }),
      blank(),
      row(['  ' + pipe.blocked.length + ' blocked this cycle of ' + scan.seen + ' seen   ', 'c']),
      blank(),
      row(['  Index 100  ', 'g', 'P100-index.html'], ['Latest 101', 'g', 'P101-latest.html']),
    ]
  };

  return P;
}

// ---------- shells ----------
const FONT = readFileSync(join(HERE, 'vt323.b64.txt'), 'utf8').trim();

const CSS = `
@font-face{font-family:'VT323';src:url(data:font/woff2;base64,${FONT}) format('woff2');}
html,body{margin:0;padding:0;background:#1a1a1a;}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;}
#tv{background:#000;padding:24px 28px;border-radius:14px;position:relative;
box-shadow:0 0 60px rgba(0,255,255,.07),inset 0 0 80px rgba(0,0,0,.6);}
#tv::after{content:'';position:absolute;inset:0;pointer-events:none;border-radius:14px;
background:repeating-linear-gradient(0deg,rgba(0,0,0,.18) 0 1px,transparent 1px 3px);}
#screen{font-family:'VT323','Courier New',monospace;font-size:22px;line-height:1.05;width:40ch;}
.row{white-space:pre;height:1.05em;overflow:hidden;}
.dh{transform:scaleY(2);transform-origin:top;height:2.1em;}
.r{color:#f00}.g{color:#0f0}.y{color:#ff0}.b{color:#4444ff}.m{color:#f0f}.c{color:#0ff}.w{color:#fff}
.bgb{background:#4444ff;color:#fff}.bgr{background:#f00;color:#fff}.bgy{background:#ff0;color:#000}
.bgc{background:#0ff;color:#000}.bgg{background:#0f0;color:#000}
a{color:inherit;text-decoration:none}a:hover span{background:#fff;color:#000}
#fastext{display:flex;margin-top:6px;font-family:'VT323',monospace;font-size:22px}
#fastext a{flex:1;text-align:center;cursor:pointer;text-decoration:none}
`;

function headerRow(num, live) {
  if (live) return ''; // terminal renders its own
  const now = new Date();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = days[now.getUTCDay()] + ' ' + String(now.getUTCDate()).padStart(2,'0') + ' ' + mons[now.getUTCMonth()];
  const c = String(now.getUTCHours()).padStart(2,'0') + ':' + String(now.getUTCMinutes()).padStart(2,'0') + ' UTC';
  return `<div class="row"><span class="w">P${num}</span><span class="g"> CAREERFAX ${num} </span><span class="y">${d}</span><span class="w"> ${c}</span></div>`;
}

function staticPage(num, page) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>P${num} CAREERFAX — ${page.name}</title><style>${CSS}</style></head>
<body><div id="tv"><div id="screen">
${headerRow(num)}
${page.rows.slice(0, 22).join('\n')}
</div>
<div id="fastext"><a class="r" href="P100-index.html">Index</a><a class="g" href="P102-top-picks.html">Top Picks</a><a class="y" href="P103-pipeline.html">Pipeline</a><a class="c" href="P104-stats.html">Stats</a></div>
</div></body></html>`;
}

function terminal(P) {
  const bodies = {};
  for (const [n, p] of Object.entries(P)) bodies[n] = p.rows.slice(0, 22).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CAREERFAX — career-ops teletext</title><style>${CSS}
.lnkrow{cursor:pointer}</style></head>
<body><div id="tv"><div id="screen"></div>
<div id="fastext"><a class="r" data-p="100">Index</a><a class="g" data-p="102">Top Picks</a><a class="y" data-p="103">Pipeline</a><a class="c" data-p="104">Stats</a></div>
</div>
<script>
const BODIES=${JSON.stringify(bodies)};
let cur=100,buf="";
const scr=document.getElementById('screen');
function render(){
  const now=new Date();
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],mons=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const clk=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')+'/'+String(now.getSeconds()).padStart(2,'0');
  const pnum=buf.length?('P'+buf.padEnd(3,'-')):('P'+cur);
  const date=days[now.getDay()]+' '+String(now.getDate()).padStart(2,'0')+' '+mons[now.getMonth()];
  scr.innerHTML='<div class="row"><span class="w">'+pnum+'</span><span class="g"> CAREERFAX '+cur+' </span><span class="y">'+date+'</span><span class="w"> '+clk+'</span></div>'+BODIES[cur];
  // convert page links to in-terminal jumps; leave report links live
  scr.querySelectorAll('a').forEach(a=>{
    const m=(a.getAttribute('href')||'').match(/^P(10[0-5])-/);
    if(m){a.removeAttribute('href');a.classList.add('lnkrow');a.onclick=e=>{e.preventDefault();go(+m[1]);};}
  });
}
function go(n){if(BODIES[n]){cur=n;buf='';render();}}
document.querySelectorAll('#fastext a').forEach(a=>a.onclick=e=>{e.preventDefault();go(+a.dataset.p);});
document.addEventListener('keydown',e=>{
  if(/^[0-9]$/.test(e.key)){buf+=e.key;if(buf.length===3){const n=+buf;buf='';if(BODIES[n])cur=n;}render();}
  else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){
    const ks=Object.keys(BODIES).map(Number).sort((a,b)=>a-b);
    cur=ks[(ks.indexOf(cur)+(e.key==='ArrowRight'?1:ks.length-1))%ks.length];buf='';render();}
  else if(e.key==='Escape'){buf='';render();}
});
setInterval(render,1000);render();
</script></body></html>`;
}

// ---------- main ----------
const apps = parseApplications();
const pipe = parsePipeline();
const scan = parseScanHistory();
const P = buildPages(apps, pipe, scan);

mkdirSync(OUT, { recursive: true });
for (const [n, p] of Object.entries(P)) writeFileSync(join(OUT, p.link), staticPage(n, p));
writeFileSync(join(OUT, 'index.html'), terminal(P));
console.log(`CAREERFAX built: ${Object.keys(P).length} pages + terminal`);
console.log(`  apps=${apps.length} pending=${pipe.pending.length} processed=${pipe.processed} blocked=${pipe.blocked.length} seen=${scan.seen}`);
