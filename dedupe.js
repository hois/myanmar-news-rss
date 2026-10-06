#!/usr/bin/env node
/**
 * Stateless Google News RSS title-near-dup clustering PoC (no deps).
 * Strategy: normalize → exact-hash merge → rare-token inverted index candidates
 * → Dice/Jaccard on token sets → optional number/entity boost → greedy clusters.
 */
'use strict';

const fs = require('fs');

const QUERY_TERMS = new Set(['myanmar', 'burma', 'myanmar\'s', 'burmese']);
const STOP = new Set([
  'a','an','the','and','or','of','to','in','on','for','as','at','by','from','with',
  'is','are','was','were','be','been','being','that','this','these','those','it','its',
  'after','before','over','under','into','about','than','then','also','says','say',
  'said','has','have','had','will','would','could','should','may','might','new','news',
]);

function stripPublisher(title) {
  // Google News: "Headline - Publisher"
  const i = title.lastIndexOf(' - ');
  if (i > 0) return { headline: title.slice(0, i), publisher: title.slice(i + 3) };
  return { headline: title, publisher: '' };
}

function nfkcLower(s) {
  return s.normalize('NFKC').toLowerCase();
}

function normalizeHeadline(headline) {
  let s = nfkcLower(headline);
  // unify quotes/dashes
  s = s.replace(/[“”„‟«»]/g, '"').replace(/[‘’‚‛]/g, "'");
  s = s.replace(/[–—−‐‑‒]/g, '-');
  s = s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // keep letters/digits/spaces; collapse punct to space
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function tokenize(norm) {
  const raw = norm.split(' ').filter(Boolean);
  const tokens = [];
  const numbers = [];
  const entities = []; // Capitalized in original — we approximate via length>=4 tokens not stop/query
  for (const t of raw) {
    if (STOP.has(t) || QUERY_TERMS.has(t)) continue;
    if (/^\d+$/.test(t) || /^\d+[,.]?\d*$/.test(t)) {
      numbers.push(t.replace(/,/g, ''));
      tokens.push('#' + t.replace(/,/g, ''));
      continue;
    }
    tokens.push(t);
    if (t.length >= 5) entities.push(t);
  }
  return { tokens: new Set(tokens), numbers: new Set(numbers), entities: new Set(entities), bag: tokens };
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

function dice(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size || 1);
}

function numberOverlap(a, b) {
  if (!a.size || !b.size) return null; // no signal
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

function charNgrams(s, n = 3) {
  const t = s.replace(/\s+/g, '');
  const g = new Set();
  for (let i = 0; i <= t.length - n; i++) g.add(t.slice(i, i + n));
  return g;
}

/** Parse minimal RSS item fields without deps */
function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const get = (tag) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (!mm) return '';
      return mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const sourceUrlMatch = block.match(/<source[^>]*url="([^"]*)"/i);
    items.push({
      title: decodeXml(get('title')),
      link: decodeXml(get('link')),
      guid: decodeXml(get('guid')),
      pubDate: get('pubDate'),
      description: get('description'),
      source: sourceMatch ? decodeXml(sourceMatch[1].trim()) : '',
      sourceUrl: sourceUrlMatch ? sourceUrlMatch[1] : '',
    });
  }
  return items;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function prepare(item) {
  const { headline, publisher } = stripPublisher(item.title);
  const norm = normalizeHeadline(headline);
  const tok = tokenize(norm);
  return {
    ...item,
    headline,
    publisher: publisher || item.source || '',
    norm,
    ...tok,
    exactKey: norm,
  };
}

/**
 * Candidate generation: inverted index on rare tokens (df <= maxDf)
 * plus always pair exact-key matches.
 */
function buildCandidates(docs, maxDfFraction = 0.35) {
  const n = docs.length;
  const maxDf = Math.max(2, Math.floor(n * maxDfFraction));
  const df = new Map();
  for (const d of docs) {
    for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);
  }
  const pairs = new Set();
  const add = (i, j) => {
    if (i === j) return;
    const a = Math.min(i, j), b = Math.max(i, j);
    pairs.add(a + ':' + b);
  };
  // exact
  const byExact = new Map();
  docs.forEach((d, i) => {
    if (!byExact.has(d.exactKey)) byExact.set(d.exactKey, []);
    byExact.get(d.exactKey).push(i);
  });
  for (const idxs of byExact.values()) {
    for (let a = 0; a < idxs.length; a++)
      for (let b = a + 1; b < idxs.length; b++) add(idxs[a], idxs[b]);
  }
  // rare token posting lists
  const postings = new Map();
  docs.forEach((d, i) => {
    for (const t of d.tokens) {
      if ((df.get(t) || 0) > maxDf) continue;
      if ((df.get(t) || 0) < 2) continue;
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push(i);
    }
  });
  for (const idxs of postings.values()) {
    // if posting too large, skip (shouldn't with maxDf)
    if (idxs.length > 40) continue;
    for (let a = 0; a < idxs.length; a++)
      for (let b = a + 1; b < idxs.length; b++) add(idxs[a], idxs[b]);
  }
  return { pairs, df };
}

