import { describe, expect, it } from "vitest";
import { formatLength, lengthWarning, reportableLength } from "../src/lengths";

describe("reportableLength", () => {
  it("rounds a known length to a tenth of a second", () => {
    expect(reportableLength(5421.333)).toBe(5421.3);
  });

  it("reports 0 for a length that isn't known or has no end", () => {
    expect(reportableLength(NaN)).toBe(0);
    expect(reportableLength(Infinity)).toBe(0);
    expect(reportableLength(0)).toBe(0);
    expect(reportableLength(2_000_000)).toBe(0);
  });
});

describe("formatLength", () => {
  it("shows hours only when there are some", () => {
    expect(formatLength(245)).toBe("4:05");
    expect(formatLength(3723)).toBe("1:02:03");
    expect(formatLength(59.6)).toBe("1:00");
  });
});

describe("lengthWarning", () => {
  const ryan = { clientId: "ryan", name: "Ryan" };
  const sam = { clientId: "sam", name: "Sam" };
  const kim = { clientId: "kim", name: "Kim" };

  it("says nothing when the lengths match within the tolerance", () => {
    expect(
      lengthWarning(
        [
          { ...ryan, duration: 5400 },
          { ...sam, duration: 5401.5 },
        ],
        "ryan",
      ),
    ).toBeNull();
  });

  it("says nothing until two lengths are known", () => {
    expect(
      lengthWarning([{ ...ryan, duration: 5400 }, sam, kim], "ryan"),
    ).toBeNull();
  });

  it("names everyone's length when they differ", () => {
    expect(
      lengthWarning(
        [{ ...ryan, duration: 5400 }, { ...sam, duration: 5280 }, kim],
        "ryan",
      ),
    ).toBe(
      "Videos differ in length (You 1:30:00, Sam 1:28:00). You may not be watching the same thing.",
    );
  });
});
