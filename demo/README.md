# withBlobs demo: one pi-durable Session, before and after

A recordable demo for the pi-durable large-entry proposal. One Worker with one Durable Object class runs the same scripted pi-durable conversation on two routes. The faux model from `@earendil-works/pi-ai` stands in for a real one, so no API keys are needed:

1. The user says "Take a screenshot of the dashboard."
2. The model calls `screenshot`. The tool returns a 3 MiB base64 PNG as an image content block.
3. The model answers "Done."

| Route | Storage |
|---|---|
| `GET /before` | pi-durable on plain Durable Object SQLite (`openDurableObjectSqliteStorage(ctx.storage)`) |
| `GET /after` | the same storage wrapped in `withBlobs(storage, r2BlobStore(env.BLOBS))` |
| `?enforce=2mb` | **local switch only**: a guard under pi that raises the production error for values or rows over 2,000,000 bytes |
| `GET /reset` | wipe all four demo Durable Objects and the R2 bucket |
| `GET /` | one-screen explanation with links |

Each route reports the outcome (with the exact error if the Session failed), the screenshot read back through pi's `Storage` (byte for byte), the largest row actually stored in SQLite (`max` of the summed `length(CAST(col AS BLOB))` over every pi table), the number of blobs written to R2, and elapsed ms. Every take wipes its own Durable Object first, so takes are independent. `/before` and `/after` use separate Durable Objects (`before`, `before-2mb`, `after`, `after-2mb`).

The screenshot is an image on purpose. pi caps a tool's *text* output at 50 KB (`DEFAULT_MAX_BYTES` in `truncate.ts`), so a 3 MB text report gets truncated to a 52 KB row and never hits the limit. Image blocks pass through untouched, which is the real-world path to a 3 MB row.

## Commands

```sh
npm install
npx wrangler dev        # local; open http://localhost:8787
npx wrangler deploy     # optional, your own Cloudflare account
```

During `wrangler dev`, show in this order:

```sh
curl 'http://localhost:8787/before'              # answers: the 3 MB row saves locally (the blind spot)
curl 'http://localhost:8787/before?enforce=2mb'  # Session fails with the production error
curl 'http://localhost:8787/after'               # answers: largest row ~0.5 KB, 1 blob in R2
curl 'http://localhost:8787/after?enforce=2mb'   # still answers under the 2 MB rule
```

Before deploying, create the bucket if it doesn't exist yet: `npx wrangler r2 bucket create pi-withblobs-demo`. After `wrangler deploy`, open `https://pi-withblobs-demo.<your-subdomain>.workers.dev/before` **without** the switch. Cloudflare documents a 2 MB row limit, so this was expected to fail the Session the same way `/before?enforce=2mb` does locally. But on 2026-10-22, a production check on a Workers Paid test account stored a 4,194,649-byte pi row twice without failing (see the top-level README). So `/before` may well answer in production.

## Why the local switch exists

Cloudflare documents the Durable Object SQLite limit as "Maximum string, `BLOB` or table row size: 2 MB" ([Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/); D1 states the same limit as 2,000,000 bytes). Local `wrangler dev` runs open-source workerd, which sets `SQLITE_LIMIT_LENGTH` to `MAX_ROW_LENGTH = 8 * 1024 * 1024 + 34` ([`src/workerd/util/sqlite.h`](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.h), applied in `sqlite.c++`). So locally a 3 MB row saves fine, as `/before` shows.

`?enforce=2mb` wraps `ctx.storage` in a tiny guard (`enforce2mb` in `src/index.ts`) before handing it to `openDurableObjectSqliteStorage`. When a statement binds a value, or values that together exceed 2,000,000 bytes, it throws `Error("string or blob too big: SQLITE_TOOBIG")`. It sits under pi, where production raises the error, so pi's own error handling is real. Only the trigger is simulated.

Where the error text comes from: it is SQLite's standard `SQLITE_TOOBIG` message as workerd surfaces it. Reports of it from production Cloudflare:

