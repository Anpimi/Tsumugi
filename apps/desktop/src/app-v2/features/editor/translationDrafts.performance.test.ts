import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DraftBasis, DraftHead, DraftKey, DraftReadView, DraftValue } from "../../../draftCommands";
import fixture from "../../../../test/fixtures/translation-commands.json";
import { TranslationDrafts, type TranslationDraftPorts } from "./translationDrafts";

const basis: DraftBasis = { sourceRevisionId: fixture.save.sourceRevisionId, selectionId: null, revisionId: null, text: null };
const writerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

it.skipIf(process.env.TSUMUGI_MEASURE_DRAFTS !== "1")("measures continuous editing with one and two thousand loaded retained drafts", async () => {
  for (const count of [1, 2000]) {
    const keys: DraftKey[] = Array.from({ length: count }, (_, index) => ({ projectId: fixture.save.projectId,
      unitId: `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`, locale: "zh-CN" }));
    const text = "A long retained draft {{name}} 世界 👩🏽‍💻 e\u0301\n".repeat(40);
    const heads = new Map<string, DraftHead>(keys.map(key => [key.unitId, { key, revision: "1", writerId, value: {
      basis: structuredClone(basis), text, editSeq: "1", pending: null,
    } } satisfies DraftHead]));
    const view = (key: DraftKey): DraftReadView => ({ head: structuredClone(heads.get(key.unitId)!), current: {
      kind: "current", basis: structuredClone(basis), nativeKey: key.unitId, sourceText: "Source {{name}} 世界",
    } });
    const ports: Partial<TranslationDraftPorts> = {
      writerId: () => writerId,
      list: async request => {
        const start = request.after ? keys.findIndex(key => key.unitId === request.after!.unitId) + 1 : 0;
        const page = keys.slice(start, start + request.limit);
        return { items: page.map(key => ({ key, revision: "1", editSeq: "1", sourceRevisionId: basis.sourceRevisionId, hasPending: false })),
          next: start + page.length < keys.length ? page.at(-1)! : null };
      },
      read: async request => view(request.key),
      readMany: async request => ({ items: request.unitIds.map(unitId => view({ ...keys[0], unitId })), nextAfter: null }),
      write: async request => {
        const previous = heads.get(request.write.key.unitId)!;
        expect(request.write.expectedRevision).toBe(previous.revision);
        const head: DraftHead = { key: previous.key, revision: (BigInt(previous.revision) + 1n).toString(),
          writerId: request.write.writerId, value: structuredClone(request.write.value) as DraftValue };
        heads.set(head.key.unitId, head);
        return structuredClone(head);
      },
    };
    const owner = new TranslationDrafts({ context: { projectId: fixture.save.projectId, sessionToken: "synthetic-performance-session" },
      reads: { invalidate: () => {} }, ports });
    const loadStarted = performance.now();
    expect(await owner.initialize()).toBe(true);
    for (let offset = 0; offset < keys.length; offset += 50) {
      expect((await owner.openMany(keys.slice(offset, offset + 50))).every(Boolean)).toBe(true);
    }
    const loadMs = performance.now() - loadStarted;
    expect(owner.getSnapshot().summaries).toHaveLength(count);
    let notifications = 0;
    const unsubscribe = owner.subscribe(() => { notifications++; });
    const editsMs: number[] = [], flushMs: number[] = [];
    for (let index = 0; index < 100; index++) {
      const started = performance.now();
      expect(owner.edit(keys[0], `${text}Input ${index} 世界 👩🏽‍💻 e\u0301`)).toBe(true);
      editsMs.push(performance.now() - started);
      const flushing = performance.now();
      expect(await owner.flush(keys[0])).toBe(true);
      flushMs.push(performance.now() - flushing);
    }
    const latest = owner.getEntry(keys[0])!;
    expect(latest.value?.text).toBe(`${text}Input 99 世界 👩🏽‍💻 e\u0301`);
    expect(latest.value?.editSeq).toBe("101");
    expect(latest.journalPending).toBe(false);
    expect(heads.get(keys[0].unitId)?.value).toEqual(latest.value);
    if (keys.length > 1) expect(heads.get(keys[1].unitId)?.value?.text).toBe(text);
    const report = { operation: "retained_draft_owner", count, draftTextBytes: new TextEncoder().encode(text).length,
      loadMs, editsMs, flushMs, notifications, scope: "owner and memory-backed journal ports; excludes React, paint, native IPC and disk" };
    console.info(JSON.stringify(report));
    if (process.env.TSUMUGI_PERFORMANCE_OUTPUT) writeFileSync(join(process.env.TSUMUGI_PERFORMANCE_OUTPUT,
      `${process.env.TSUMUGI_PERFORMANCE_LABEL ?? "draft-owner"}-${count}.json`), JSON.stringify(report) + "\n", { flag: "wx" });
    unsubscribe();
    owner.retire();
  }
}, 60_000);
