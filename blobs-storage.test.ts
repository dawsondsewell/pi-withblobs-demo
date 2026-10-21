import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { blobKey, MemoryBlobStore, withBlobs } from "../src/storage/blobs/index.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { type EntryId, ROOT_CONVERSATION_ID, type StorageWrite } from "../src/types.ts";

const conformanceBlobs = new MemoryBlobStore();
registerStorageConformance({ describe, expect, it }, "withBlobs(MemoryStorage) offloading every string", (use) =>
	use(withBlobs(new MemoryStorage(), conformanceBlobs, { minBlobBytes: 1 })),
);
registerStorageConformance(
	{ describe, expect, it },
	"withBlobs(SqliteStorage) offloading every string",
	async (use) => {
		const storage = await openNodeSqliteStorage(":memory:");
		await use(withBlobs(storage, conformanceBlobs, { minBlobBytes: 1 }));
	},
);
it("sent conformance payload strings through the blob store", () => {
	expect(conformanceBlobs.blobs.size).toBeGreaterThan(10);
});

const root: StorageWrite = { type: "conversation", value: { id: ROOT_CONVERSATION_ID } };
const entry = (n: number, data: unknown): StorageWrite => ({
	type: "entry",
	value: { id: idFromNumber<EntryId>(n), conversationId: ROOT_CONVERSATION_ID, kind: "test", data: data as never },
});

class CountingBlobStore extends MemoryBlobStore {
	puts = 0;
	fail = false;
	override async put(key: string, text: string): Promise<void> {
		this.puts++;
		if (this.fail) throw new Error("blob store down");
		await super.put(key, text);
	}
}

describe("withBlobs", () => {
	it("leaves the inner storage unchanged when a put rejects", async () => {
		const inner = new MemoryStorage();
		const blobs = new CountingBlobStore();
		const storage = withBlobs(inner, blobs, { minBlobBytes: 1 });
		await storage.commit([root], BACKGROUND_CONTEXT);
		blobs.fail = true;
		await expect(storage.commit([entry(2, "x".repeat(10))], BACKGROUND_CONTEXT)).rejects.toThrow("blob store down");
		expect(await inner.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT)).toBeUndefined();
	});

	it("commits a 3 MB entry as a small row and reads it back byte for byte", async () => {
		const inner = new MemoryStorage();
		const storage = withBlobs(inner, new MemoryBlobStore());
		const text = "é".repeat(1_500_000);
		await storage.commit([root, entry(2, { output: text })], BACKGROUND_CONTEXT);
		const row = await inner.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT);
		expect(new TextEncoder().encode(JSON.stringify(row?.entry)).length).toBeLessThan(1024);
		expect(row?.entry.data).toEqual({ output: { "pi.blob": await blobKey(text), bytes: 3_000_000 } });
		const read = await storage.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT);
		expect((read?.entry.data as { output: string }).output === text).toBe(true);
	});

	it("puts a retried value once under the same key", async () => {
		const blobs = new CountingBlobStore();
		const storage = withBlobs(new MemoryStorage(), blobs, { minBlobBytes: 1 });
		await storage.commit([root], BACKGROUND_CONTEXT);
		blobs.fail = true;
		await expect(storage.commit([entry(2, "retry me")], BACKGROUND_CONTEXT)).rejects.toThrow();
		blobs.fail = false;
		await storage.commit([entry(2, "retry me")], BACKGROUND_CONTEXT);
		await storage.commit([entry(3, "retry me")], BACKGROUND_CONTEXT);
		expect(blobs.puts).toBe(2);
		expect([...blobs.blobs.keys()]).toEqual([await blobKey("retry me")]);
	});

	it("round-trips user objects shaped like references", async () => {
		const storage = withBlobs(new MemoryStorage(), new MemoryBlobStore(), { minBlobBytes: 1 });
		const data = { a: { "pi.blob": "abc", bytes: 3 }, b: { "pi.blob.escaped": { "pi.blob": "x" } } };
		await storage.commit([root, entry(2, data)], BACKGROUND_CONTEXT);
		expect((await storage.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT))?.entry.data).toEqual(data);
		const small = withBlobs(new MemoryStorage(), new MemoryBlobStore());
		await small.commit([root, entry(2, data)], BACKGROUND_CONTEXT);
		expect((await small.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT))?.entry.data).toEqual(data);
	});

	it("rejects a document over the row limit before the inner commit", async () => {
		const storage = withBlobs(new MemoryStorage(), new MemoryBlobStore(), { maxRowBytes: 1000 });
		await expect(
			storage.commit(
				[
					{
						type: "document.create",
						record: { id: idFromNumber(2), kind: "big", scope: { kind: "session" } },
						content: { version: 1, kind: "base", value: { text: "x".repeat(2000) } },
					},
				],
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow("over the 1000 byte row limit");
	});
});
