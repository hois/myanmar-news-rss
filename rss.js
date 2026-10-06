#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parseXml } = require('@rgrove/parse-xml');
const { cluster, pickRepresentative, prepare, validateMode } = require('./dedupe');

const GOOGLE_NEWS_URL = 'https://news.google.com/rss/search?hl=en-US&gl=US&q=%28myanmar%7Cburma%29%20when%3A1d&ceid=US%3Aen';
const SOURCE_TIMEOUT_MS = 30_000;
const PUBLISHED_TIMEOUT_MS = 10_000;

const CHANNEL = Object.freeze({
  title: 'Myanmar News (Deduplicated)',
  link: GOOGLE_NEWS_URL,
  description: 'Deduplicated Google News RSS feed for Myanmar and Burma news.',
  language: 'en',
  ttl: '15',
});

function elements(node) {
  return node.children.filter((child) => child.type === 'element');
}

function childrenNamed(node, name) {
  return elements(node).filter((child) => child.name === name);
}

function readScalar(element, field, itemNumber) {
  if (elements(element).length > 0) {
    throw new Error(`item ${itemNumber}: <${field}> must contain text, not child elements`);
  }
  return element.text;
}

function requiredField(itemElement, field, itemNumber) {
  const matches = childrenNamed(itemElement, field);
  if (matches.length !== 1) {
    throw new Error(`item ${itemNumber}: expected exactly one <${field}> element`);
  }
  const value = readScalar(matches[0], field, itemNumber);
  if (!value.trim()) throw new Error(`item ${itemNumber}: <${field}> must not be empty`);
  return value;
}

function optionalField(itemElement, field, itemNumber) {
  const matches = childrenNamed(itemElement, field);
  if (matches.length > 1) {
    throw new Error(`item ${itemNumber}: expected at most one <${field}> element`);
  }
  return matches.length === 0 ? undefined : readScalar(matches[0], field, itemNumber);
}

function requiredChannelField(channel, field) {
  const matches = childrenNamed(channel, field);
  if (matches.length !== 1) {
    throw new Error(`RSS channel: expected exactly one <${field}> element`);
  }
  const value = readScalar(matches[0], field, 'channel');
  if (!value.trim()) throw new Error(`RSS channel: <${field}> must not be empty`);
  return value;
}

function parsePubDate(value, itemNumber) {
  const match = value.trim().match(
    /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2}|\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[+-]\d{4})$/i
  );
  if (!match) {
    throw new Error(`item ${itemNumber}: <pubDate> is not a valid date`);
  }

  const weekday = match[1] && match[1].slice(0, 3).toLowerCase();
  const day = Number(match[2]);
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(match[3].slice(0, 3).toLowerCase());
  let year = Number(match[4]);
  if (match[4].length === 2) year += year < 50 ? 2000 : 1900;
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7] || 0);
  const wallDate = new Date(0);
  wallDate.setUTCFullYear(year, month, day);
  wallDate.setUTCHours(hour, minute, second, 0);
  if (
    day < 1 || wallDate.getUTCFullYear() !== year || wallDate.getUTCMonth() !== month ||
    wallDate.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 ||
    (weekday && ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][wallDate.getUTCDay()] !== weekday.toLowerCase())
  ) {
    throw new Error(`item ${itemNumber}: <pubDate> is not a valid date`);
  }

  const zone = match[8].toUpperCase();
  const offsets = { GMT: 0, UTC: 0, UT: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };
  let offsetMinutes = offsets[zone];
  if (offsetMinutes === undefined) {
    const zoneMatch = zone.match(/^([+-])(\d{2})(\d{2})$/);
    const zoneHours = Number(zoneMatch[2]);
    const zoneMinutes = Number(zoneMatch[3]);
    if (zoneHours > 23 || zoneMinutes > 59) {
      throw new Error(`item ${itemNumber}: <pubDate> is not a valid date`);
    }
    offsetMinutes = (zoneMatch[1] === '+' ? 1 : -1) * (zoneHours * 60 + zoneMinutes);
  }
  return wallDate.getTime() - offsetMinutes * 60_000;
}

