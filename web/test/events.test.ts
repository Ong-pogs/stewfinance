import { describe, it, expect } from "vitest";
import { parseEventLine, readRef } from "../lib/events";

describe("parseEventLine", () => {
  it("parses a valid JSON line", () => {
    expect(parseEventLine('{"event":"visit"}')).toEqual({ event: "visit" });
  });

  it("returns null for a blank line", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   ")).toBeNull();
  });

  it("returns null (skips) for a malformed line instead of throwing", () => {
    expect(parseEventLine("{ not json")).toBeNull();
  });

  it("a malformed line in a sequence does not drop later valid lines", () => {
    const lines = [
      '{"event":"a"}',
      "{ broken",
      '{"event":"b"}',
    ];
    const parsed = lines.map(parseEventLine).filter((r) => r !== null);
    expect(parsed).toEqual([{ event: "a" }, { event: "b" }]);
  });
});

describe("readRef", () => {
  it("reads the ref from the nested shape track() actually stores", () => {
    // track("referral_deposit", { wallet, props: { ref } }) -> row.props = { wallet, props: { ref } }
    const row = { props: { wallet: "W", props: { ref: "alice" } } };
    expect(readRef(row)).toBe("alice");
  });

  it("reads the ref from a flat shape", () => {
    expect(readRef({ props: { ref: "bob" } })).toBe("bob");
  });

  it("returns undefined when no ref is present", () => {
    expect(readRef({ props: { wallet: "W" } })).toBeUndefined();
    expect(readRef({})).toBeUndefined();
    expect(readRef(null)).toBeUndefined();
  });
});
