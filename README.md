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

The production fetch uses Node's built-in `globalThis.fetch`, has a 30-second timeout covering both response headers and body reading, and does not retry. It requires HTTP 200, a non-empty RSS 2.0 document, and valid required fields on every item. HTTP errors, timeouts, network errors, HTML or challenge pages, malformed/non-RSS XML, zero-item feeds, and invalid items exit non-zero. A failed generation leaves an existing `feed.xml` intact.

Fetch Google News and write the production feed:

```sh
node rss.js --fetch --output feed.xml --mode dice
```

Use `--mode exact` to merge exact normalized headlines only. The CLI defaults to `dice` if `--mode` is omitted. `--input <file>` remains the offline mode and cannot be combined with `--fetch`.

After a validated feed is written, the CLI compares its final bytes with the published feed using SHA-256. Configure the current published URL with `PAGES_FEED_URL`, or pass `--published-url <url>` to override the environment value for this run. The comparison has a 10-second timeout and sends no-cache/revalidation request headers. Comparison errors—including an unset URL, HTTP errors, timeouts, and network failures—are non-fatal and report `changed=true`; the reason is included in the machine-readable output. Identical bytes report `changed=false` with `reason=sha256_match`. Output includes stable `key=value` fields such as `changed`, `reason`, `output_sha256`, item counts, candidate pair/cluster counts, and stage timings.

The output channel has a fixed title, the stable Myanmar/Burma Google News search URL, English language, and `ttl` of 15 minutes. The TTL is a feed hint; it does not guarantee that a reader fetches the feed every 15 minutes. `lastBuildDate` is the newest selected item `pubDate`, so rerunning an unchanged input does not add a runtime timestamp. Items are ordered by `pubDate` descending and then GUID ascending. The writer preserves item title, link, GUID and its `isPermaLink` state, `pubDate`, and optional description/source/source URL, with XML escaping and output round-trip validation.

Output replacement is atomic: the completed temporary file is reparsed and validated before it replaces the destination. A failed generation leaves any existing `feed.xml` intact.

## GitHub Actions and Pages

Phase 4 adds a scheduled GitHub Actions workflow that builds and publishes the feed through the GitHub Pages artifact deployment flow:

```text
Public repository
  → GitHub Actions schedule or workflow_dispatch
  → ubuntu-latest / Node.js 24 / npm ci / npm test
  → fetch the fixed Google News URL in rss.js
  → strict validation, dedupe, and atomic dist/feed.xml write
  → compare published bytes by SHA-256
  → upload the Pages artifact only when changed=true
  → deploy the artifact to GitHub Pages
  → Folo
```

The schedule is `7,22,37,52 * * * *` in UTC. GitHub's cron scheduler is best-effort: a run can be delayed, queued, or exceptionally missed. This workflow does not promise an update exactly every 15 minutes.

`workflow_dispatch` provides a `mode` choice whose default is `inherit`:

- `inherit` reads the `DEDUPE_MODE` repository variable. If it is unset or empty, the run uses `dice`.
- `dice` and `exact` on a dispatch override that one run only; they do not change the repository variable.
- The persistent repository variable may be `dice` or `exact`. An unset/empty value resolves to `dice`; any other non-empty value fails the build instead of silently falling back.
- Scheduled runs always use `DEDUPE_MODE` with the same empty-to-`dice` rule.

The workflow exposes `vars.PAGES_FEED_URL` as `PAGES_FEED_URL` for the Phase 3 published-feed comparison. This variable is intentionally optional and is not configured in Phase 4. Until it is set, Phase 3 reports `changed=true`, so a valid feed can be uploaded and deployed. After Pages is configured, set it to the confirmed feed URL. If the project uses its default project Pages URL, the expected address is `https://hois.github.io/myanmar-news-rss/feed.xml`; this URL is not embedded in `rss.js`.

The build runs `npm test` before any production fetch. It then runs the existing production entry point, captures the single exact `changed=true` or `changed=false` output line, and exports it as the build job's `changed` output. A successful `changed=false` comparison logs `unchanged / sha256_match`, skips artifact upload, and leaves deploy skipped. A successful `changed=true` comparison uploads `dist/` through the official Pages artifact action; the generated directory contains only the validated `feed.xml`. No source files, tests, dependencies, lockfiles, logs, or Git metadata are part of the Pages artifact. The action's short default artifact retention is used.

Checkout, setup, dependency install, tests, mode validation, fetch, parse, dedupe, serialization, output validation, and write failures all fail the build, which prevents artifact upload and deployment. A published-feed comparison failure is intentionally non-fatal in Phase 3 and resolves to `changed=true`; if the new feed itself passes validation, it can still deploy.

This is a last-good deployment safeguard: a failed build does not create a new deployment from a bad or fallback feed, so the previous successful deployment remains the last deployed version. It does not guarantee that GitHub Pages itself will always be available or free of service failures.

The workflow uses official, full-SHA-pinned actions: `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `actions/upload-pages-artifact` v5.0.0, and `actions/deploy-pages` v5.0.1. The build job has only `contents: read`; the separate deploy job receives `pages: write` and `id-token: write`. A fixed concurrency group cancels an overlapping in-progress run; it cannot roll back a deployment that has already completed. Build and deploy timeouts are 5 and 12 minutes.

The design target is a public repository and the standard GitHub-hosted runner. Platform policies may change; this is not a guarantee of permanent free service. V1 does not use a larger runner, keepalive workflow, PAT, `gh-pages` branch, or feed commits.

GitHub may automatically disable scheduled workflows in a public repository after about 60 days without repository activity. A Pages deployment, artifact upload, or the schedule running by itself is not guaranteed to count as repository activity. V1 does not add keepalive activity or automatic commits. Recovery is: **Enable workflow → run and verify `workflow_dispatch` manually.**

**Phase 4 complete does not mean the feed is live.** Phase 5 must still configure the repository's Pages settings, enable Pages, create any needed repository variables, and run the authorized manual dispatch verification. No Pages settings, variables, dispatch, or deployment are performed by this Phase 4 change.

The existing `test/fixtures/handmade.xml` is a synthetic, manually authored test fixture, not a captured Google News feed.