/** Parse one strict RSS 2.0 document without applying any second entity decode. */
function parseRss(xml) {
  if (typeof xml !== 'string') throw new TypeError('RSS input must be a string');

  let document;
  try {
    document = parseXml(xml, { preserveDocumentType: true, preserveCdata: true });
  } catch (error) {
    throw new Error(`XML parse failed: ${error.message}`, { cause: error });
  }

  if (document.children.some((child) => child.type === 'doctype')) {
    throw new Error('DOCTYPE is not allowed in RSS input');
  }

  const roots = elements(document);
  if (roots.length !== 1 || roots[0].name !== 'rss') {
    throw new Error('RSS input must have exactly one <rss> root element');
  }
  const root = roots[0];
  if (root.attributes.version !== '2.0') {
    throw new Error('RSS root must declare version="2.0"');
  }

  const rootElements = elements(root);
  if (rootElements.length !== 1 || rootElements[0].name !== 'channel') {
    throw new Error('RSS input must have exactly one <channel> child');
  }
  const channel = rootElements[0];
  for (const field of ['title', 'link', 'description']) requiredChannelField(channel, field);
  const itemElements = childrenNamed(channel, 'item');
  if (itemElements.length === 0) throw new Error('RSS channel must contain at least one <item>');

  const items = itemElements.map((itemElement, index) => {
    const itemNumber = index + 1;
    const guidElement = childrenNamed(itemElement, 'guid');
    if (guidElement.length !== 1) {
      throw new Error(`item ${itemNumber}: expected exactly one <guid> element`);
    }
    const guid = readScalar(guidElement[0], 'guid', itemNumber);
    if (!guid.trim()) throw new Error(`item ${itemNumber}: <guid> must not be empty`);

    let guidIsPermaLink;
    if (Object.prototype.hasOwnProperty.call(guidElement[0].attributes, 'isPermaLink')) {
      const value = guidElement[0].attributes.isPermaLink;
      if (value !== 'true' && value !== 'false') {
        throw new Error(`item ${itemNumber}: guid isPermaLink must be "true" or "false"`);
      }
      guidIsPermaLink = value === 'true';
    }

    const pubDate = requiredField(itemElement, 'pubDate', itemNumber);
    const pubTime = parsePubDate(pubDate, itemNumber);
    const sourceElements = childrenNamed(itemElement, 'source');
    if (sourceElements.length > 1) {
      throw new Error(`item ${itemNumber}: expected at most one <source> element`);
    }

    const item = {
      title: requiredField(itemElement, 'title', itemNumber),
      link: requiredField(itemElement, 'link', itemNumber),
      guid,
      pubDate,
      pubTime,
    };
    if (guidIsPermaLink !== undefined) item.guidIsPermaLink = guidIsPermaLink;

    const description = optionalField(itemElement, 'description', itemNumber);
    if (description !== undefined) item.description = description;
    if (sourceElements.length === 1) {
      item.source = readScalar(sourceElements[0], 'source', itemNumber);
      if (Object.prototype.hasOwnProperty.call(sourceElements[0].attributes, 'url')) {
        item.sourceUrl = sourceElements[0].attributes.url;
      }
    }
    return item;
  });

  return { items, channel };
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateItem(item, index) {
  const number = index + 1;
  for (const field of ['title', 'link', 'guid', 'pubDate']) {
    if (typeof item[field] !== 'string' || !item[field].trim()) {
      throw new Error(`item ${number}: <${field}> must be a non-empty string`);
    }
  }
  const pubTime = parsePubDate(item.pubDate, number);
  if (item.guidIsPermaLink !== undefined && typeof item.guidIsPermaLink !== 'boolean') {
    throw new Error(`item ${number}: guidIsPermaLink must be true, false, or absent`);
  }
  for (const field of ['description', 'source', 'sourceUrl']) {
    if (item[field] !== undefined && typeof item[field] !== 'string') {
      throw new Error(`item ${number}: ${field} must be a string when present`);
    }
  }
  return { ...item, pubTime };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function element(tag, value, indent = '      ', attributes = '') {
  return `${indent}<${tag}${attributes}>${escapeXml(value)}</${tag}>`;
}

function serializeItem(item) {
  const lines = ['    <item>'];
  lines.push(element('title', item.title));
  lines.push(element('link', item.link));
  const guidAttribute = item.guidIsPermaLink === undefined
    ? ''
    : ` isPermaLink="${item.guidIsPermaLink ? 'true' : 'false'}"`;
  lines.push(element('guid', item.guid, '      ', guidAttribute));
  lines.push(element('pubDate', item.pubDate));
  if (item.description !== undefined) lines.push(element('description', item.description));
  if (item.source !== undefined) {
    const sourceAttribute = item.sourceUrl === undefined ? '' : ` url="${escapeXml(item.sourceUrl)}"`;
    lines.push(element('source', item.source, '      ', sourceAttribute));
  }
  lines.push('    </item>');
  return lines.join('\n');
}

function validateOutput(xml, expectedItemCount) {
  const parsed = parseRss(xml);
  if (parsed.items.length !== expectedItemCount) {
    throw new Error(`Output item count mismatch: expected ${expectedItemCount}, found ${parsed.items.length}`);
  }
  for (const field of ['title', 'link', 'description']) {
    if (requiredChannelField(parsed.channel, field) !== CHANNEL[field]) {
      throw new Error(`Output channel <${field}> does not match the V1 feed contract`);
    }
  }
  const guids = new Set();
  for (const item of parsed.items) {
    if (guids.has(item.guid)) throw new Error(`Duplicate output GUID: ${JSON.stringify(item.guid)}`);
    guids.add(item.guid);
  }
  const language = requiredChannelField(parsed.channel, 'language');
  const lastBuildDate = requiredChannelField(parsed.channel, 'lastBuildDate');
  const ttl = requiredChannelField(parsed.channel, 'ttl');
  if (language !== CHANNEL.language || ttl !== CHANNEL.ttl) {
    throw new Error('Output channel language or ttl does not match the V1 feed contract');
  }
  const newestItemTime = parsed.items.reduce(
    (latest, item, index) => Math.max(latest, parsePubDate(item.pubDate, index + 1)),
    -Infinity
  );
  if (parsePubDate(lastBuildDate, 'channel lastBuildDate') !== newestItemTime) {
    throw new Error('Output lastBuildDate must equal the newest output item pubDate');
  }
  return parsed;
}

function buildFeed(rawItems, mode = 'dice') {
  validateMode(mode);
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('At least one RSS item is required');
  }
  const items = rawItems.map(validateItem);
  const docs = items.map(prepare);
  const clustering = cluster(docs, { mode, threshold: 0.8 });
  const { groups } = clustering;
  const representatives = groups.map((group) => pickRepresentative(group, docs));
  const seenGuids = new Set();
  for (const item of representatives) {
    if (seenGuids.has(item.guid)) throw new Error(`Duplicate output GUID: ${JSON.stringify(item.guid)}`);
    seenGuids.add(item.guid);
  }
  representatives.sort((left, right) =>
    (left.pubTime > right.pubTime ? -1 : left.pubTime < right.pubTime ? 1 : 0) ||
    compareStrings(left.guid, right.guid)
  );

  const latestPubTime = representatives.reduce((latest, item) => Math.max(latest, item.pubTime), -Infinity);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    element('title', CHANNEL.title, '    '),
    element('link', CHANNEL.link, '    '),
    element('description', CHANNEL.description, '    '),
    element('language', CHANNEL.language, '    '),
    element('lastBuildDate', new Date(latestPubTime).toUTCString(), '    '),
    element('ttl', CHANNEL.ttl, '    '),
    ...representatives.map(serializeItem),
    '  </channel>',
    '</rss>',
    '',
  ];
  const xml = lines.join('\n');
  validateOutput(xml, representatives.length);
  return {
    xml,
    inputItemCount: rawItems.length,
    outputItemCount: representatives.length,
    candidatePairCount: clustering.candidatePairs,
    clusterCount: groups.length,
    mode,
    sha256: crypto.createHash('sha256').update(xml, 'utf8').digest('hex'),
  };
}

