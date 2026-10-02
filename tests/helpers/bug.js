import { it } from "vitest";

/**
 * A test for a CONFIRMED bug. It asserts the correct behaviour, so today the
 * assertion fails — `it.fails` turns that into a pass and keeps the suite
 * green. When the bug is fixed the test goes red: replace `bug(` with `it(`.
 *
 * `SHOW_BUGS=1 npm test` runs these as ordinary tests instead, so every known
 * bug is listed with its actual-vs-expected diff.
 */
export const bug = process.env.SHOW_BUGS ? it : it.fails;
