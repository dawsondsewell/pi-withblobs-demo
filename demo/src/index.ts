// pi-durable on a Durable Object, before and after withBlobs. The same scripted conversation runs on both routes:
// the faux model calls `screenshot`, the tool returns a ~3 MB base64 PNG, and the model answers "Done."
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, type Storage } from "@earendil-works/pi-durable";
import {
	type DurableObjectSqliteStorage,
	openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { type BlobStore, withBlobs } from "./with-blobs.ts";

interface Env {
	AGENT: DurableObjectNamespace<AgentObject>;
	BLOBS: R2Bucket;
}

const context = BACKGROUND_CONTEXT;
/** Base64 length of the screenshot: 3 MiB, i.e. a ~2.25 MiB PNG. Tool text output is capped at 50 KB by pi; images are not. */
const IMAGE_BASE64_BYTES = 3 * 1024 * 1024;
/** Cloudflare's documented cap: "Maximum string, BLOB or table row size: 2 MB" (2,000,000 bytes, as D1 states it). */
const ROW_LIMIT = 2_000_000;
/** The error production DO SQLite and D1 raise for an oversized value (SQLite's SQLITE_TOOBIG). See README. */
const TOOBIG = "string or blob too big: SQLITE_TOOBIG";
const encoder = new TextEncoder();

/** Minimal R2 BlobStore: content-addressed keys, so a repeated put is harmless. Retries transient failures. */
function r2BlobStore(bucket: R2Bucket, counter: { puts: number }): BlobStore {
	const retry = async <T>(op: () => Promise<T>): Promise<T> => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await op();
			} catch (error) {
				if (attempt >= 3) throw error;
				await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
			}
		}
	};
	return {
		async put(key, text) {
			await retry(() => bucket.put(`blobs/${key}`, text));
			counter.puts++;
		},
		async get(key) {
			return retry(async () => (await bucket.get(`blobs/${key}`))?.text());
		},
	};
}

/**
 * LOCAL SWITCH ONLY (?enforce=2mb). Local workerd allows rows up to 8 MiB, so a 3 MB row saves fine under
 * `wrangler dev`. This guard sits between pi and ctx.storage.sql and throws the error production raises when a
 * statement binds a value (or a row's values together) over 2,000,000 bytes. Production needs no switch.
 */
function enforce2mb(storage: DurableObjectStorage): DurableObjectSqliteStorage {
	const size = (value: unknown) =>
		typeof value === "string" ? encoder.encode(value).length : value instanceof ArrayBuffer ? value.byteLength : 8;
	return {
		sql: {
			exec(query: string, ...bindings: (ArrayBuffer | string | number | null)[]) {
				const sizes = bindings.map(size);
				if (Math.max(0, ...sizes) > ROW_LIMIT || sizes.reduce((a, b) => a + b, 0) > ROW_LIMIT) {
					throw new Error(TOOBIG);
				}
				return storage.sql.exec(query, ...bindings);
			},
		},
		transaction: (closure) => storage.transaction(closure),
	};
}

type Mode = "before" | "after";

export class AgentObject extends DurableObject<Env> {
	async run(mode: Mode, enforce: boolean): Promise<Record<string, unknown>> {
		const started = Date.now();
		// A clean take every time: wipe this object's SQLite storage before the run.
		await this.ctx.storage.deleteAll();

		const counter = { puts: 0 };
		const sqlite = await openDurableObjectSqliteStorage(enforce ? enforce2mb(this.ctx.storage) : this.ctx.storage);
		const storage: Storage = mode === "after" ? withBlobs(sqlite, r2BlobStore(this.env.BLOBS, counter)) : sqlite;

		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("screenshot", { url: "https://example.com/dashboard" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Done.")]),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const screenshot = defineTool({
			name: "screenshot",
			description: "Take a full-page screenshot",
			parameters: Type.Object({ url: Type.String() }),
			execute: async () => ({
				output: [
					{ type: "text", text: "Screenshot captured." },
					{ type: "image", mimeType: "image/png", data: fakePngBase64() },
				],
			}),
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "demo", tools: [screenshot] }));

		let outcome: string;
		let error: string | undefined;
		let answer: unknown;
		let readBack: unknown;
		const harness = await Harness.open(storage, { models, registry }, context);
		try {
			harness.resume();
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const sub = await root.submit({ type: "input", content: "Take a screenshot of the dashboard.", requestId: "take" }, context);
			const settled = await sub.wait(context);
			outcome = settled.status === "done" ? "answered" : `settled: ${settled.status}`;
			answer = await answerText(storage, (settled as { answer?: unknown }).answer);
			readBack = await this.readBack(storage);
		} catch (caught) {
			outcome = "session failed";
			error = describe(caught);
		} finally {
			await harness.close(context).catch(() => {});
		}

