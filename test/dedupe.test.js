'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildCandidates,
  cluster,
  decodeXml,
  parseRssItems,
  pickRepresentative,
  prepare,
  scorePair,
  validateMode,
} = require('../dedupe');

const fixturePath = path.join(__dirname, 'fixtures', 'handmade.xml');
const item = (title, guid, pubDate = 'Mon, 05 Oct 2026 10:00:00 GMT') => ({
  title,
  guid,
  pubDate,
  link: `https://example.invalid/${guid}`,
  source: '',
});

function clustered(items, mode = 'dice', threshold = 0.8) {
  const docs = items.map(prepare);
  return { docs, result: cluster(docs, { mode, threshold, debug: true }) };
}

test('synthetic RSS fixture parses offline and numeric decimal entities', () => {
  const items = parseRssItems(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(items.length, 2);
  assert.match(items[0].title, /—/);
  assert.equal(items[0].guid, 'fixture-1');
});

test('normalized exact titles always merge', () => {
  const { result } = clustered([
    item('Myanmar’s 2025 election — results - Reuters', 'exact-a'),
    item("MYANMAR'S 2025 ELECTION – RESULTS - AP", 'exact-b'),
  ]);
  assert.equal(result.groups.filter((group) => group.length > 1).length, 1);
  assert.equal(result.edges[0].exact, true);
});

test('fuzzy Dice merge applies the baseline numeric match boost', () => {
  const { docs, result } = clustered([
    item('Myanmar 2025 military attack Rakhine - Reuters', 'dice-a'),
    item('Burma 2025 military strike Rakhine - AP', 'dice-b'),
  ]);
  const scored = scorePair(docs[0], docs[1]);
  assert.equal(scored.rawDice, 0.75);
  assert.ok(Math.abs(scored.adjustedScore - 0.83) < 1e-12);
  assert.equal(result.groups.filter((group) => group.length > 1).length, 1);
  assert.equal(result.diagnostics[0].reason, 'dice_threshold');
});

test('number disagreement retains the baseline penalty', () => {
  const { result } = clustered([
    item('Myanmar 2025 military attack Rakhine - Reuters', 'number-a'),
    item('Burma 2024 military attack Rakhine - AP', 'number-b'),
  ]);
  assert.equal(result.groups.filter((group) => group.length > 1).length, 0);
  assert.equal(result.diagnostics[0].reason, 'adjusted_score_below_threshold');
});

test('length-ratio protection remains active', () => {
  const a = prepare(item('Myanmar 2025 military attack Rakhine update - Reuters', 'length-a'));
  const b = prepare(item('Burma 2025 military attack Rakhine latest regional response village reports humanitarian details - AP', 'length-b'));
  const scored = scorePair(a, b);
  assert.ok(scored.lenRatio < 0.55);
  assert.ok(scored.adjustedScore < 0.8);
  const { result } = clustered([a, b]);
  assert.equal(result.groups.filter((group) => group.length > 1).length, 0);
});

test('the original asymmetric follow-up guard remains active', () => {
  const shared = '2025 military attack rebels northern state reports local officials today';
  const { result } = clustered([
    item(`Myanmar ${shared} casualties update - Reuters`, 'asym-a'),
    item(`Burma ${shared} victims village hospital township - AP`, 'asym-b'),
  ]);
  assert.equal(result.diagnostics[0].reason, 'asymmetric_follow_up_guard');
  assert.equal(result.groups.filter((group) => group.length > 1).length, 0);
});

test('strict-subset protection rejects raw Dice below 0.85 despite adjusted score above 0.80', () => {
  const { docs, result } = clustered([
    item('Myanmar 2025 deaths - Reuters', 'subset-a'),
    item('Burma 2025 deaths Thailand - AP', 'subset-b'),
  ]);
  const scored = scorePair(docs[0], docs[1]);
  assert.equal(scored.rawDice, 0.8);
  assert.ok(scored.adjustedScore > 0.8);
  assert.equal(result.diagnostics[0].reason, 'strict_subset_raw_dice_below_0.85');
  assert.equal(result.groups.filter((group) => group.length > 1).length, 0);
});

test('ordinary cross-media rewrite with unique tokens on both sides still merges below raw Dice 0.85', () => {
  const { docs, result } = clustered([
    item('Myanmar 2025 military attack Rakhine - Reuters', 'rewrite-a'),
    item('Burma 2025 military strike Rakhine - AP', 'rewrite-b'),
  ]);
  assert.ok(scorePair(docs[0], docs[1]).rawDice < 0.85);
  assert.equal(result.groups.filter((group) => group.length > 1).length, 1);
});

test('canonical token signature adds anchor candidates when every token is too common', () => {
  const permutations = [
    'alpha bravo charlie delta',
    'bravo charlie delta alpha',
    'charlie delta alpha bravo',
    'delta alpha bravo charlie',
    'alpha charlie bravo delta',
    'bravo delta charlie alpha',
  ];
  const docs = permutations.map((title, i) => prepare(item(`${title} - Publisher ${i}`, `sig-${i}`)));
  const { pairs } = buildCandidates(docs);
  assert.equal(pairs.size, docs.length - 1);
  assert.ok(pairs.size < docs.length * (docs.length - 1) / 2);
  const result = cluster(docs, { mode: 'dice', threshold: 0.8 });
  assert.equal(result.groups.filter((group) => group.length > 1)[0].length, docs.length);
});

test('empty token sets do not share a fallback signature', () => {
  const { result } = clustered([
    item('Myanmar - Reuters', 'empty-a'),
    item('Burma - AP', 'empty-b'),
  ]);
  assert.equal(result.candidatePairs, 0);
  assert.equal(result.groups.length, 2);
});

test('decimal and hexadecimal numeric XML entities decode once', () => {
  assert.equal(decodeXml('&#8212;'), '—');
  assert.equal(decodeXml('&#x1F1F2;'), '🇲');
  assert.equal(decodeXml('&amp;#65;'), '&#65;');
});

test('invalid XML code points remain visible instead of becoming replacement characters', () => {
  assert.equal(decodeXml('&#xD800;'), '&#xD800;');
  assert.equal(decodeXml('&#0;'), '&#0;');
  assert.equal(decodeXml('&#x110000;'), '&#x110000;');
});

test('exact-only mode merges exact keys and performs no fuzzy scoring', () => {
  const { result } = clustered([
    item('Myanmar 2025 military attack Rakhine - Reuters', 'exact-only-a'),
    item('Myanmar 2025 military attack Rakhine - AP', 'exact-only-b'),
    item('Burma 2025 military strike Rakhine - AP', 'exact-only-c'),
  ], 'exact');
  assert.equal(result.stats.scoredPairs, 0);
  assert.equal(result.stats.clusters, 1);
  assert.equal(result.stats.itemsInClusters, 2);

  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'dedupe.js'), '--handmade'], {
    encoding: 'utf8',
    env: { ...process.env, DEDUPE_MODE: 'exact' },
  });
  assert.equal(cli.status, 0);
  assert.equal(JSON.parse(cli.stdout).mode, 'exact');
});

