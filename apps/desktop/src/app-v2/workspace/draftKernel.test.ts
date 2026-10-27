import { expect, it } from "vitest";
import { DraftKernel, nextEditSeq } from "./draftKernel";

it("orders one entity's journal without reserving another entity or a formal mutation", async () => {
  const kernel = new DraftKernel(), events: string[] = [];
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const first = kernel.enqueue("entry-a", async () => { events.push("a1"); await waiting; events.push("a1-ack"); });
  const second = kernel.enqueue("entry-a", async () => { events.push("a2"); });
  await kernel.enqueue("entry-b", async () => { events.push("b1"); });
  expect(events).toEqual(["a1", "b1"]);
  const token = kernel.reserve(); expect(token).not.toBeNull(); expect(kernel.reserve()).toBeNull();
  kernel.release(Symbol("another owner")); expect(kernel.owns(token!)).toBe(true);
  finish(); await Promise.all([first, second]);
  expect(events).toEqual(["a1", "b1", "a1-ack", "a2"]);
  kernel.release(token!); expect(kernel.reserved).toBe(false);
});

it("allows an explicit operation after failure but retires queued operations before dispatch", async () => {
  const kernel = new DraftKernel();
  await expect(kernel.enqueue("entry", async () => { throw new Error("Disk unavailable"); })).rejects.toThrow("Disk unavailable");
  expect(await kernel.enqueue("entry", async () => "explicit retry")).toBe("explicit retry");
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = kernel.enqueue("entry", () => waiting);
  const queued = kernel.enqueue("entry", async () => { throw new Error("Must not dispatch"); });
  const rejected = expect(queued).rejects.toThrow("Draft owner has retired");
  kernel.retire(); release(); await running.catch(() => undefined); await rejected;
  expect(kernel.reserve()).toBeNull();
  expect(nextEditSeq("9007199254740993")).toBe("9007199254740994");
});
