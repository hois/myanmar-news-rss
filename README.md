# Myanmar News RSS

This project develops a deduplicated Google News RSS feed for Myanmar/Burma headlines.

V1 uses token Dice for fuzzy matching, with a default adjusted-score threshold of 0.80. `dice` mode applies the Phase 1 fuzzy matching rules; `exact` mode merges exact normalized headlines only. Within each cluster, the representative is chosen by earliest `pubDate`, then GUID.

Phase 2 reads a local RSS 2.0 XML file, validates every item's title, link, GUID, and `pubDate`, applies the selected dedupe mode, and writes a deterministic RSS 2.0 feed. It does not fetch Google News or publish the output.

## Local use

Install the pinned dependency and run the offline tests:

```sh
npm ci
npm test
```

Build `feed.xml` from a local input file:

```sh
node rss.js --input test/fixtures/handmade.xml --output feed.xml --mode dice
```

Use `--mode exact` to keep only exact normalized-title merges. The CLI defaults to `dice` if `--mode` is omitted.

The output channel has a fixed title, the stable Myanmar/Burma Google News search URL, English language, and `ttl` of 15 minutes. The TTL is a feed hint; it does not guarantee that Folo fetches the feed every 15 minutes. `lastBuildDate` is the newest selected item `pubDate`, so rerunning an unchanged input does not add a runtime timestamp. Items are ordered by `pubDate` descending and then GUID ascending. The writer preserves item title, link, GUID and its `isPermaLink` state, `pubDate`, and optional description/source/source URL, with XML escaping and output round-trip validation.

Output replacement is atomic: the completed temporary file is reparsed and validated before it replaces the destination. A failed generation leaves any existing `feed.xml` intact.

GitHub Actions and GitHub Pages are not configured in this phase.

The existing `test/fixtures/handmade.xml` is a synthetic, manually authored test fixture, not a captured Google News feed.
```