test('invalid mode fails clearly in the API and CLI', () => {
  assert.throws(() => validateMode('jaccard'), /expected "dice" or "exact"/);
  assert.throws(() => cluster([], { mode: '' }), /expected "dice" or "exact"/);
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'dedupe.js'), '--mode', 'jaccard'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Invalid mode "jaccard"/);
});

test('debug diagnostics do not change cluster results', () => {
  const docs = [
    prepare(item('Myanmar 2025 military attack Rakhine - Reuters', 'debug-a')),
    prepare(item('Burma 2025 military strike Rakhine - AP', 'debug-b')),
  ];
  const plain = cluster(docs, { mode: 'dice', threshold: 0.8 });
  const debug = cluster(docs, { mode: 'dice', threshold: 0.8, debug: true });
  assert.deepEqual(debug.groups, plain.groups);
  assert.deepEqual(debug.edges, plain.edges);
  assert.deepEqual(debug.stats, plain.stats);
  assert.equal(debug.diagnostics[0].rawDice, 0.75);
  assert.equal(debug.diagnostics[0].adjustedScore, 0.83);
  assert.equal(debug.diagnostics[0].decision, 'merge');
});

test('representative selection uses earliest pubDate', () => {
  const docs = [
    prepare(item('Myanmar relief report - Reuters', 'late-guid', 'Mon, 05 Oct 2026 12:00:00 GMT')),
    prepare(item('Myanmar relief report - AP', 'early-guid', 'Mon, 05 Oct 2026 08:00:00 GMT')),
  ];
  assert.equal(pickRepresentative([0, 1], docs).guid, 'early-guid');
});

test('equal pubDate uses deterministic code-point GUID ordering', () => {
  const docs = [
    prepare(item('Myanmar relief report - Reuters', 'a-2')),
    prepare(item('Myanmar relief report - AP', 'a-10')),
  ];
  assert.equal(pickRepresentative([0, 1], docs).guid, 'a-10');
  assert.equal(pickRepresentative([1, 0], docs).guid, 'a-10');
});

test('cluster membership and representatives are stable across input order', () => {
  const source = [
    item('Myanmar 2025 military attack Rakhine - Reuters', 'stable-a', 'Mon, 05 Oct 2026 10:00:00 GMT'),
    item('Burma 2025 military strike Rakhine - AP', 'stable-b', 'Mon, 05 Oct 2026 09:00:00 GMT'),
    item('Nepal 2026 earthquake response - Example', 'stable-c', 'Mon, 05 Oct 2026 08:00:00 GMT'),
  ];
  const snapshot = (items) => {
    const docs = items.map(prepare);
    const groups = cluster(docs, { mode: 'dice', threshold: 0.8 }).groups;
    return groups.map((group) => ({
      members: group.map((i) => docs[i].guid).sort(),
      representative: pickRepresentative(group, docs).guid,
    })).sort((a, b) => a.members[0] < b.members[0] ? -1 : a.members[0] > b.members[0] ? 1 : 0);
  };
  assert.deepEqual(snapshot(source), snapshot([source[2], source[0], source[1]]));
});
