import { describe, expect, it } from "vitest";
import { percentile } from "../src/stats";

describe("percentile", () => {
  it("uses nearest rank", () => {
    const v = [5, 1, 4, 2, 3];
    expect(percentile(v, 50)).toBe(3);
    expect(percentile(v, 95)).toBe(5);
    expect(percentile(v, 0)).toBe(1);
  });

  it("is NaN for no data", () => {
    expect(percentile([], 50)).toBeNaN();
  });
});
