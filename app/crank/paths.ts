/**
 * Path helpers for the crank.
 *
 * `expandHome` resolves a leading "~" in an operator-configured keypair path
 * against $HOME (Solana-CLI convention). Keypair paths come from env vars
 * (OPERATOR_KEYPAIR_PATH, CRANK_KEYPAIR_PATH, RANDOMNESS_KEYPAIR_PATH), so the
 * expansion must not allow a "~/.." path to traverse out of $HOME.
 */
import * as path from "path";

export function expandHome(
  filepath: string,
  home: string = process.env.HOME ?? "",
): string {
  if (!filepath.startsWith("~")) return filepath;
  // Strip the leading "~" and any path separators, then reject traversal.
  // We build the path by explicit concatenation (not path.join/resolve) so a
  // "~/.." segment cannot be normalized into an escape out of $HOME.
  const rest = filepath.slice(1).replace(/^[\\/]+/, "");
  if (rest.split(/[\\/]+/).some((seg) => seg === "..")) {
    throw new Error(
      `unsafe keypair path (path traversal not allowed): ${filepath}`,
    );
  }
  return rest ? `${home}${path.sep}${rest}` : home;
}