function codedError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function safeErrorMessage(value) {
  return String(value || 'Unknown error').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}

function looksLikeHtml(body) {
  const sample = body.slice(0, 16_384).replace(/^\uFEFF/, '').trimStart();
  return /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(sample) ||
    /<html\b/i.test(sample.slice(0, 2_048));
}

function looksLikeRss(body) {
  return /<rss(?:\s|>)/i.test(body.slice(0, 8_192).replace(/^\uFEFF/, ''));
}

function challengeLike(body) {
  return /captcha|unusual traffic|consent\.google|before you continue to google|verify (?:that )?you are human|automated quer(?:y|ies)|challenge-platform/i.test(body.slice(0, 65_536));
}

async function fetchHttpBytes(url, { timeoutMs, fetchImpl = globalThis.fetch, purpose }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: purpose === 'published'
        ? {
            accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
            'cache-control': 'no-cache, max-age=0',
            pragma: 'no-cache',
          }
        : { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1' },
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw codedError(`${purpose}_timeout`, `${purpose} request timed out after ${timeoutMs} ms`, error);
    }
    throw codedError(`${purpose}_network_error`, `${purpose} request failed`, error);
  }

  const contentType = response.headers.get('content-type') || '';
  if (response.status !== 200) {
    clearTimeout(timer);
    throw codedError(`${purpose}_http_${response.status}`, `${purpose} returned HTTP ${response.status}`);
  }

  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (controller.signal.aborted) {
      throw codedError(`${purpose}_timeout`, `${purpose} response body timed out after ${timeoutMs} ms`);
    }
    return { bytes, contentType, status: response.status };
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith(`${purpose}_`)) throw error;
    if (controller.signal.aborted) {
      throw codedError(`${purpose}_timeout`, `${purpose} response body timed out after ${timeoutMs} ms`, error);
    }
    throw codedError(`${purpose}_read_error`, `${purpose} response body could not be read`, error);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSourceRss(url, { fetchImpl = globalThis.fetch, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  let parsedResponse;
  try {
    parsedResponse = await fetchHttpBytes(url, { timeoutMs, fetchImpl, purpose: 'source' });
  } catch (error) {
    throw error;
  }
  const { bytes, contentType, status } = parsedResponse;
  if (bytes.length === 0 || bytes.toString('utf8').trim() === '') {
    throw codedError('source_empty_body', 'Google News returned an empty body');
  }
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'text/html' || looksLikeHtml(bytes.toString('utf8'))) {
    throw codedError('source_html_response', 'Google News returned an HTML response');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw codedError('source_invalid_encoding', 'Google News response is not valid UTF-8', error);
  }
  if (!looksLikeRss(text) && challengeLike(text)) {
    throw codedError('source_challenge_response', 'Google News returned a challenge or consent response');
  }
  let parsed;
  try {
    parsed = parseRss(text);
  } catch (error) {
    throw codedError('source_invalid_rss', `Google News RSS validation failed: ${safeErrorMessage(error.message)}`, error);
  }
  return { ...parsedResponse, text, parsed, status };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function comparePublishedFeed(outputBytes, publishedUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = PUBLISHED_TIMEOUT_MS,
} = {}) {
  if (publishedUrl === undefined || publishedUrl === null || String(publishedUrl).trim() === '') {
    return { changed: true, status: 'unavailable', reason: 'published_url_not_configured' };
  }
  let url;
  try {
    url = new URL(String(publishedUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported protocol');
  } catch {
    return { changed: true, status: 'unavailable', reason: 'published_url_invalid' };
  }

  try {
    const published = await fetchHttpBytes(url, { timeoutMs, fetchImpl, purpose: 'published' });
    const outputHash = sha256(outputBytes);
    const publishedHash = sha256(published.bytes);
    if (outputHash === publishedHash) {
      return { changed: false, status: 'unchanged', reason: 'sha256_match', publishedStatus: published.status };
    }
    return { changed: true, status: 'changed', reason: 'sha256_mismatch', publishedStatus: published.status };
  } catch (error) {
    return {
      changed: true,
      status: 'unavailable',
      reason: typeof error.code === 'string' && error.code.startsWith('published_')
        ? error.code
        : 'published_hash_error',
    };
  }
}

async function runFetchPipeline(outputPath, mode = 'dice', {
  sourceUrl = GOOGLE_NEWS_URL,
  publishedUrl,
  fetchImpl = globalThis.fetch,
  sourceTimeoutMs = SOURCE_TIMEOUT_MS,
  compareTimeoutMs = PUBLISHED_TIMEOUT_MS,
} = {}) {
  const fetchStart = performance.now();
  const source = await fetchSourceRss(sourceUrl, { fetchImpl, timeoutMs: sourceTimeoutMs });
  const fetchDurationMs = performance.now() - fetchStart;

  const dedupeStart = performance.now();
  const result = buildFeed(source.parsed.items, mode);
  const dedupeDurationMs = performance.now() - dedupeStart;

  const writeStart = performance.now();
  writeFeedAtomic(outputPath, result.xml, result.outputItemCount);
  const outputBytes = fs.readFileSync(path.resolve(outputPath));
  const outputSha256 = sha256(outputBytes);
  const writeDurationMs = performance.now() - writeStart;

  const compareStart = performance.now();
  const comparison = await comparePublishedFeed(outputBytes, publishedUrl, {
    fetchImpl,
    timeoutMs: compareTimeoutMs,
  });
  const compareDurationMs = performance.now() - compareStart;

  return {
    ...result,
    sha256: outputSha256,
    status: source.status,
    contentType: source.contentType,
    bodyBytes: source.bytes.length,
    comparison,
    timings: { fetchDurationMs, dedupeDurationMs, writeDurationMs, compareDurationMs },
  };
}

function writeFeedAtomic(outputPath, xml, expectedItemCount) {
  const destination = path.resolve(outputPath);
  const temporary = `${destination}.tmp`;
  let descriptor;
  let createdTemporary = false;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    createdTemporary = true;
    fs.writeFileSync(descriptor, xml, { encoding: 'utf8' });
    fs.closeSync(descriptor);
    descriptor = undefined;
    validateOutput(fs.readFileSync(temporary, 'utf8'), expectedItemCount);
    fs.renameSync(temporary, destination);
    createdTemporary = false;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (createdTemporary) {
      try { fs.unlinkSync(temporary); } catch {}
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = { mode: 'dice' };
  const seen = new Set();
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--fetch') {
      if (seen.has('fetch')) throw new Error('--fetch may only be specified once');
      seen.add('fetch');
      options.fetch = true;
      continue;
    }
    if (!['--input', '--output', '--mode', '--published-url'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    const key = argument === '--published-url' ? 'publishedUrl' : argument.slice(2);
    if (seen.has(key)) throw new Error(`${argument} may only be specified once`);
    seen.add(key);
    options[key] = value;
  }
  if (Boolean(options.input) === Boolean(options.fetch)) {
    throw new Error('Specify exactly one of --input <file> or --fetch');
  }
  if (!options.output) throw new Error('Missing required --output path');
  if (options.publishedUrl && !options.fetch) {
    throw new Error('--published-url can only be used with --fetch');
  }
  validateMode(options.mode);
  if (options.input && path.resolve(options.input) === path.resolve(options.output)) {
    throw new Error('Input and output paths must be different');
  }
  return options;
}

function formatLogEntries(entries) {
  return Object.entries(entries).map(([key, value]) => `${key}=${value}`).join('\n');
}

function duration(value) {
  return value.toFixed(1);
}

async function main(argv = process.argv, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  sourceUrl = GOOGLE_NEWS_URL,
  sourceTimeoutMs = SOURCE_TIMEOUT_MS,
  compareTimeoutMs = PUBLISHED_TIMEOUT_MS,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`error=${safeErrorMessage(error.message)}`);
    throw error;
  }
  if (options.fetch) {
    let result;
    try {
      result = await runFetchPipeline(options.output, options.mode, {
        sourceUrl,
        publishedUrl: options.publishedUrl === undefined ? env.PAGES_FEED_URL : options.publishedUrl,
        fetchImpl,
        sourceTimeoutMs,
        compareTimeoutMs,
      });
    } catch (error) {
      const reason = typeof error.code === 'string' ? error.code : 'generation_failed';
      if (reason.startsWith('source_')) stderr(formatLogEntries({ fetch_status: 'failed', reason }));
      else stderr(formatLogEntries({ fetch_status: 'success', reason }));
      stderr(`error=${safeErrorMessage(error.message)}`);
      throw error;
    }
    const comparison = result.comparison;
    stdout(formatLogEntries({
      mode: result.mode,
      fetch_status: 'success',
      http_status: result.status,
      content_type: result.contentType.replace(/\s+/g, ''),
      body_bytes: result.bodyBytes,
      input_items: result.inputItemCount,
      candidate_pairs: result.candidatePairCount,
      clusters: result.clusterCount,
      output_items: result.outputItemCount,
      output_sha256: result.sha256,
      published_compare: comparison.status,
      changed: String(comparison.changed),
      reason: comparison.reason,
      timing_fetch_ms: duration(result.timings.fetchDurationMs),
      timing_dedupe_ms: duration(result.timings.dedupeDurationMs),
      timing_write_ms: duration(result.timings.writeDurationMs),
      timing_compare_ms: duration(result.timings.compareDurationMs),
    }));
    return result;
  }

  try {
    const readStart = performance.now();
    const input = fs.readFileSync(options.input, 'utf8');
    const parsed = parseRss(input);
    const fetchDurationMs = performance.now() - readStart;
    const dedupeStart = performance.now();
    const result = buildFeed(parsed.items, options.mode);
    const dedupeDurationMs = performance.now() - dedupeStart;
    const writeStart = performance.now();
    writeFeedAtomic(options.output, result.xml, result.outputItemCount);
    const outputSha256 = sha256(fs.readFileSync(path.resolve(options.output)));
    const writeDurationMs = performance.now() - writeStart;
    stdout(formatLogEntries({
      mode: result.mode,
      fetch_status: 'skipped',
      input_items: result.inputItemCount,
      candidate_pairs: result.candidatePairCount,
      clusters: result.clusterCount,
      output_items: result.outputItemCount,
      output_sha256: outputSha256,
      published_compare: 'skipped',
      changed: 'not_applicable',
      reason: 'offline_input_mode',
      timing_fetch_ms: duration(fetchDurationMs),
      timing_dedupe_ms: duration(dedupeDurationMs),
      timing_write_ms: duration(writeDurationMs),
    }));
    return result;
  } catch (error) {
    stderr(`error=${safeErrorMessage(error.message)}`);
    throw error;
  }
}

module.exports = {
  buildFeed,
  comparePublishedFeed,
  escapeXml,
  fetchSourceRss,
  GOOGLE_NEWS_URL,
  main,
  parseRss,
  parseArgs,
  runFetchPipeline,
  validateOutput,
  writeFeedAtomic,
};

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
