'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildFeed, parseRss, validateOutput, writeFeedAtomic } = require('../rss');

const DEFAULT_ITEM = {
  title: 'Myanmar relief update - Example News',
  link: 'https://example.invalid/story/1',
  guid: 'story-1',
  pubDate: 'Mon, 05 Oct 2026 10:00:00 GMT',
};

function xmlItem(overrides = {}) {
  const fields = { ...DEFAULT_ITEM, ...overrides };
  const lines = ['<item>'];
  for (const field of ['title', 'link']) {
    if (fields[field] !== null) lines.push(`<${field}>${fields[field]}</${field}>`);
  }
  if (fields.guid !== null) {
    const attr = fields.guidIsPermaLink === undefined
      ? ''
      : ` isPermaLink="${fields.guidIsPermaLink}"`;
    lines.push(`<guid${attr}>${fields.guid}</guid>`);
  }
  if (fields.pubDate !== null) lines.push(`<pubDate>${fields.pubDate}</pubDate>`);
  if (fields.description !== undefined && fields.description !== null) {
    lines.push(`<description>${fields.description}</description>`);
  }
  if (fields.source !== undefined && fields.source !== null) {
    const attr = fields.sourceUrl === undefined ? '' : ` url="${fields.sourceUrl}"`;
    lines.push(`<source${attr}>${fields.source}</source>`);
  }
  lines.push('</item>');
  return lines.join('');
}

function rss(...items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test feed</title><link>https://example.invalid/</link><description>Synthetic test feed</description>${items.join('')}</channel></rss>`;
}

test('strict parser accepts one RSS 2.0 channel and preserves required item fields', () => {
  const parsed = parseRss(rss(xmlItem({ guidIsPermaLink: 'false', source: 'Example' })));
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, DEFAULT_ITEM.title);
  assert.equal(parsed.items[0].link, DEFAULT_ITEM.link);
  assert.equal(parsed.items[0].guid, DEFAULT_ITEM.guid);
  assert.equal(parsed.items[0].guidIsPermaLink, false);
  assert.equal(parsed.items[0].pubDate, DEFAULT_ITEM.pubDate);
  assert.equal(parsed.items[0].source, 'Example');
});

test('malformed XML fails', () => {
  assert.throws(() => parseRss('<rss version="2.0"><channel><item>'), /XML parse failed/);
});

test('non-RSS XML fails', () => {
  assert.throws(() => parseRss('<feed><item/></feed>'), /<rss> root/);
});

test('multiple document roots fail', () => {
  assert.throws(() => parseRss('<rss version="2.0"/><rss version="2.0"/>'), /XML parse failed/);
});

test('DOCTYPE is rejected, including custom entity declarations', () => {
  assert.throws(() => parseRss('<!DOCTYPE rss><rss version="2.0"><channel/></rss>'), /DOCTYPE is not allowed/);
  assert.throws(() => parseRss('<!DOCTYPE rss [<!ENTITY x "value">]><rss version="2.0"><channel>&x;</channel></rss>'));
  assert.throws(() => parseRss(rss(xmlItem({ title: 'Unknown &custom; entity' }))), /XML parse failed/);
});

test('RSS 2.0 input requires one rss root and one channel', () => {
  assert.throws(() => parseRss('<rss version="1.0"><channel/></rss>'), /version="2.0"/);
  assert.throws(() => parseRss('<rss version="2.0"><channel/><channel/></rss>'), /exactly one <channel>/);
});

test('RSS 2.0 channel requires title, link, and description', () => {
  assert.throws(
    () => parseRss('<rss version="2.0"><channel><item/></channel></rss>'),
    /RSS channel: expected exactly one <title>/
  );
});

test('zero-item RSS fails', () => {
  assert.throws(() => parseRss(rss()), /at least one <item>/);
});

for (const field of ['title', 'link', 'guid', 'pubDate']) {
  test(`missing ${field} fails the entire parse`, () => {
    assert.throws(() => parseRss(rss(xmlItem({ [field]: null }))), new RegExp(`<${field}>`));
  });
}

