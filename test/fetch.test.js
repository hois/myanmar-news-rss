'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildFeed,
  comparePublishedFeed,
  fetchSourceRss,
  GOOGLE_NEWS_URL,
  main,
  parseRss,
  runFetchPipeline,
} = require('../rss');

const MODULE_PATH = path.join(__dirname, '..', 'rss.js');
const DEFAULT_DATE = 'Mon, 05 Oct 2026 10:00:00 GMT';
const registeredResponses = new Map();
let responseNumber = 0;

globalThis.fetch = async (url, options = {}) => {
  const handler = registeredResponses.get(String(url));
  if (!handler) throw new TypeError(`No local test response is registered for ${url}`);

  let status = 200;
  let headers = {};
  const chunks = [];
  let headersSent = false;
  let resolveResponse;
  let rejectResponse;
  let resolveBody;
  let rejectBody;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const bodyPromise = new Promise((resolve, reject) => {
    resolveBody = resolve;
    rejectBody = reject;
  });
  const sendHeaders = () => {
    if (headersSent) return;
    headersSent = true;
    resolveResponse({
      status,
      headers: new Headers(headers),
      arrayBuffer: () => bodyPromise.then((body) => {
        const copy = Uint8Array.from(body);
        return copy.buffer;
      }),
    });
  };
  const response = {
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = nextHeaders;
      return this;
    },
    flushHeaders: sendHeaders,
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      sendHeaders();
      return true;
    },
    end(chunk = undefined) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      sendHeaders();
      resolveBody(Buffer.concat(chunks));
    },
  };
  const signal = options.signal;
  const abort = () => {
    const error = new DOMException('The operation was aborted', 'AbortError');
    if (headersSent) rejectBody(error);
    else rejectResponse(error);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    await handler({ url: String(url), headers: options.headers || {} }, response);
  } catch (error) {
    if (headersSent) rejectBody(error);
    else rejectResponse(error);
  }
  return responsePromise;
};

function item(index, overrides = {}) {
  return {
    title: `Myanmar unique report ${index} - Example News`,
    link: `https://example.invalid/story/${index}`,
    guid: `story-${index}`,
    pubDate: DEFAULT_DATE,
    ...overrides,
  };
}

function xmlItem(fields) {
  return `<item><title>${fields.title}</title><link>${fields.link}</link><guid>${fields.guid}</guid><pubDate>${fields.pubDate}</pubDate></item>`;
}

function feedXml(items = [item(1)]) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google News</title><link>https://news.google.com/</link><description>Myanmar news</description>${items.map(xmlItem).join('')}</channel></rss>`;
}

async function startServer(t, handler) {
  const url = `http://local.test/${++responseNumber}`;
  registeredResponses.set(url, handler);
  t.after(() => registeredResponses.delete(url));
  return url;
}

