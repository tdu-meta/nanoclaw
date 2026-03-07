/** Terminal layout engine with ANSI rendering utilities. */

export enum Color {
  Red = '31',
  Green = '32',
  Yellow = '33',
  Blue = '34',
  Cyan = '36',
  Gray = '90',
  White = '37',
  Bold = '1',
  Dim = '2',
}

/** Wraps text in ANSI escape codes. */
export function colorize(text: string, ...codes: Color[]): string {
  return `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

/** Strips ANSI escape sequences to get visible length. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Pads text with spaces to width, or truncates if longer. */
export function padRight(text: string, width: number): string {
  const visible = stripAnsi(text);
  if (visible.length > width) {
    // Truncate: for plain text just slice; for ANSI text, build up char-by-char
    if (text === visible) return text.slice(0, width);
    // ANSI-aware truncation
    let count = 0;
    let result = '';
    // eslint-disable-next-line no-control-regex
    const parts = text.split(/(\x1b\[[0-9;]*m)/);
    for (const part of parts) {
      if (part.startsWith('\x1b[')) {
        result += part;
      } else {
        const remaining = width - count;
        if (remaining <= 0) break;
        result += part.slice(0, remaining);
        count += Math.min(part.length, remaining);
      }
    }
    return result;
  }
  const padding = width - visible.length;
  return text + ' '.repeat(padding);
}

/** Wraps content lines in a box with box-drawing characters. */
export function box(title: string, lines: string[], width: number): string[] {
  const innerWidth = width - 2; // subtract left and right border chars
  const colorTitle = colorize(title, Color.Bold);
  const titleVisible = title.length;
  const topFill = Math.max(0, innerWidth - titleVisible - 2); // 2 for spaces around title
  const topLine =
    '\u250c' +
    '\u2500' +
    colorTitle +
    '\u2500' +
    '\u2500'.repeat(topFill) +
    '\u2510';

  const bottomLine = '\u2514' + '\u2500'.repeat(innerWidth) + '\u2518';

  const result: string[] = [topLine];
  for (const line of lines) {
    result.push('\u2502' + padRight(line, innerWidth) + '\u2502');
  }
  result.push(bottomLine);
  return result;
}

/** Merges two column arrays side by side. */
export function sideBySide(
  leftLines: string[],
  rightLines: string[],
  leftWidth: number,
  rightWidth: number,
): string[] {
  const maxLen = Math.max(leftLines.length, rightLines.length);
  const result: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const left = padRight(leftLines[i] ?? '', leftWidth);
    const right = padRight(rightLines[i] ?? '', rightWidth);
    result.push(left + right);
  }
  return result;
}

/** Returns ANSI sequence to clear screen and move cursor home. */
export function clearScreen(): string {
  return '\x1b[2J\x1b[H';
}

/** Returns ANSI sequence to hide cursor. */
export function hideCursor(): string {
  return '\x1b[?25l';
}

/** Returns ANSI sequence to show cursor. */
export function showCursor(): string {
  return '\x1b[?25h';
}
