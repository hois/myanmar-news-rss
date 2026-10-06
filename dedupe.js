#!/usr/bin/env node
/**
 * Stateless Google News RSS title-near-dup clustering PoC (no deps).
 * Strategy: normalize → exact-hash merge → rare-token inverted index candidates
 * → token Dice with number/length guards → Union-Find clusters.
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
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, value) => {
      const hexadecimal = value[0].toLowerCase() === 'x';
      const codePoint = Number.parseInt(hexadecimal ? value.slice(1) : value, hexadecimal ? 16 : 10);
      const validXmlCharacter =
        codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff);
      if (!Number.isInteger(codePoint) || !validXmlCharacter) return entity;
      return String.fromCodePoint(codePoint);
    })
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
function buildCandidates(docs, maxDfFraction = 0.35, includeFuzzy = true) {
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
  if (!includeFuzzy) return { pairs, df };

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

  // Equal non-empty token sets can still be candidates when all their tokens
  // are too common for the rare-token index. Anchor each bucket to its first
  // member so this adds O(bucket size) pairs rather than a full pair expansion.
  const byTokenSignature = new Map();
  docs.forEach((d, i) => {
    if (!d.tokens.size) return;
    const signature = JSON.stringify([...d.tokens].sort());
    if (!byTokenSignature.has(signature)) byTokenSignature.set(signature, []);
    byTokenSignature.get(signature).push(i);
  });
  for (const idxs of byTokenSignature.values()) {
    for (let i = 1; i < idxs.length; i++) add(idxs[0], idxs[i]);
  }
  return { pairs, df };
}

function scorePair(di, dj) {
  const rawDice = dice(di.tokens, dj.tokens);
  const num = numberOverlap(di.numbers, dj.numbers);
  let adjustedScore = rawDice;
  // number disagreement penalty: both have numbers but no overlap
  if (num === 0) adjustedScore *= 0.55;
  else if (num != null && num >= 1) adjustedScore = Math.min(1, adjustedScore + 0.08);
  // length ratio: if one title much longer with many extra tokens → likely follow-up
  const lenRatio = Math.min(di.tokens.size, dj.tokens.size) / Math.max(di.tokens.size, dj.tokens.size, 1);
  if (lenRatio < 0.55 && adjustedScore < 0.92) adjustedScore *= 0.75;
  // containment: smaller almost subset of larger — wire rewrite often high containment
  let inter = 0;
  for (const t of di.tokens) if (dj.tokens.has(t)) inter++;
  const contain = inter / Math.min(di.tokens.size, dj.tokens.size || 1);
  return { rawDice, adjustedScore, num, contain, lenRatio };
}

function validateMode(mode) {
  if (mode !== 'dice' && mode !== 'exact') {
    throw new Error(`Invalid mode "${mode}"; expected "dice" or "exact"`);
  }
  return mode;
}

function isStrictSubset(a, b) {
  if (a.size >= b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

function cluster(docs, opts = {}) {
  const mode = validateMode(opts.mode === undefined ? 'dice' : opts.mode);
  const threshold = opts.threshold === undefined ? 0.8 : opts.threshold;
  const { pairs } = buildCandidates(docs, 0.35, mode === 'dice');
  const edges = [];
  const diagnostics = opts.debug ? [] : undefined;
  const reasonCounts = {};
  let scoredPairs = 0;
  let mergedPairs = 0;
  let rejectedPairs = 0;
  const recordPair = (diagnostic) => {
    reasonCounts[diagnostic.reason] = (reasonCounts[diagnostic.reason] || 0) + 1;
    if (diagnostic.decision === 'merge') mergedPairs++;
    else rejectedPairs++;
    if (diagnostics) diagnostics.push(diagnostic);
  };
  for (const key of pairs) {
    const [i, j] = key.split(':').map(Number);
    const di = docs[i], dj = docs[j];
    if (di.exactKey === dj.exactKey) {
      edges.push({ i, j, rawDice: 1, adjustedScore: 1, exact: true });
      recordPair({ i, j, rawDice: 1, adjustedScore: 1, decision: 'merge', reason: 'exact_key' });
      continue;
    }
    if (mode === 'exact') continue;

    scoredPairs++;
    const score = scorePair(di, dj);
    const strictSubset = isStrictSubset(di.tokens, dj.tokens) || isStrictSubset(dj.tokens, di.tokens);
    const onlyI = [...di.tokens].filter((t) => !dj.tokens.has(t));
    const onlyJ = [...dj.tokens].filter((t) => !di.tokens.has(t));
    const asymmetric =
      Math.min(onlyI.length, onlyJ.length) >= 2 &&
      Math.max(onlyI.length, onlyJ.length) >= 4 &&
      score.contain < 0.85;
    let reason;
    if (strictSubset && score.rawDice < 0.85) reason = 'strict_subset_raw_dice_below_0.85';
    else if (score.adjustedScore < threshold) reason = 'adjusted_score_below_threshold';
    else if (asymmetric && score.adjustedScore < 0.9) reason = 'asymmetric_follow_up_guard';
    else reason = 'dice_threshold';

    const merge = reason === 'dice_threshold';
    recordPair({
      i,
      j,
      rawDice: score.rawDice,
      adjustedScore: score.adjustedScore,
      decision: merge ? 'merge' : 'reject',
      reason,
    });
    if (merge) edges.push({ i, j, ...score });
  }
  // Union-Find
  const parent = docs.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const uni = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  for (const e of edges) uni(e.i, e.j);
  const groups = new Map();
  docs.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  const groupList = [...groups.values()];
  const stats = {
    candidatePairs: pairs.size,
    scoredPairs,
    mergedPairs,
    rejectedPairs,
    clusters: groupList.filter((g) => g.length > 1).length,
    itemsInClusters: groupList.filter((g) => g.length > 1).reduce((n, g) => n + g.length, 0),
    uniqueOut: groupList.length,
    reasonCounts,
  };
  return { groups: groupList, edges, candidatePairs: pairs.size, stats, diagnostics };
}

function compareStrings(a, b) {
  const left = String(a || ''), right = String(b || '');
  return left < right ? -1 : left > right ? 1 : 0;
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
  return arr.slice().sort((a, b) =>
    parseDate(a.pubDate) - parseDate(b.pubDate) ||
    compareStrings(a.guid, b.guid) ||
    compareStrings(a.title, b.title)
  )[0];
}

function runOnItems(rawItems, thresholds = [0.8], mode = 'dice', debug = false) {
  validateMode(mode);
  const docs = rawItems.map(prepare);
  const results = {};
  for (const th of thresholds) {
    const { groups, stats, diagnostics } = cluster(docs, { threshold: th, mode, debug });
    const multi = groups.filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
    results[th] = {
      ...stats,
      top: multi.slice(0, 8).map((g) => ({
        n: g.length,
        rep: pickRepresentative(g, docs).title,
        members: g.map((i) => docs[i].title),
      })),
      ...(debug ? { diagnostics } : {}),
    };
  }
  return { docs, results };
}

function parseArgs(argv) {
  const o = { files: [], thresholds: [0.8], mode: process.env.DEDUPE_MODE || 'dice', handmade: false, debug: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') o.mode = argv[++i];
    else if (a === '--thresholds') o.thresholds = argv[++i].split(',').map(Number);
    else if (a === '--handmade') o.handmade = true;
    else if (a === '--debug') o.debug = true;
    else o.files.push(a);
  }
  validateMode(o.mode);
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
  const report = (source, rawItems) => {
    const started = process.hrtime.bigint();
    const { results } = runOnItems(rawItems, opts.thresholds, opts.mode, opts.debug);
    const cpuMsApprox = Number(process.hrtime.bigint() - started) / 1e6;
    const summary = Object.fromEntries(Object.entries(results).map(([threshold, result]) => [threshold, {
      candidatePairs: result.candidatePairs,
      scoredPairs: result.scoredPairs,
      mergedPairs: result.mergedPairs,
      rejectedPairs: result.rejectedPairs,
      clusters: result.clusters,
      itemsInClusters: result.itemsInClusters,
      uniqueOut: result.uniqueOut,
    }]));
    console.log(JSON.stringify({ source, mode: opts.mode, items: rawItems.length, cpuMsApprox: +cpuMsApprox.toFixed(2), results: summary }));
    if (opts.debug) {
      for (const [threshold, result] of Object.entries(results)) {
        console.error(JSON.stringify({ type: 'dedupe-debug', threshold, stats: summary[threshold], reasonCounts: result.reasonCounts, pairs: result.diagnostics }));
      }
    }
  };
  if (opts.handmade) {
    report('handmade', HANDMADE);
  }
  for (const file of opts.files) {
    const xml = fs.readFileSync(file, 'utf8');
    const items = parseRssItems(xml);
    report(file, items);
  }
}

module.exports = {
  buildCandidates,
  cluster,
  decodeXml,
  HANDMADE,
  normalizeHeadline,
  parseRssItems,
  pickRepresentative,
  prepare,
  runOnItems,
  scorePair,
  stripPublisher,
  validateMode,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