- A Durable Object SQLite user hitting `Error: string or blob too big: SQLITE_TOOBIG` on a 2,288,921-byte row, answered by a Cloudflare employee pointing at the workerd limit ([Cloudflare Discord via Answer Overflow, Oct 2024](https://www.answeroverflow.com/m/1299190022926372974)).
- `cloudflare/agents` issue [#546](https://github.com/cloudflare/agents/issues/546), same text from Agents SDK state in DO SQLite.
- D1 adds a prefix: `D1_ERROR: string or blob too big: SQLITE_TOOBIG`.

Caveat: we have not reproduced it on production ourselves. The exact production threshold (2,000,000 bytes vs 2 MiB, per value vs per row) is taken from the docs, and the guard checks both a single value and the sum of a statement's values.

## Versions and differences from the spike

- `@earendil-works/pi-durable`, `pi-ai` and `chord` are pinned to **1.3.0**, the newest published release (15 Oct 2026). The spike targets `bdd9f0399`, 50 commits after `v1.3.0`.
- `src/with-blobs.ts` is `../index.ts` vendored. The only change is the type-only import, which comes from the `@earendil-works/pi-durable` root instead of `../../types.ts`. The `Storage` interface is method for method the same in `v1.3.0` and `bdd9f0399`.
- API differences that matter for the host code: 1.3.0 has no `Harness.wake()` or `onWake` (unreleased), so this demo needs no alarms. It opens a Harness per request, runs one turn, and closes it.
- `r2BlobStore` in `src/index.ts` is the ~20-line R2 adapter: keys are `blobs/<sha256>`, and `put` and `get` retry 3 times with backoff.

## Expected output

Captured from `npx wrangler dev` (wrangler 4.151.3, local R2 and DO SQLite) on 21 Oct 2026:

```text
$ curl 'http://localhost:8787/before'
{
  "route": "/before",
  "storage": "DO SQLite (plain)",
  "local_2mb_guard": "off",
  "outcome": "answered",
  "answer": "Done.",
  "tool_result_bytes": 3145728,
  "screenshot_read_back": {
    "bytes": 3145728,
    "identical": true
  },
  "largest_sqlite_row": {
    "bytes": 3146067,
    "table": "entries"
  },
  "blobs_written_to_r2": 0,
  "elapsed_ms": 70
}

$ curl 'http://localhost:8787/before?enforce=2mb'
{
  "route": "/before?enforce=2mb",
  "storage": "DO SQLite (plain)",
  "local_2mb_guard": "ON (simulates production)",
  "outcome": "session failed",
  "error": "SessionFailed: Session failed after a storage error; close and reopen it\n  caused by Error: string or blob too big: SQLITE_TOOBIG",
  "tool_result_bytes": 3145728,
  "largest_sqlite_row": {
    "bytes": 488,
    "table": "entries"
  },
  "blobs_written_to_r2": 0,
  "elapsed_ms": 19
}

$ curl 'http://localhost:8787/after'
{
  "route": "/after",
  "storage": "withBlobs(DO SQLite, R2 bucket BLOBS)",
  "local_2mb_guard": "off",
  "outcome": "answered",
  "answer": "Done.",
  "tool_result_bytes": 3145728,
  "screenshot_read_back": {
    "bytes": 3145728,
    "identical": true
  },
  "largest_sqlite_row": {
    "bytes": 489,
    "table": "entries"
  },
  "blobs_written_to_r2": 1,
  "elapsed_ms": 72
}

$ curl 'http://localhost:8787/after?enforce=2mb'
{
  "route": "/after?enforce=2mb",
  "storage": "withBlobs(DO SQLite, R2 bucket BLOBS)",
  "local_2mb_guard": "ON (simulates production)",
  "outcome": "answered",
  "answer": "Done.",
  "tool_result_bytes": 3145728,
  "screenshot_read_back": {
    "bytes": 3145728,
    "identical": true
  },
  "largest_sqlite_row": {
    "bytes": 489,
    "table": "entries"
  },
  "blobs_written_to_r2": 1,
  "elapsed_ms": 63
}

```

What this shows:

- `/before` answers locally even though it stored a 3,146,067-byte row. That's the blind spot.
- `/before?enforce=2mb`: pi's Session fails (`SessionFailed`, caused by the SQLite error) and the turn never answers. Nothing large was committed: the largest row left is 489 bytes.
- `/after`: the same 3 MiB image goes to R2 as one blob, the largest SQLite row is 489 bytes, and the image reads back through `withBlobs` byte for byte.
- `/after?enforce=2mb` behaves the same: nothing near 2 MB reaches SQLite.

`/reset` prints `Reset: 4 Durable Objects wiped, 1 R2 objects deleted.` The two `/after` takes stored one object, because keys are content hashes.
