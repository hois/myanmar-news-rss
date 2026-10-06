# Myanmar News RSS

This project builds a deduplicated RSS feed from the fixed Google News query `(myanmar|burma) when:1d` (`hl=en-US`, `gl=US`, `ceid=US:en`).

V1 uses token Dice for fuzzy matching, with a default adjusted-score threshold of 0.80. `dice` mode applies the Phase 1 fuzzy matching rules; `exact` mode merges exact normalized headlines only. Within each cluster, the representative is chosen by earliest `pubDate`, then GUID.

The CLI supports offline input files and production Google News fetching. Both paths strictly validate RSS items and write a deterministic RSS 2.0 feed atomically.

## Local use

Install the pinned dependency and run the offline tests:

```sh
npm ci
npm test
```

Build `feed.xml` from a local RSS file without network access:

```sh
node rss.js --input test/fixtures/handmade.xml --output feed.xml --mode dice
```

The production fetch uses Node's built-in `fetch`, has a 30-second timeout covering both response headers and body reading, and does not retry. It requires HTTP 200, a non-empty RSS 2.0 document, and valid required fields on every item. HTTP errors, timeouts, network errors, HTML or challenge pages, malformed/non-RSS XML, zero-item feeds, and invalid items exit non-zero. A failed generation leaves an existing `feed.xml` intact.

Fetch Google News and write the production feed:

```sh
node rss.js --fetch --output feed.xml --mode dice
```

Use `--mode exact` to merge exact normalized headlines only. The CLI defaults to `dice` if `--mode` is omitted. `--input <file>` remains the offline mode and cannot be combined with `--fetch`.

After a validated feed is written, the CLI compares its final bytes with the published feed using SHA-256. Configure the current published URL with `PAGES_FEED_URL`, or pass `--published-url <url>` to override the environment value for this run. The comparison has a 10-second timeout and sends no-cache/revalidation request headers. Comparison errors—including an unset URL, HTTP errors, timeouts, and network failures—are non-fatal and report `changed=true`; the reason is included in the machine-readable output. Identical bytes report `changed=false` with `reason=sha256_match`. Output includes stable `key=value` fields such as `changed`, `reason`, `output_sha256`, item counts, candidate pair/cluster counts, and stage timings.

The output channel has a fixed title, the stable Myanmar/Burma Google News search URL, English language, and `ttl` of 15 minutes. The TTL is a feed hint; it does not guarantee that a reader fetches the feed every 15 minutes. `lastBuildDate` is the newest selected item `pubDate`, so rerunning an unchanged input does not add a runtime timestamp. Items are ordered by `pubDate` descending and then GUID ascending. The writer preserves item title, link, GUID and its `isPermaLink` state, `pubDate`, and optional description/source/source URL, with XML escaping and output round-trip validation.

Output replacement is atomic: the completed temporary file is reparsed and validated before it replaces the destination. A failed generation leaves any existing `feed.xml` intact.

GitHub Actions automation and GitHub Pages publishing are not implemented yet.

The existing `test/fixtures/handmade.xml` is a synthetic, manually authored test fixture, not a captured Google News feed.
