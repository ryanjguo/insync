import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "../src";

interface Case {
  name: string;
  direction: "client" | "server";
  valid: boolean;
  message: unknown;
}

const cases: Case[] = JSON.parse(
  readFileSync(new URL("../testdata/cases.json", import.meta.url), "utf8"),
);

// The same file drives the Go tests in server/internal/protocol, so both sides
// agree on what's valid.
describe("shared protocol cases", () => {
  it.each(cases)("$direction: $name", ({ direction, valid, message }) => {
    const parse =
      direction === "client" ? parseClientMessage : parseServerMessage;
    const result = parse(JSON.stringify(message));
    if (!result.ok && valid) expect.fail(result.error);
    expect(result.ok).toBe(valid);
  });
});
