# Myanmar News RSS

A stateless, deduplicated English-language feed of Myanmar and Burma headlines from Google News. Subscribe to it in Folo:

**Live RSS feed:** <https://hois.github.io/myanmar-news-rss/feed.xml>

**Pages site:** <https://hois.github.io/myanmar-news-rss/>

## How it works

```text
Google News RSS (current when:1d snapshot)
  → GitHub Actions (scheduled or manual)
  → Node.js 24: fetch, strict RSS validation, deduplication
  → GitHub Pages (feed.xml)
  → Folo
```

The source is the fixed [Google News query](https://news.google.com/rss/search?hl=en-US&gl=US&q=%28myanmar%7Cburma%29%20when%3A1d&ceid=US%3Aen). Each run processes the items in that current snapshot. V1 keeps no cross-run history, uses no AI API, database, KV, or other persistent state, and does not archive headlines outside the source's `when:1d` window. The project applies no 100-item cap or silent truncation: every valid item returned by Google News reaches deduplication. Repeated production observations for `when:1d` returned exactly 100 items, indicating an observed practical or soft limit on the Google News side. This is not a documented fixed limit, so `when:1d` does not guarantee complete coverage of every story from the past 24 hours.

V1's audited production deduplication settings are a fuzzy adjusted-score threshold of 0.80 and a strict-subset raw Dice guard of 0.85. These settings were retained after empirical review, rather than chosen as temporary defaults. The 0.80 threshold had no false merges in the audited sample; the 0.85 strict-subset guard is conservative and remains in use. `dice` is the production mode; `exact` merges exact normalized headlines only. Direct CLI runs also default to `dice` when `--mode` is omitted. In each cluster, the representative is the earliest `pubDate`, with GUID as the stable tie-breaker.

The production Google News window remains `when:1d`. A `when:12h` window was tested but is not used because it missed some valuable 12–24-hour-old stories; `when:1d` provides better coverage, recovery tolerance, and Folo GUID/representative stability. A 0.82 strict-subset guard and `when:18h` are future observation candidates only, not current settings.

Input and output are validated as RSS 2.0. A document must have one channel with title, link, and description; each item requires a title, link, GUID, and valid `pubDate`. Item description and source (including its URL) are optional. Output is deterministic for the same input and mode, ordered by `pubDate` descending and GUID ascending. `lastBuildDate` is derived from the newest selected item `pubDate` in UTC, not the run time. The channel's `ttl` is 15 minutes as a reader hint; it does not set the workflow schedule.

## Local use

Use Node.js 24 or later. The only runtime dependency is `@rgrove/parse-xml@5.0.0`.

```sh
npm ci
npm test
```

Build a feed from the synthetic local fixture without network access:

```sh
node rss.js --input test/fixtures/handmade.xml --output feed.xml --mode dice
```

Fetch the production source and write a feed:

```sh
node rss.js --fetch --output feed.xml --mode dice
```

The fetch uses Node's built-in `globalThis.fetch`, times out after 30 seconds, and does not retry. It requires HTTP 200 and a non-empty, valid RSS 2.0 feed. HTTP errors, timeouts, network errors, HTML or challenge pages, malformed XML, empty feeds, and invalid items fail the command. A failed generation leaves an existing output file intact.

After a valid feed is written, the CLI compares its bytes with the published feed using SHA-256. Set `PAGES_FEED_URL` or pass `--published-url <url>` for a one-run override. Comparison has a 10-second timeout. A matching hash reports `changed=false` and `reason=sha256_match`; a mismatch reports `changed=true`. If comparison is unavailable or fails, it is non-fatal and reports `changed=true`, allowing a valid new feed to publish. The output also reports mode, HTTP status, item and deduplication counts, SHA-256, reason, and stage timings.

## GitHub Actions and Pages

GitHub Pages uses **GitHub Actions** as its source. The workflow runs on `ubuntu-latest` with Node.js 24, installs the lockfile with `npm ci`, and runs `npm test` before fetching Google News. Only the validated `feed.xml` is included in the Pages artifact.

Configure these as repository Actions variables, not secrets:

| Variable | Production value |
| --- | --- |
| `DEDUPE_MODE` | `dice` |
| `PAGES_FEED_URL` | `https://hois.github.io/myanmar-news-rss/feed.xml` |

The workflow's `workflow_dispatch` mode defaults to `inherit`. It reads `DEDUPE_MODE`; an unset or empty value resolves to `dice`, while an invalid non-empty value fails the build. Selecting `dice` or `exact` on a manual run overrides only that run and does not change the repository variable. Scheduled runs use the repository variable.

The schedule is `7,22,37,52 * * * *` in UTC, approximately every 15 minutes. GitHub's scheduler is best-effort: runs can be delayed, queued, or missed, so this is not a precise interval or SLA.

After a successful build, `changed=false` with a matching SHA-256 skips artifact upload and deployment. `changed=true` uploads and deploys the validated feed. A published-feed comparison failure is treated as `changed=true`; it does not block a valid new feed. Source-fetch, RSS validation, deduplication, or output-generation failure fails the build, skips upload and deployment, and preserves the last successfully deployed feed. This safeguard does not guarantee Pages availability.

The workflow uses official actions pinned to full commit SHAs. Build permissions are limited to `contents: read`; the separate deploy job receives `pages: write` and `id-token: write`. A fixed concurrency group cancels an overlapping in-progress run; it cannot undo a deployment that already completed. Build and deploy timeouts are 5 and 12 minutes.

Production smoke checks have verified Google News HTTP 200, successful `dice` deployment, the one-run `exact` override and restoration to `dice`, and that an invalid inherited mode fails before fetching or deploying while retaining the last-good feed. Production has not yet naturally produced an unchanged batch; the `changed=false` path is covered by automated tests. Concurrency cancellation is configured but has not been forced in production.

GitHub may automatically disable scheduled workflows in a public repository after about 60 days without repository activity. A scheduled run or Pages deployment is not guaranteed to prevent this. V1 adds no keepalive or automatic commits. To resume, enable the workflow, manually run `workflow_dispatch`, and verify the result.