function scorePair(di, dj, opts) {
  const jac = jaccard(di.tokens, dj.tokens);
  const dic = dice(di.tokens, dj.tokens);
  const ng = jaccard(charNgrams(di.norm, 3), charNgrams(dj.norm, 3));
  const num = numberOverlap(di.numbers, dj.numbers);
  let score = opts.metric === 'jaccard' ? jac : opts.metric === 'ngram' ? ng : dic;
  // number disagreement penalty: both have numbers but no overlap
  if (num === 0) score *= 0.55;
  else if (num != null && num >= 1) score = Math.min(1, score + 0.08);
  // length ratio: if one title much longer with many extra tokens → likely follow-up
  const lenRatio = Math.min(di.tokens.size, dj.tokens.size) / Math.max(di.tokens.size, dj.tokens.size, 1);
  if (lenRatio < 0.55 && score < 0.92) score *= 0.75;
  // containment: smaller almost subset of larger — wire rewrite often high containment
  let inter = 0;
  for (const t of di.tokens) if (dj.tokens.has(t)) inter++;
  const contain = inter / Math.min(di.tokens.size, dj.tokens.size || 1);
  return { score, jac, dic, ng, num, contain, lenRatio };
}

function cluster(docs, opts) {
  const { pairs } = buildCandidates(docs);
  const edges = [];
  for (const key of pairs) {
    const [i, j] = key.split(':').map(Number);
    const s = scorePair(docs[i], docs[j], opts);
    if (s.score >= opts.threshold || docs[i].exactKey === docs[j].exactKey) {
      // exact always merge
      if (docs[i].exactKey === docs[j].exactKey || s.score >= opts.threshold) {
        // follow-up guard: high extra unique tokens on one side
        const onlyI = [...docs[i].tokens].filter((t) => !docs[j].tokens.has(t));
        const onlyJ = [...docs[j].tokens].filter((t) => !docs[i].tokens.has(t));
        const asymmetric =
          Math.min(onlyI.length, onlyJ.length) >= 2 &&
          Math.max(onlyI.length, onlyJ.length) >= 4 &&
          s.contain < 0.85 &&
          docs[i].exactKey !== docs[j].exactKey;
        if (asymmetric && s.score < 0.9) continue;
        edges.push({ i, j, ...s });
      }
    }
  }
  // Union-Find
  const parent = docs.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const uni = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  for (const e of edges) {
    if (docs[e.i].exactKey === docs[e.j].exactKey || e.score >= opts.threshold) uni(e.i, e.j);
  }
  const groups = new Map();
  docs.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return { groups: [...groups.values()], edges, candidatePairs: pairs.size };
}

function pickRepresentative(idxs, docs, mode = 'earliest_pub') {
  const arr = idxs.map((i) => docs[i]);
  const parseDate = (d) => {
    const t = Date.parse(d);
    return Number.isFinite(t) ? t : Infinity;
  };
  if (mode === 'latest_pub') {
    return arr.slice().sort((a, b) => parseDate(b.pubDate) - parseDate(a.pubDate))[0];
  }
  if (mode === 'longest_title') {
    return arr.slice().sort((a, b) => b.headline.length - a.headline.length)[0];
  }
  if (mode === 'first_in_feed') {
    return arr[0];
  }
  // earliest_pub (stable GUID preference for Folo)
  return arr.slice().sort((a, b) => parseDate(a.pubDate) - parseDate(b.pubDate) || a.guid.localeCompare(b.guid))[0];
}

function runOnItems(rawItems, thresholds, metric) {
  const docs = rawItems.map(prepare);
  const results = {};
  for (const th of thresholds) {
    const { groups, candidatePairs } = cluster(docs, { threshold: th, metric });
    const multi = groups.filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
    results[th] = {
      candidatePairs,
      clusters: multi.length,
      itemsInClusters: multi.reduce((s, g) => s + g.length, 0),
      uniqueOut: groups.length,
      top: multi.slice(0, 8).map((g) => ({
        n: g.length,
        rep: pickRepresentative(g, docs).title,
        members: g.map((i) => docs[i].title),
      })),
    };
  }
  return { docs, results };
}