function respond(response, status, body = '', contentType = 'application/rss+xml; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}

function temporaryOutput(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.phase3-'));
  t.after(() => {
    const output = path.join(directory, 'feed.xml');
    const temporary = `${output}.tmp`;
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.rmdirSync(directory);
  });
  return path.join(directory, 'feed.xml');
}

async function captureMain(argv, dependencies) {
  const stdout = [];
  const stderr = [];
  const result = await main(argv, {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    ...dependencies,
  });
  return { result, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function runChildMain(argv, dependencies = {}) {
  const script = [
    `globalThis.fetch = async () => new Response(${JSON.stringify(dependencies.body || '')}, { status: ${dependencies.status || 429}, headers: { 'content-type': 'text/plain' } });`,
    `const { main } = require(${JSON.stringify(MODULE_PATH)});`,
    `main(${JSON.stringify(argv)}, { stdout: console.log, stderr: console.error }).catch(() => { process.exitCode = 1; });`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('fixed Google News query keeps the V1 search semantics', () => {
  assert.equal(
    GOOGLE_NEWS_URL,
    'https://news.google.com/rss/search?hl=en-US&gl=US&q=%28myanmar%7Cburma%29%20when%3A1d&ceid=US%3Aen'
  );
  const channel = parseRss(buildFeed([item(1)], 'exact').xml).channel;
  assert.equal(channel.children.find((child) => child.type === 'element' && child.name === 'link').text, GOOGLE_NEWS_URL);
});

test('Google-like RSS 200 response parses and records status, type, and body size', async (t) => {
  const xml = feedXml([item(1), item(2)]);
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, xml));
  const result = await fetchSourceRss(sourceUrl);
  assert.equal(result.status, 200);
  assert.match(result.contentType, /application\/rss\+xml/);
  assert.equal(result.bytes.length, Buffer.byteLength(xml));
  assert.equal(result.parsed.items.length, 2);
});

for (const status of [429, 500]) {
  test(`Google source HTTP ${status} fails strictly`, async (t) => {
    const sourceUrl = await startServer(t, (_request, response) => respond(response, status, 'unavailable'));
    await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === `source_http_${status}`);
  });
}

test('source timeout also covers a response body that stalls after headers', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/rss+xml' });
    response.write('<?xml version="1.0"?><rss version="2.0">');
    setTimeout(() => response.end('<channel/>'), 250);
  });
  await assert.rejects(
    fetchSourceRss(sourceUrl, { timeoutMs: 40 }),
    (error) => error.code === 'source_timeout'
  );
});

test('source network failure is reported without retry', async (t) => {
  const fetchImpl = async () => { throw new TypeError('synthetic network failure'); };
  await assert.rejects(fetchSourceRss('http://unreachable.invalid', { fetchImpl }), (error) => error.code === 'source_network_error');
});

test('empty source body fails', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, ''));
  await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_empty_body');
});

test('text/html source response fails by content type', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, '<p>blocked</p>', 'text/html'));
  await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_html_response');
});

test('HTML body fails even when Content-Type claims XML', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, '<!doctype html><html><body>denied</body></html>'));
  await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_html_response');
});

test('captcha and challenge response fails without logging its body', async (t) => {
  const challenge = '<html><body>captcha: verify that you are human</body></html>';
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, challenge));
  await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_html_response');
});

test('plain-text challenge-like response is rejected', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, 'Before you continue to Google, verify that you are human'));
  await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_challenge_response');
});

for (const [name, xml] of [
  ['malformed XML', '<rss version="2.0"><channel><item></rss>'],
  ['truncated XML', '<rss version="2.0"><channel><item><title>unfinished'],
]) {
  test(`${name} source fails strictly`, async (t) => {
    const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, xml));
    await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_invalid_rss');
  });
}

test('well-formed XML that is not RSS fails', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, '<feed><entry/></feed>'));
  await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_invalid_rss');
});

test('RSS with zero items fails', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml([])));
  await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_invalid_rss');
});

test('one RSS item missing a required field fails the entire source', async (t) => {
  const badItem = '<item><title>Myanmar report</title><link>https://example.invalid/a</link><guid>missing-date</guid></item>';
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml([]).replace('</channel>', `${badItem}</channel>`)));
  await assert.rejects(fetchSourceRss(sourceUrl), (error) => error.code === 'source_invalid_rss');
});

test('more than 100 valid items all reach output without truncation', async (t) => {
  const inputItems = Array.from({ length: 137 }, (_value, index) => item(index));
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml(inputItems)));
  const result = await runFetchPipeline(temporaryOutput(t), 'exact', { sourceUrl });
  assert.equal(result.inputItemCount, 137);
  assert.equal(result.outputItemCount, 137);
});

for (const mode of ['dice', 'exact']) {
  test(`production fetch pipeline generates a ${mode} feed`, async (t) => {
    const xml = feedXml([
      item(1, { title: 'Myanmar 2025 military attack Rakhine - Reuters' }),
      item(2, { title: 'Burma 2025 military strike Rakhine - AP' }),
    ]);
    const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, xml));
    const outputPath = temporaryOutput(t);
    const result = await runFetchPipeline(outputPath, mode, { sourceUrl });
    assert.equal(result.mode, mode);
    assert.equal(result.inputItemCount, 2);
    assert.equal(result.outputItemCount, mode === 'dice' ? 1 : 2);
    assert.equal(parseRss(fs.readFileSync(outputPath, 'utf8')).items.length, result.outputItemCount);
  });
}

