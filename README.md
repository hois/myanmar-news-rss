# Myanmar News RSS

This project develops a deduplicated Google News RSS feed for Myanmar/Burma headlines.

V1 uses token Dice for fuzzy matching, with a default adjusted-score threshold of 0.80. The mode can be selected with `--mode dice` / `--mode exact` or `DEDUPE_MODE=dice` / `DEDUPE_MODE=exact`. A cluster representative is chosen by earliest `pubDate`, then GUID.

The project is in development. Phase 1 does not include an RSS writer, GitHub Actions workflow, or GitHub Pages publishing.

Run the offline tests with:

```sh
node --test
```
