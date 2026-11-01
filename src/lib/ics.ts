/** RFC 5545 helpers for the calendar feed. */

/** Escape TEXT values; CR/LF of any form become a literal "\n". */
export function escapeIcsText(s: string): string {
  return (
    s
      .replace(/\\/g, "\\\\")
      .replace(/\r\n|\r|\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;")
      // Strip remaining control chars (except TAB) which are invalid in TEXT.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
  );
}

const enc = new TextEncoder();

/**
 * Fold a content line so no physical line exceeds 75 octets (UTF-8 bytes),
 * never splitting a multi-byte character. Continuation lines start with a
 * single space, which counts toward their 75 octets.
 */
export function foldIcsLine(line: string): string {
  if (enc.encode(line).byteLength <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).byteLength;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = " ";
      curBytes = 1;
      limit = 75;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n");
}
