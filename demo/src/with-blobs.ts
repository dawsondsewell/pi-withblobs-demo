// Vendored from ../../index.ts (the withBlobs spike against pi bdd9f0399). Only change: the type-only import of pi
// types comes from the published @earendil-works/pi-durable@1.3.0 root instead of "../../types.ts". The Storage
// interface is method-for-method identical between v1.3.0 and bdd9f0399.

import type { Context, JsonValue } from "@earendil-works/chord";
import type {
	ConversationId,
	Cursor,
	EntryId,
	EntryQuery,
	EntryRecord,
	Page,
	Seq,
	Storage,
	StorageWrite,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "@earendil-works/pi-durable";

/** Content-addressed text store. `put` must be durable when it resolves; putting an existing key is a no-op. */
export interface BlobStore {
	put(key: string, text: string, context: Context): Promise<void>;
	get(key: string, context: Context): Promise<string | undefined>;
}

export interface BlobOptions {
	/** Payload strings of at least this many UTF-8 bytes move to the blob store. Default 64 KiB. */
	readonly minBlobBytes?: number;
	/** Largest JSON row, in UTF-8 bytes, a commit may hand the inner storage. Default 1.5 MB. */
	readonly maxRowBytes?: number;
}

/** A write whose row would exceed `maxRowBytes` after offloading, such as a large document. */
export class BlobRowTooLarge extends Error {
	constructor(what: string, bytes: number, max: number) {
		super(`${what} is ${bytes} bytes as JSON, over the ${max} byte row limit`);
		this.name = "BlobRowTooLarge";
	}
}

const encoder = new TextEncoder();
const REF = "pi.blob";
const ESCAPE = "pi.blob.escaped";
type Task = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Json = JsonValue | undefined;

/** Hex SHA-256 of the text's UTF-8 bytes. */
export async function blobKey(text: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

function hex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class MemoryBlobStore implements BlobStore {
	readonly blobs = new Map<string, string>();
	async put(key: string, text: string): Promise<void> {
		this.blobs.set(key, text);
	}
	async get(key: string): Promise<string | undefined> {
		return this.blobs.get(key);
	}
}

/**
 * Wrap a Storage so large payload strings of entries, tasks, and submissions live in a BlobStore, leaving a
 * `{"pi.blob": key, "bytes": n}` reference in the row. Every put resolves before the inner commit, and every read
 * restores the exact strings. Documents pass through, because Chord ops edit their strings in place; they are only
 * checked against `maxRowBytes`.
 */
export function withBlobs(storage: Storage, store: BlobStore, options: BlobOptions = {}): Storage {
	const min = options.minBlobBytes ?? 64 * 1024;
	const max = options.maxRowBytes ?? 1_500_000;
	const stored = new Set<string>();

	const encode = (value: Json, puts: Promise<void>[], context: Context): Json => {
		if (typeof value === "string") {
			if (value.length * 3 < min) return value;
			const bytes = encoder.encode(value);
			if (bytes.length < min) return value;
			const ref: { [REF]: string; bytes: number } = { [REF]: "", bytes: bytes.length };
			puts.push(
				crypto.subtle.digest("SHA-256", bytes).then(async (digest) => {
					ref[REF] = hex(digest);
					if (stored.has(ref[REF])) return;
					await store.put(ref[REF], value, context);
					stored.add(ref[REF]);
				}),
			);
			return ref;
		}
		if (value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) return value.map((item) => encode(item, puts, context) as JsonValue);
		// fromEntries defines own properties, so a "__proto__" key stays data instead of setting the prototype.
		const out = Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, encode(item, puts, context) as JsonValue]),
		);
		return Object.hasOwn(value, REF) || Object.hasOwn(value, ESCAPE) ? { [ESCAPE]: out } : out;
	};

	const decode = async (value: Json, context: Context): Promise<Json> => {
		if (value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) return Promise.all(value.map((item) => decode(item, context) as Promise<JsonValue>));
		if (Object.hasOwn(value, REF)) {
			const key = value[REF] as string;
			const text = await store.get(key, context);
			if (text === undefined) throw new Error(`Blob ${key} is missing from the blob store`);
			return text;
		}
		const source = Object.hasOwn(value, ESCAPE) ? (value[ESCAPE] as Record<string, JsonValue>) : value;
		const items = await Promise.all(
			Object.entries(source).map(async ([key, item]) => [key, await decode(item, context)]),
		);
		return Object.fromEntries(items);
	};

	/** Offload one table record's payload fields; returns it unchanged when its row is too small to hold a blob. */
	const offload = <T extends object>(what: string, value: T, fields: (v: T) => T): T => {
		const json = JSON.stringify(value);
		const rowBytes = byteLength(json);
		// Small rows hold no blob-sized string; a row naming the marker still needs its user objects escaped.
		if (rowBytes < min && !json.includes(`"${REF}`)) return value;
		const encoded = fields(value);
		const bytes = encoded === value ? rowBytes : byteLength(JSON.stringify(encoded));
		if (bytes > max) throw new BlobRowTooLarge(what, bytes, max);
		return encoded;
	};

	const check = (what: string, value: unknown): void => {
		const bytes = byteLength(JSON.stringify(value));
		if (bytes > max) throw new BlobRowTooLarge(what, bytes, max);
	};

	const prepare = (write: StorageWrite, puts: Promise<void>[], context: Context): StorageWrite => {
		const enc = <V>(v: V): V => (v === undefined ? v : (encode(v as JsonValue, puts, context) as V));
		switch (write.type) {
			case "entry":
				return {
					type: "entry",
					value: offload(`Entry ${write.value.id}`, write.value, (v) => ({
						...v,
						...(v.model !== undefined && { model: enc(v.model) }),
						...(v.data !== undefined && { data: enc(v.data) }),
						...(v.edits !== undefined && { edits: enc(v.edits) }),
					})),
				};
			case "task":
				return {
					type: "task",
					value: offload(
						`Task ${write.value.id}`,
						write.value,
						(v) =>
							({
								...v,
								input: enc(v.input),
								...(v.memos !== undefined && { memos: enc(v.memos) }),
								state: {
									...v.state,
									...("checkpoint" in v.state && { checkpoint: enc(v.state.checkpoint) }),
									...(v.state.outcome !== undefined && { outcome: enc(v.state.outcome) }),
								},
							}) as Task,
					),
				};
			case "submission":
				return {
					type: "submission",
					value: offload(`Submission ${write.value.id}`, write.value, (v) =>
						v.detail === undefined ? v : ({ ...v, detail: enc(v.detail) } as SubmissionRecord),
					),
				};
			case "document.create":
			case "document.change":
				check(`Document ${write.type === "document.create" ? write.record.kind : write.id}`, write.content);
				return write;
			default:
				return write;
		}
	};

	const entry = async (e: EntryRecord, context: Context): Promise<EntryRecord> =>
		(await decodeFields(e, ["model", "data", "edits"], context)) as EntryRecord;
	const task = async (t: Task, context: Context): Promise<Task> => {
		const out = (await decodeFields(t, ["input", "memos"], context)) as Task;
		return { ...out, state: await decodeFields(t.state, ["checkpoint", "outcome"], context) } as Task;
	};
	const submission = async (s: SubmissionRecord, context: Context): Promise<SubmissionRecord> =>
		(await decodeFields(s, ["detail"], context)) as SubmissionRecord;

	const decodeFields = async <T extends object>(record: T, fields: string[], context: Context): Promise<T> => {
		let out: T = record;
		for (const field of fields) {
			const value = (record as Record<string, Json>)[field];
			if (value === null || typeof value !== "object") continue;
			out = { ...out, [field]: await decode(value, context) };
		}
		return out;
	};
	const page = async <T>(p: Page<T, Cursor>, map: (item: T) => Promise<T>): Promise<Page<T, Cursor>> => ({
		...p,
		items: await Promise.all(p.items.map(map)),
	});

	return {
		async commit(writes, context): Promise<Seq> {
			const puts: Promise<void>[] = [];
			const prepared = writes.map((write) => prepare(write, puts, context));
			await Promise.all(puts);
			return storage.commit(prepared, context);
		},
		mintId: () => storage.mintId(),
		conversation: (id, context) => storage.conversation(id, context),
		scanConversations: (query, limit, cursor, context) => storage.scanConversations(query, limit, cursor, context),
		async entry(first: EntryId | ConversationId, second: EntryId | Context, third?: Context) {
			const context = (third ?? second) as Context;
			const found =
				third === undefined
					? await storage.entry(first as EntryId, context)
					: await storage.entry(first as ConversationId, second as EntryId, third);
			return found && { entry: await entry(found.entry, context), commitSeq: found.commitSeq };
		},
		async findLatestHeadMarker(conversationId, atOrBefore, context) {
			const found = await storage.findLatestHeadMarker(conversationId, atOrBefore, context);
			return found && ((await entry(found, context)) as EntryRecord & { readonly head: EntryId });
		},
		async scanEntries(query: EntryQuery, limit, cursor, context) {
			return page(await storage.scanEntries(query, limit, cursor, context), (e) => entry(e, context));
		},
		async task(id: TaskId, context) {
			const found = await storage.task(id, context);
			return found && task(found, context);
		},
		async scanTasks(query: TaskQuery, limit, cursor, context) {
			return page(await storage.scanTasks(query, limit, cursor, context), (t) => task(t, context));
		},
		async submission(id: SubmissionId, context) {
			const found = await storage.submission(id, context);
			return found && submission(found, context);
		},
		async scanSubmissions(query: SubmissionQuery, limit, cursor, context) {
			return page(await storage.scanSubmissions(query, limit, cursor, context), (s) => submission(s, context));
		},
		async submissionByRequest(conversationId, requestId, context) {
			const found = await storage.submissionByRequest(conversationId, requestId, context);
			return found && submission(found, context);
		},
		findDocument: (address, at, context) => storage.findDocument(address, at, context),
		document: (id, at, context) => storage.document(id, at, context),
		scanDocuments: (query, limit, cursor, context) => storage.scanDocuments(query, limit, cursor, context),
		close: (context) => storage.close(context),
	} as Storage;
}

function byteLength(text: string): number {
	return encoder.encode(text).length;
}
