import { describe, expect, it } from "vitest";
import { readLines } from "./client";
import { applyAskEvent, type AskLive } from "./hooks";
import type { AskEvent, AskStep } from "./types";

function bytes(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x) => c.enqueue(x));
      c.close();
    },
  });
}

const enc = (s: string) => new TextEncoder().encode(s);

async function lines(...chunks: Uint8Array[]) {
  const out: string[] = [];
  await readLines(bytes(...chunks), (l) => out.push(l));
  return out;
}

describe("readLines", () => {
  it("gives each line once, however the chunks fall", async () => {
    expect(await lines(enc('{"a":1}\n{"b"'), enc(':2}\n'), enc('{"c":3}\n'))).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("keeps a rupee sign whole when a chunk cuts through it", async () => {
    const all = enc("₹42 L\n");
    expect(await lines(all.slice(0, 1), all.slice(1))).toEqual(["₹42 L"]);
  });

  it("gives a last line that has no newline, and skips blank lines", async () => {
    expect(await lines(enc("one\n\n"), enc("two"))).toEqual(["one", "two"]);
  });
});

describe("applyAskEvent", () => {
  const start: AskLive = { stage: null, tool: null, text: "", steps: [], charts: [] };
  const step: AskStep = { tool: "execute_exasol_query", input: { query: "SELECT 42" }, result_preview: "42", is_error: false };
  const run = (...events: AskEvent[]) => events.reduce(applyAskEvent, start);

  it("adds the text as it is written", () => {
    expect(run({ type: "text", text: "42 " }, { type: "text", text: "companies." }).text).toBe("42 companies.");
  });

  it("drops text written before a tool call, because it is not the answer", () => {
    expect(run({ type: "text", text: "Let me check." }, { type: "reset" }).text).toBe("");
  });

  it("adds a chart as soon as it arrives", () => {
    const chart = { kind: "bar", title: "t", unit: "number", x_label: "X", categories: ["a"], series: [{ name: "Y", values: [1] }] } as const;
    const copy = { ...chart, categories: [...chart.categories], series: chart.series.map((s) => ({ ...s, values: [...s.values] })) };
    expect(run({ type: "chart", chart: copy }).charts).toEqual([copy]);
  });

  it("shows the tool while it runs and adds the step when it finishes", () => {
    const running = run({ type: "tool", tool: step.tool, input: step.input });
    expect(running.tool).toBe(step.tool);
    const after = applyAskEvent(running, { type: "step", step });
    expect(after.tool).toBeNull();
    expect(after.steps).toEqual([step]);
  });
});
