/**
 * Unit tests for the crank keypair-path expansion (app/crank/paths.ts).
 * Captures the path-traversal flagged by semgrep at run.ts (path-join-resolve-traversal):
 * a "~/.." keypair path must NOT escape $HOME.
 *
 * Pure unit test — no RPC / validator needed. Run:
 *   yarn ts-mocha -p ./tsconfig.json tests/paths.ts
 */
import { expect } from "chai";
import * as path from "path";
import { expandHome } from "../app/crank/paths";

const HOME = "/Users/testuser";

describe("expandHome — crank keypair path expansion", () => {
  it("expands a normal ~ keypair path under HOME", () => {
    expect(expandHome("~/.config/solana/id.json", HOME)).to.equal(
      `${HOME}/.config/solana/id.json`,
    );
  });

  it("returns a non-~ path unchanged", () => {
    expect(expandHome("/abs/keypair.json", HOME)).to.equal("/abs/keypair.json");
  });

  it("does NOT let a ~ path traverse out of HOME (path traversal)", () => {
    // The whole bug: a config/env-supplied '~/..' path must stay inside HOME.
    let out: string;
    try {
      out = expandHome("~/../../../../../../etc/passwd", HOME);
    } catch {
      return; // throwing on traversal is an acceptable safe outcome
    }
    expect(
      out === HOME || out.startsWith(HOME + path.sep),
      `keypair path escaped HOME: ${out}`,
    ).to.equal(true);
  });
});