		return {
			route: `/${mode}${enforce ? "?enforce=2mb" : ""}`,
			storage: mode === "after" ? "withBlobs(DO SQLite, R2 bucket BLOBS)" : "DO SQLite (plain)",
			local_2mb_guard: enforce ? "ON (simulates production)" : "off",
			outcome,
			...(error !== undefined && { error }),
			...(answer !== undefined && { answer }),
			tool_result_bytes: IMAGE_BASE64_BYTES,
			...(readBack !== undefined && { screenshot_read_back: readBack }),
			largest_sqlite_row: this.largestRow(),
			blobs_written_to_r2: counter.puts,
			elapsed_ms: Date.now() - started,
		};
	}

	async reset(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	/** Read the tool result entry back through pi's Storage (so /after resolves the blob from R2) and compare it. */
	async readBack(storage: Storage): Promise<{ bytes: number; identical: boolean } | undefined> {
		const row = this.ctx.storage.sql
			.exec<{ id: number }>("SELECT id FROM entries WHERE instr(record, '\"image\"') > 0 ORDER BY id DESC LIMIT 1")
			.toArray()[0];
		if (row === undefined) return undefined;
		const found = await storage.entry(row.id as never, context);
		const images = (found?.entry.model ?? []).flatMap((m) =>
			Array.isArray(m.content) ? m.content.filter((c) => c.type === "image") : [],
		) as { data: string }[];
		const data = images[0]?.data ?? "";
		return { bytes: data.length, identical: data === fakePngBase64() };
	}

	/** Largest row actually stored, in bytes: sum of every column's byte length, over every pi table. */
	largestRow(): { bytes: number; table: string } {
		const sql = this.ctx.storage.sql;
		let best = { bytes: 0, table: "-" };
		const tables = sql
			.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
			.toArray();
		for (const { name } of tables) {
			const columns = sql.exec<{ name: string }>(`PRAGMA table_info("${name}")`).toArray();
			if (columns.length === 0) continue;
			const sum = columns.map((c) => `coalesce(length(CAST("${c.name}" AS BLOB)), 0)`).join(" + ");
			const row = sql.exec<{ m: number | null }>(`SELECT max(${sum}) AS m FROM "${name}"`).one();
			if ((row.m ?? 0) > best.bytes) best = { bytes: row.m ?? 0, table: name };
		}
		return best;
	}
}

/** A PNG signature followed by deterministic noise, base64-encoded to IMAGE_BASE64_BYTES characters. */
function fakePngBase64(): string {
	const bytes = new Uint8Array((IMAGE_BASE64_BYTES / 4) * 3);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	let x = 2463534242;
	for (let i = 8; i < bytes.length; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		bytes[i] = x & 0xff;
	}
	return Buffer.from(bytes).toString("base64");
}

/** The answer entry's assistant text, read back through the same storage (so /after reads through withBlobs). */
async function answerText(storage: Storage, id: unknown): Promise<unknown> {
	if (id === undefined) return undefined;
	const found = await storage.entry(id as never, context);
	const content = (found?.entry.model ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
	return content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function describe(error: unknown): string {
	const parts: string[] = [];
	for (let e: unknown = error; e !== undefined && parts.length < 4; e = (e as { cause?: unknown }).cause) {
		parts.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
		if (!(e instanceof Error)) break;
	}
	return parts.join("\n  caused by ");
}

const HOME = `pi-durable + withBlobs demo
===========================

One scripted pi-durable conversation (faux model, no API keys) runs on a Durable Object:
the model calls screenshot, the tool returns a 3 MB base64 PNG, the model answers "Done."

  /before               plain DO SQLite storage
  /before?enforce=2mb   same, with the LOCAL 2 MB guard on (production enforces this without a switch)
  /after                withBlobs(storage, r2BlobStore(env.BLOBS))
  /after?enforce=2mb    same, with the local 2 MB guard on
  /reset                wipe all demo Durable Objects and the R2 bucket

Cloudflare caps a DO SQLite string, BLOB or row at 2 MB. Local workerd allows 8 MiB,
so /before "works" under wrangler dev: that is the blind spot. Deployed, /before fails.
Each take wipes its own Durable Object first, so runs are independent.
`;

const html = (text: string) =>
	`<!doctype html><meta charset="utf-8"><title>pi withBlobs demo</title><pre style="font:16px/1.5 ui-monospace,monospace;padding:24px">${text.replace(
		/(\/(?:before|after|reset)(?:\?enforce=2mb)?)/g,
		'<a href="$1">$1</a>',
	)}</pre>`;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const enforce = url.searchParams.get("enforce") === "2mb";
		if (url.pathname === "/") return new Response(html(HOME), { headers: { "content-type": "text/html; charset=utf-8" } });
		if (url.pathname === "/before" || url.pathname === "/after") {
			const mode = url.pathname.slice(1) as Mode;
			const stub = env.AGENT.getByName(`${mode}${enforce ? "-2mb" : ""}`);
			const report = await stub.run(mode, enforce);
			return new Response(`${JSON.stringify(report, null, 2)}\n`, {
				headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
			});
		}
		if (url.pathname === "/reset") {
			for (const name of ["before", "before-2mb", "after", "after-2mb"]) await env.AGENT.getByName(name).reset();
			let deleted = 0;
			for (let list = await env.BLOBS.list(); ; list = await env.BLOBS.list({ cursor: list.cursor })) {
				if (list.objects.length > 0) await env.BLOBS.delete(list.objects.map((o) => o.key));
				deleted += list.objects.length;
				if (!list.truncated) break;
			}
			return new Response(`Reset: 4 Durable Objects wiped, ${deleted} R2 objects deleted.\n`);
		}
		return new Response("not found\n", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