test('invalid pubDate fails', () => {
  assert.throws(() => parseRss(rss(xmlItem({ pubDate: 'not a date' }))), /valid date/);
  assert.throws(() => parseRss(rss(xmlItem({ pubDate: 'October 5, 2026' }))), /valid date/);
  assert.throws(() => parseRss(rss(xmlItem({ pubDate: 'Mon, 31 Feb 2026 10:00:00 GMT' }))), /valid date/);
});

test('description may be absent', () => {
  assert.equal(parseRss(rss(xmlItem())).items[0].description, undefined);
});

test('source may be absent', () => {
  assert.equal(parseRss(rss(xmlItem())).items[0].source, undefined);
});

test('source URL may be absent while source text is retained', () => {
  const item = parseRss(rss(xmlItem({ source: 'Example &amp; Co' }))).items[0];
  assert.equal(item.source, 'Example & Co');
  assert.equal(item.sourceUrl, undefined);
});

test('a non-standard-looking source URL is retained without rejecting the item', () => {
  const input = parseRss(rss(xmlItem({ source: 'Example', sourceUrl: 'relative path &amp; not a URL' }))).items;
  const output = parseRss(buildFeed(input, 'exact').xml).items[0];
  assert.equal(output.sourceUrl, 'relative path & not a URL');
});

test('guid isPermaLink preserves its missing state', () => {
  const item = parseRss(rss(xmlItem())).items[0];
  assert.equal(Object.hasOwn(item, 'guidIsPermaLink'), false);
});

test('guid isPermaLink=true is retained', () => {
  assert.equal(parseRss(rss(xmlItem({ guidIsPermaLink: 'true' }))).items[0].guidIsPermaLink, true);
});

test('guid isPermaLink=false is retained', () => {
  assert.equal(parseRss(rss(xmlItem({ guidIsPermaLink: 'false' }))).items[0].guidIsPermaLink, false);
});

test('writer preserves missing, true, and false guid isPermaLink states', () => {
  const built = buildFeed([
    { ...DEFAULT_ITEM, title: 'Myanmar election polling schedule', guid: 'perma-true', guidIsPermaLink: true },
    { ...DEFAULT_ITEM, title: 'Thailand earthquake rescue report', guid: 'perma-false', guidIsPermaLink: false },
    { ...DEFAULT_ITEM, title: 'India monsoon flood damage', guid: 'perma-missing' },
  ], 'exact');
  const items = parseRss(built.xml).items;
  const byGuid = new Map(items.map((item) => [item.guid, item]));
  assert.equal(byGuid.get('perma-true').guidIsPermaLink, true);
  assert.equal(byGuid.get('perma-false').guidIsPermaLink, false);
  assert.equal(Object.hasOwn(byGuid.get('perma-missing'), 'guidIsPermaLink'), false);
});

test('decimal and hexadecimal XML entities are decoded once by the parser', () => {
  const item = parseRss(rss(xmlItem({ title: 'Myanmar &#8212; &#x1F1F2; &amp; &amp;quot;' }))).items[0];
  assert.equal(item.title, 'Myanmar — 🇲 & &quot;');
  const literalNumericReference = parseRss(rss(xmlItem({ title: 'Headline &amp;#39; text' }))).items;
  const written = buildFeed(literalNumericReference, 'exact');
  assert.equal(parseRss(written.xml).items[0].title, 'Headline &#39; text');
});

test('CDATA content is preserved as text', () => {
  const item = parseRss(rss(xmlItem({ title: '<![CDATA[Myanmar relief — update]]>' }))).items[0];
  assert.equal(item.title, 'Myanmar relief — update');
});

test('description HTML remains text and is escaped in output XML', () => {
  const description = '<![CDATA[<p>R&D reports <strong>new & unusual</strong>.</p>]]>';
  const built = buildFeed(parseRss(rss(xmlItem({ description }))).items, 'exact');
  assert.match(built.xml, /&lt;p&gt;R&amp;D reports &lt;strong&gt;new &amp; unusual&lt;\/strong&gt;\.&lt;\/p&gt;/);
  assert.equal(parseRss(built.xml).items[0].description, '<p>R&D reports <strong>new & unusual</strong>.</p>');
});

