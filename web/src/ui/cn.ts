/** Join class fragments, skipping falsy values. The ui/ primitives keep their
 *  variant maps as flat objects of class strings — no CVA dependency. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
