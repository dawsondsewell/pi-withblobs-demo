# pi-durable withBlobs: one big tool result shouldn't end a Session

On Cloudflare, [pi-durable](https://github.com/earendil-works/pi) stores each Session entry as one Durable Object SQLite row, and Cloudflare caps a row at 2 MB. One large tool result, such as a 3 MB screenshot, raises `SQLITE_TOOBIG`, and pi then fails the whole Session. Local `wrangler dev` allows rows up to 8 MiB, so local tests never catch it.

`withBlobs(storage, blobStore)` is a pi `Storage` decorator that fixes this without touching pi's core. On commit, large payload strings go to a content-addressed blob store such as R2, and the row keeps a small reference. Every blob is stored before the row commits, so a crash can only leave an unused blob, never a dangling reference. On read, the original comes back byte for byte.

This repo is evidence for a contribution proposal to pi. It's a spike, not a published package.

**Status, 2026-10-22: production didn't fail.** Cloudflare documents a 2 MB limit on a Durable Object row, but a production check on a Workers Paid test account stored a 4,194,649-byte pi row twice without the wrapper, and the turn finished normally. That check used another project's harness on pi-durable 1.3.0, not this demo. So the documented limit wasn't enforced that day. Meanwhile newer local workerd (1.20260815) refuses values over about 2.2 MB. Which environment fails, and when, depends on the runtime. The decorator keeps rows small either way.

## What's here

- **`demo/`**: a runnable Worker that shows the failure and the fix with one scripted conversation and no API keys. See [demo/README.md](demo/README.md) for the walkthrough and the expected output.
  ```sh
  cd demo && npm install && npx wrangler dev
  ```
  Then, in another terminal:
  ```sh
  curl 'http://localhost:8787/before?enforce=2mb'   # the Session fails with SQLITE_TOOBIG
  curl 'http://localhost:8787/after?enforce=2mb'    # same conversation through withBlobs: it answers
  ```
- **`index.ts`**: the 258-line decorator, with `BlobStore`, `blobKey`, `MemoryBlobStore` and `BlobRowTooLarge`.
- **`blobs-storage.test.ts`** and **`blobs-rows.probe.test.ts`**: the conformance and failure-mode tests, and a probe that measures the largest row each write kind produces.

The decorator and tests import pi's internals by relative path, so they only run inside pi's own tree. They target earendil-works/pi at `bdd9f0399d785189eb1920255e0a5a393bb389e3`, as `packages/durable/src/storage/blobs/index.ts` and `packages/durable/test/`. The demo vendors the decorator as `demo/src/with-blobs.ts` against the published pi-durable 1.3.0.

## Results

- pi's own storage conformance suite, run through the decorator with `minBlobBytes: 1` so every string goes through the blob store: 25 of 25 on `MemoryStorage` and on `SqliteStorage`. The full test file passes 56 of 56.
- In the demo, the largest SQLite row drops from 3,146,067 bytes to 489 bytes, and the screenshot reads back identical.

## Known limits

- Documents can't hold blob references, because Chord edits their strings in place, so the decorator only size-checks them and fails fast with a clear error.
- Some documents can exceed the limit on their own today: code mode's run output, the code mode store (whose limit counts characters, not bytes), and nested results with images.

Written with AI assistance. MIT licensed.