function parseArgs(argv) {
  const o = { files: [], thresholds: [0.55, 0.65, 0.72, 0.8, 0.9], metric: 'dice', handmade: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--metric') o.metric = argv[++i];
    else if (a === '--thresholds') o.thresholds = argv[++i].split(',').map(Number);
    else if (a === '--handmade') o.handmade = true;
    else o.files.push(a);
  }
  return o;
}

const HANDMADE = [
  { title: 'Myanmar leader to visit Malaysia after migrant returns begin - France 24', guid: 'g1', pubDate: 'Mon, 05 Oct 2026 10:00:00 GMT', source: 'France 24', link: 'https://a', description: '' },
  { title: 'Myanmar leader to visit Malaysia after migrant returns begin - The Straits Times', guid: 'g2', pubDate: 'Mon, 05 Oct 2026 11:00:00 GMT', source: 'The Straits Times', link: 'https://b', description: '' },
  { title: 'Myanmar leader announces new agreement during Malaysia visit - Reuters', guid: 'g3', pubDate: 'Mon, 05 Oct 2026 18:00:00 GMT', source: 'Reuters', link: 'https://c', description: '' },
  { title: 'Malaysia says around 10,000 Myanmar nationals sent home since January - Reuters', guid: 'g4', pubDate: 'Mon, 05 Oct 2026 09:00:00 GMT', source: 'Reuters', link: 'https://d', description: '' },
  { title: 'Malaysia says around 10,000 Myanmar nationals sent home since January - Internazionale', guid: 'g5', pubDate: 'Mon, 05 Oct 2026 09:30:00 GMT', source: 'Internazionale', link: 'https://e', description: '' },
  { title: 'Nearly 1,500 Myanmar nationals repatriated from Malaysia as UN warns of risks - AP News', guid: 'g6', pubDate: 'Mon, 05 Oct 2026 08:00:00 GMT', source: 'AP News', link: 'https://f', description: '' },
  { title: 'Nearly 1,500 Myanmar nationals repatriated from Malaysia as UN warns of risks - Toronto Star', guid: 'g7', pubDate: 'Mon, 05 Oct 2026 08:10:00 GMT', source: 'Toronto Star', link: 'https://g', description: '' },
  { title: 'Old fighter jet clips falsely linked to deadly airstrike in Myanmar - AFP Fact Check', guid: 'g8', pubDate: 'Mon, 05 Oct 2026 12:00:00 GMT', source: 'AFP', link: 'https://h', description: '' },
  { title: 'Myanmar military airstrikes on Rakhine displacement camps kill eight, rebel group says - Reuters', guid: 'g9', pubDate: 'Mon, 05 Oct 2026 16:00:00 GMT', source: 'Reuters', link: 'https://i', description: '' },
  { title: 'Myanmar military airstrikes on Rakhine displacement camps kill eight, rebel group says - marketscreener.com', guid: 'g10', pubDate: 'Mon, 05 Oct 2026 16:05:00 GMT', source: 'marketscreener.com', link: 'https://j', description: '' },
  // lightly rewritten wire
  { title: 'Myanmar leader will visit Malaysia following start of migrant returns - Yahoo', guid: 'g11', pubDate: 'Mon, 05 Oct 2026 10:20:00 GMT', source: 'Yahoo', link: 'https://k', description: '' },
];

function main() {
  const opts = parseArgs(process.argv);
  if (opts.handmade) {
    const { results } = runOnItems(HANDMADE, opts.thresholds, opts.metric);
    console.log(JSON.stringify({ source: 'handmade', metric: opts.metric, results }, null, 2));
  }
  for (const file of opts.files) {
    const xml = fs.readFileSync(file, 'utf8');
    const items = parseRssItems(xml);
    const t0 = process.hrtime.bigint();
    const { results } = runOnItems(items, opts.thresholds, opts.metric);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(JSON.stringify({ source: file, items: items.length, metric: opts.metric, cpuMsApprox: +ms.toFixed(2), results }, null, 2));
  }
}

module.exports = { parseRssItems, prepare, cluster, pickRepresentative, runOnItems, HANDMADE, normalizeHeadline, stripPublisher };

if (require.main === module) main();
