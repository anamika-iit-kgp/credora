import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CodeBlock", () => {
  it("copies the code exactly as it is, whatever the screen wraps", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const code = `EXPLAIN VIRTUAL\nSELECT ${Array.from({ length: 60 }, (_, i) => `"T"."C${i}"`).join(", ")}\n  FROM "CBS"."TXN" "T"`;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<CodeBlock code={code} lang="sql" />));
    const copy = [...host.querySelectorAll("button")].find((b) => b.textContent === "Copy");
    await act(async () => {
      copy?.click();
    });
    expect(writeText).toHaveBeenCalledWith(code);
    act(() => root.unmount());
    host.remove();
  });
});
