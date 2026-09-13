/**
 * Telephone numbers, written the way they are dialled and read the way they
 * are written.
 *
 * Two separate problems, and they are usually confused with each other.
 *
 * **How it is written.** An international number can arrive as `00905369130260`
 * or `+905369130260`; they mean the same thing and only one of them is a
 * number a phone will dial from anywhere. The leading `00` is an exit code that
 * belongs to whichever country you happen to be standing in, so it is replaced
 * with the `+` that means "wherever you are".
 *
 * **How it is displayed.** A number is left-to-right in every language on
 * earth. Arabic and Hebrew reverse the *order of the run*, not the digits, and
 * a `+` at the start of that run is a neutral character — so in an Arabic
 * sentence the browser will happily place it at the visual end, turning
 * `+905369130260` into something that reads as `905369130260+` and dials
 * wrong when somebody copies it. `formatPhone` returns the text; putting it in
 * an isolated left-to-right run is the caller's job, and the front end has
 * `phoneNode()` for exactly that.
 */

/**
 * `00905369130260` → `+905369130260`. Anything already correct is left alone,
 * and anything that is not a number at all is returned untouched: a restaurant
 * that typed "call the shop" gets to keep that.
 */
export function formatPhone(input: string | null | undefined): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';

  // Spaces, dashes and brackets are how people write numbers to each other;
  // they are kept, because a number a person can read is worth more than a
  // number a machine can parse. Only the prefix is rewritten.
  const withoutExitCode = trimmed.replace(/^00(?=\d)/, '+');

  // A lone `+` in the middle, or a `+` after digits, is somebody's typo or a
  // extension separator. Only a leading one is meaningful.
  return withoutExitCode;
}

/** Just the digits, for a `tel:` or `wa.me` link. */
export function phoneDigits(input: string | null | undefined): string {
  return (input ?? '').replace(/[^\d]/g, '');
}
