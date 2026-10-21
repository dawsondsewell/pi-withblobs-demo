// Spike probe: the largest row each write kind hands Storage while code mode runs.
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineTool } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { type CodemodeGlobal, createCodemodeTool } from "../src/codemode/codemode.ts";
import { MemoryBlobStore, withBlobs } from "../src/storage/blobs/index.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import type { Storage } from "../src/types.ts";
import { chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";

/** Where the probe appends its measurements; set PROBE_LOG to move it. */
const PROBE_LOG = process.env.PROBE_LOG ?? "probe.log";
import { context } from "./session-support.ts";

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

function recording(inner: Storage) {
	const max = new Map<string, number>();
	const kinds = new Map<string, string>();
	const note = (what: string, size: number) => max.set(what, Math.max(max.get(what) ?? 0, size));
	const commit = inner.commit.bind(inner);
	inner.commit = (writes, commitContext) => {
		for (const write of writes) {
			if (write.type === "document.create") {
				kinds.set(String(write.record.id), write.record.kind);
				note(`${write.record.kind} base`, bytes(write.content.value));
			} else if (write.type === "document.change") {
				const kind = kinds.get(String(write.id)) ?? write.id;
				note(
					`${kind} ${write.content.kind}`,
					bytes(write.content.kind === "base" ? write.content.value : write.content.ops),
				);
			} else if (write.type !== "document.copy" && write.type !== "document.retire")
				note(write.type, bytes(write.value));
		}
		return commit(writes, commitContext);
	};
	return max;
}

async function run(code: string, storage: Storage, globals: CodemodeGlobal[] = []) {
	const setup = chatSetup();
	addTool(
		setup.registry,
		createCodemodeTool({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }), globals }),
	);
	addTool(
		setup.registry,
		defineTool({
			name: "img",
			description: "img",
			parameters: Type.Object({}),
			execute: async () => ({ output: [{ type: "image", data: "A".repeat(3_000_000), mimeType: "image/png" }] }),
		}),
	);
	setup.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const { harness, root } = await openChat(storage, setup);
	try {
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		return settled.status;
	} finally {
		await harness.close(context).catch(() => {});
	}
}

const cases: [string, string, CodemodeGlobal[]?][] = [
	["text output, max_output_tokens 1e6", '// @options: {"max_output_tokens": 1000000}\nreturn "é".repeat(2_000_000);'],
	[
		"store() at its 1 MiB total",
		'for (let i = 0; i < 4; i++) store(`k${i}`, "é".repeat(256 * 1024 - 64)); return "ok";',
	],
	[
		"host global returning 3 MB",
		'await big(); return "ok";',
		[{ name: "big", execute: async () => "x".repeat(3_000_000) }],
	],
	["nested tool returning a 3 MB image", 'await tools.img({}); return "ok";'],
];

for (const [name, code, globals] of cases) {
	it(`rows: ${name}`, { timeout: 60_000 }, async () => {
		const storage = new MemoryStorage();
		const max = recording(storage);
		const status = await run(code, storage, globals);
		const big = [...max].filter(([, size]) => size > 100_000).sort((a, b) => b[1] - a[1]);
		appendFileSync(
			PROBE_LOG,
			"\n" +
				`ROWS ${name} (${status}): ${big.map(([what, size]) => `${what}=${(size / 1e6).toFixed(2)}MB`).join(", ")}`,
		);
		const wrapped = withBlobs(new MemoryStorage(), new MemoryBlobStore());
		const blobbed = await run(code, wrapped, globals).catch(
			(error: Error) => `${error.name}: ${error.message} <- ${(error.cause as Error)?.message}`,
		);
		appendFileSync(
			PROBE_LOG,
			"\n" + `BLOBS ${name}: ${blobbed}`,
		);
		expect(status).toBeDefined();
	});
}
