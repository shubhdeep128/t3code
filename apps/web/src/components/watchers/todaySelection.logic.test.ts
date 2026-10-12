import { describe, expect, it } from "vite-plus/test";

import { selectionAfterLeaving } from "./todaySelection.logic";

describe("selectionAfterLeaving", () => {
  it("moves to the next row when the selected row leaves", () => {
    expect(selectionAfterLeaving(["a", "b", "c", "d"], "b", ["a", "c", "d"])).toBe("c");
  });

  it("skips rows that left at the same time", () => {
    expect(selectionAfterLeaving(["a", "b", "c", "d"], "b", ["a", "d"])).toBe("d");
  });

  it("moves up when the last row leaves", () => {
    expect(selectionAfterLeaving(["a", "b", "c"], "c", ["a", "b"])).toBe("b");
  });

  it("keeps the next row when rows above it move groups", () => {
    expect(selectionAfterLeaving(["a", "b", "c", "d"], "b", ["c", "d", "a"])).toBe("c");
  });

  it("falls back to the first row when no earlier neighbor remains", () => {
    expect(selectionAfterLeaving(["a", "b"], "b", ["x", "y"])).toBe("x");
    expect(selectionAfterLeaving(["a"], "a", [])).toBeNull();
  });
});