test('writer escapes XML metacharacters in text and attributes', () => {
  const input = rss(xmlItem({
    title: 'Myanmar &amp; neighbors &lt;update&gt; "today"',
    link: 'https://example.invalid/?a=1&amp;b=2&amp;label=&quot;x&quot;',
    description: 'Fish &amp; chips &lt;today&gt; "yes" &#39;ok&#39;',
    source: 'A &amp; B',
    sourceUrl: 'https://example.invalid/?x=1&amp;y=2&amp;q=&quot;z&quot;&amp;apostrophe=&apos;s&apos;',
  }));
  const parsed = parseRss(input);
  const built = buildFeed(parsed.items, 'exact');
  assert.match(built.xml, /<title>Myanmar &amp; neighbors &lt;update&gt; &quot;today&quot;<\/title>/);
  assert.match(built.xml, /url="https:\/\/example\.invalid\/\?x=1&amp;y=2&amp;q=&quot;z&quot;&amp;apostrophe=&apos;s&apos;"/);
  const roundTrip = parseRss(built.xml).items[0];
  assert.equal(roundTrip.title, parsed.items[0].title);
  assert.equal(roundTrip.description, parsed.items[0].description);
  assert.equal(roundTrip.sourceUrl, parsed.items[0].sourceUrl);
});

test('duplicate GUIDs among output representatives fail clearly', () => {
  const first = { ...DEFAULT_ITEM, title: 'Myanmar election commission reports new ballot rules - One' };
  const second = { ...DEFAULT_ITEM, title: 'Thailand earthquake rescue teams reach mountain villages - Two' };
  assert.throws(() => buildFeed([{ ...first }, { ...second }], 'exact'), /Duplicate output GUID/);
});

test('output order is pubDate descending, then GUID ascending by code point', () => {
  const items = [
    { ...DEFAULT_ITEM, title: 'Older unrelated story', guid: 'z-old', pubDate: 'Mon, 05 Oct 2026 09:00:00 GMT' },
    { ...DEFAULT_ITEM, title: 'Same time story beta', guid: 'a-2' },
    { ...DEFAULT_ITEM, title: 'Same time story alpha', guid: 'a-10' },
  ];
  const parsed = parseRss(buildFeed(items, 'exact').xml);
  assert.deepEqual(parsed.items.map((item) => item.guid), ['a-10', 'a-2', 'z-old']);
});

test('same input and mode produce byte-identical XML and SHA-256', () => {
  const input = parseRss(rss(
    xmlItem({ guid: 'det-b', title: 'Myanmar 2025 military strike Rakhine - AP', pubDate: 'Mon, 05 Oct 2026 09:00:00 GMT' }),
    xmlItem({ guid: 'det-a', title: 'Myanmar 2025 military attack Rakhine - Reuters', pubDate: 'Mon, 05 Oct 2026 10:00:00 GMT' }),
  )).items;
  const first = buildFeed(input, 'dice');
  const second = buildFeed(input, 'dice');
  assert.equal(first.xml, second.xml);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sha256, crypto.createHash('sha256').update(first.xml, 'utf8').digest('hex'));
});

test('dice and exact modes both produce valid RSS and retain their clustering difference', () => {
  const input = [
    { ...DEFAULT_ITEM, title: 'Myanmar 2025 military attack Rakhine - Reuters', guid: 'mode-a' },
    { ...DEFAULT_ITEM, title: 'Burma 2025 military strike Rakhine - AP', guid: 'mode-b' },
  ];
  const dice = buildFeed(input, 'dice');
  const exact = buildFeed(input, 'exact');
  assert.equal(validateOutput(dice.xml, dice.outputItemCount).items.length, 1);
  assert.equal(validateOutput(exact.xml, exact.outputItemCount).items.length, 2);
  assert.equal(dice.mode, 'dice');
  assert.equal(exact.mode, 'exact');
});