test('same published bytes produce changed=false and sha256_match', async (t) => {
  const sourceXml = feedXml();
  const expected = buildFeed(parseRss(sourceXml).items, 'exact').xml;
  const publishedUrl = await startServer(t, (_request, response) => respond(response, 200, expected));
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, sourceXml));
  const result = await runFetchPipeline(temporaryOutput(t), 'exact', { sourceUrl, publishedUrl });
  assert.equal(result.comparison.changed, false);
  assert.equal(result.comparison.reason, 'sha256_match');
  assert.equal(result.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
});

test('different published bytes produce changed=true and sha256_mismatch', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml()));
  const publishedUrl = await startServer(t, (_request, response) => respond(response, 200, 'different bytes'));
  const result = await runFetchPipeline(temporaryOutput(t), 'exact', { sourceUrl, publishedUrl });
  assert.equal(result.comparison.changed, true);
  assert.equal(result.comparison.reason, 'sha256_mismatch');
});

for (const status of [404, 500]) {
  test(`published HTTP ${status} is changed=true and does not fail generation`, async (t) => {
    const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml()));
    const publishedUrl = await startServer(t, (_request, response) => respond(response, status, 'unavailable'));
    const outputPath = temporaryOutput(t);
    const result = await runFetchPipeline(outputPath, 'exact', { sourceUrl, publishedUrl });
    assert.equal(result.comparison.changed, true);
    assert.equal(result.comparison.reason, `published_http_${status}`);
    assert.equal(parseRss(fs.readFileSync(outputPath, 'utf8')).items.length, 1);
  });
}

test('published compare timeout becomes changed=true and generation succeeds', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml()));
  const publishedUrl = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/rss+xml' });
    response.write('<rss');
    setTimeout(() => response.end('/>'), 250);
  });
  const outputPath = temporaryOutput(t);
  const result = await runFetchPipeline(outputPath, 'exact', {
    sourceUrl,
    publishedUrl,
    compareTimeoutMs: 40,
  });
  assert.equal(result.comparison.changed, true);
  assert.equal(result.comparison.reason, 'published_timeout');
  assert.equal(parseRss(fs.readFileSync(outputPath, 'utf8')).items.length, 1);
});

test('published network error becomes changed=true', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml()));
  const fetchImpl = async (url, options) => {
    if (String(url) === sourceUrl) return globalThis.fetch(url, options);
    throw new TypeError('synthetic network failure');
  };
  const result = await runFetchPipeline(temporaryOutput(t), 'exact', {
    sourceUrl,
    publishedUrl: 'https://unreachable.invalid/feed.xml',
    fetchImpl,
  });
  assert.equal(result.comparison.changed, true);
  assert.equal(result.comparison.reason, 'published_network_error');
});

test('missing PAGES_FEED_URL produces the required changed result', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml()));
  const result = await runFetchPipeline(temporaryOutput(t), 'exact', { sourceUrl });
  assert.equal(result.comparison.changed, true);
  assert.equal(result.comparison.reason, 'published_url_not_configured');
});

test('CLI --published-url overrides PAGES_FEED_URL and emits stable key=value fields', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml()));
  const expected = buildFeed(parseRss(feedXml()).items, 'exact').xml;
  let envRequests = 0;
  const envUrl = await startServer(t, (_request, response) => {
    envRequests++;
    respond(response, 200, 'environment feed bytes');
  });
  let overrideRequests = 0;
  const overrideUrl = await startServer(t, (_request, response) => {
    overrideRequests++;
    respond(response, 200, expected);
  });
  const outputPath = temporaryOutput(t);
  const captured = await captureMain([
    'node', 'rss.js', '--fetch', '--output', outputPath, '--mode', 'exact', '--published-url', overrideUrl,
  ], { sourceUrl, env: { PAGES_FEED_URL: envUrl } });
  assert.equal(captured.result.comparison.changed, false);
  assert.equal(envRequests, 0);
  assert.equal(overrideRequests, 1);
  for (const line of [
    'mode=exact', 'fetch_status=success', 'input_items=1', 'candidate_pairs=0',
    'clusters=1', 'output_items=1', `output_sha256=${captured.result.sha256}`,
    'published_compare=unchanged', 'changed=false', 'reason=sha256_match',
  ]) assert.ok(captured.stdout.includes(line), `missing stable log: ${line}`);
});

test('PAGES_FEED_URL is used when the CLI override is absent', async (t) => {
  const sourceXml = feedXml();
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, sourceXml));
  const expected = buildFeed(parseRss(sourceXml).items, 'exact').xml;
  let publishedRequests = 0;
  const publishedUrl = await startServer(t, (_request, response) => {
    publishedRequests++;
    respond(response, 200, expected);
  });
  const outputPath = temporaryOutput(t);
  const captured = await captureMain(['node', 'rss.js', '--fetch', '--output', outputPath, '--mode', 'exact'], {
    sourceUrl,
    env: { PAGES_FEED_URL: publishedUrl },
  });
  assert.equal(captured.result.comparison.changed, false);
  assert.equal(publishedRequests, 1);
});

test('new-feed validation failure cannot be swallowed by compare tolerance', async (t) => {
  const duplicateGuidXml = feedXml([
    item(1, { title: 'Independent Myanmar report A', guid: 'duplicate-guid' }),
    item(2, { title: 'Independent Thailand report B', guid: 'duplicate-guid' }),
  ]);
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, duplicateGuidXml));
  let compareRequests = 0;
  const publishedUrl = await startServer(t, (_request, response) => {
    compareRequests++;
    respond(response, 500, 'error');
  });
  const outputPath = temporaryOutput(t);
  fs.writeFileSync(outputPath, 'last known good');
  await assert.rejects(runFetchPipeline(outputPath, 'exact', { sourceUrl, publishedUrl }), /Duplicate output GUID/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'last known good');
  assert.equal(compareRequests, 0);
});

test('source fetch failure exits non-zero and preserves an existing feed', async (t) => {
  const outputPath = temporaryOutput(t);
  fs.writeFileSync(outputPath, 'last known good');
  const child = await runChildMain([
    'node', 'rss.js', '--fetch', '--output', outputPath, '--mode', 'dice',
  ], { status: 429, body: 'rate limited' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /fetch_status=failed\nreason=source_http_429/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'last known good');
});

test('compare failure keeps the successfully written new feed', async (t) => {
  const sourceUrl = await startServer(t, (_request, response) => respond(response, 200, feedXml()));
  const publishedUrl = await startServer(t, (_request, response) => respond(response, 500, 'unavailable'));
  const outputPath = temporaryOutput(t);
  fs.writeFileSync(outputPath, 'old feed');
  const result = await runFetchPipeline(outputPath, 'exact', { sourceUrl, publishedUrl });
  assert.equal(result.comparison.changed, true);
  assert.equal(result.comparison.reason, 'published_http_500');
  assert.equal(parseRss(fs.readFileSync(outputPath, 'utf8')).items.length, 1);
});

test('offline --input mode remains available and rejects invalid modes', async (t) => {
  const outputPath = temporaryOutput(t);
  const fixture = path.join(__dirname, 'fixtures', 'handmade.xml');
  const captured = await captureMain(['node', 'rss.js', '--input', fixture, '--output', outputPath, '--mode', 'exact']);
  assert.equal(captured.result.mode, 'exact');
  assert.equal(captured.result.inputItemCount, 2);
  assert.match(captured.stdout, /fetch_status=skipped/);
  assert.match(captured.stdout, /changed=not_applicable/);
  await assert.rejects(main(['node', 'rss.js', '--input', fixture, '--output', outputPath, '--mode', 'invalid'], {
    stdout() {}, stderr() {},
  }), /expected "dice" or "exact"/);
});