test('invalid CLI mode exits non-zero', () => {
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'rss.js'),
    '--input', path.join(__dirname, 'fixtures', 'handmade.xml'),
    '--output', path.join(os.tmpdir(), `invalid-mode-${process.pid}.xml`),
    '--mode', 'jaccard',
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /expected "dice" or "exact"/);
});

test('channel lastBuildDate is the newest output pubDate and ttl is 15 minutes', () => {
  const built = buildFeed([
    { ...DEFAULT_ITEM, title: 'Old independent report', guid: 'old', pubDate: 'Mon, 05 Oct 2026 08:00:00 GMT' },
    { ...DEFAULT_ITEM, title: 'New independent report', guid: 'new', pubDate: 'Mon, 05 Oct 2026 11:00:00 GMT' },
  ], 'exact');
  assert.match(built.xml, /<lastBuildDate>Mon, 05 Oct 2026 11:00:00 GMT<\/lastBuildDate>/);
  assert.match(built.xml, /<ttl>15<\/ttl>/);
  const outputItems = parseRss(built.xml).items;
  const lastBuildDate = /<lastBuildDate>([^<]+)<\/lastBuildDate>/.exec(built.xml)[1];
  const maximumPubDate = Math.max(...outputItems.map((item) => Date.parse(item.pubDate)));
  assert.equal(Date.parse(lastBuildDate), maximumPubDate);
  assert.equal(lastBuildDate, new Date(maximumPubDate).toUTCString());
  assert.match(lastBuildDate, / GMT$/);
});

test('representative item keeps its original pubDate value', () => {
  const representativeDate = 'Mon, 05 Oct 2026 08:00:00 GMT';
  const built = buildFeed([
    { ...DEFAULT_ITEM, title: 'Myanmar relief report - Reuters', guid: 'early-rep', pubDate: representativeDate },
    { ...DEFAULT_ITEM, title: 'Myanmar relief report - AP', guid: 'late-rep', pubDate: 'Mon, 05 Oct 2026 09:00:00 GMT' },
  ], 'exact');
  const outputItem = parseRss(built.xml).items[0];
  assert.equal(outputItem.guid, 'early-rep');
  assert.equal(outputItem.pubDate, representativeDate);
});

test('atomic validation failure does not replace an existing feed and removes its temporary file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myanmar-news-rss-'));
  const outputPath = path.join(directory, 'feed.xml');
  const temporaryPath = `${outputPath}.tmp`;
  t.after(() => {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    fs.rmdirSync(directory);
  });
  fs.writeFileSync(outputPath, 'existing feed stays intact', 'utf8');
  assert.throws(() => writeFeedAtomic(outputPath, '<rss version="2.0"><channel></rss>', 1));
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'existing feed stays intact');
  assert.equal(fs.existsSync(temporaryPath), false);
});

test('successful output passes the round-trip RSS parser and item count check', () => {
  const built = buildFeed([{ ...DEFAULT_ITEM, description: 'A & B < C' }], 'exact');
  const parsed = validateOutput(built.xml, built.outputItemCount);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].description, 'A & B < C');
});

test('atomic writer creates a missing parent directory and writes a strictly valid feed', (t) => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.missing-parent-'));
  const outputDirectory = path.join(directory, 'dist');
  const outputPath = path.join(outputDirectory, 'feed.xml');
  t.after(() => {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (fs.existsSync(outputDirectory)) fs.rmdirSync(outputDirectory);
    fs.rmdirSync(directory);
  });

  const built = buildFeed([{ ...DEFAULT_ITEM, description: 'A & B < C' }], 'dice');
  assert.equal(fs.existsSync(outputDirectory), false);

  writeFeedAtomic(outputPath, built.xml, built.outputItemCount);

  assert.deepEqual(fs.readdirSync(outputDirectory), ['feed.xml']);
  const parsed = validateOutput(fs.readFileSync(outputPath, 'utf8'), built.outputItemCount);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].description, 'A & B < C');
});
