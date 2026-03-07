import { describe, it, expect } from 'vitest';

import {
  Color,
  colorize,
  padRight,
  box,
  sideBySide,
  clearScreen,
  hideCursor,
  showCursor,
} from './layout.js';

// --- colorize ---

describe('colorize', () => {
  it('wraps text in ANSI escape codes', () => {
    const result = colorize('hello', Color.Red);
    expect(result).toContain('\x1b[');
    expect(result).toContain('\x1b[0m');
    expect(result).toContain('hello');
  });

  it('applies multiple codes', () => {
    const result = colorize('test', Color.Bold, Color.Green);
    expect(result).toBe('\x1b[1;32mtest\x1b[0m');
  });

  it('handles single code', () => {
    const result = colorize('x', Color.Cyan);
    expect(result).toBe('\x1b[36mx\x1b[0m');
  });
});

// --- padRight ---

describe('padRight', () => {
  it('pads short text to width', () => {
    const result = padRight('hi', 5);
    expect(result).toBe('hi   ');
    expect(result.length).toBe(5);
  });

  it('truncates text longer than width', () => {
    const result = padRight('hello world', 5);
    expect(result).toBe('hello');
    expect(result.length).toBe(5);
  });

  it('returns text unchanged when exact width', () => {
    const result = padRight('abc', 3);
    expect(result).toBe('abc');
  });

  it('handles zero width', () => {
    const result = padRight('hello', 0);
    expect(result).toBe('');
  });
});

// --- box ---

describe('box', () => {
  it('wraps content in box-drawing characters', () => {
    const lines = box('Title', ['line one', 'line two'], 30);
    const joined = lines.join('\n');

    // Top border with horizontal line chars
    expect(joined).toContain('\u2500');
    // Title present
    expect(joined).toContain('Title');
    // Content present
    expect(joined).toContain('line one');
    expect(joined).toContain('line two');
    // Box corners
    expect(lines[0]).toContain('\u250c');
    expect(lines[0]).toContain('\u2510');
    // Side borders
    expect(lines[1]).toContain('\u2502');
    // Bottom border
    expect(lines[lines.length - 1]).toContain('\u2514');
    expect(lines[lines.length - 1]).toContain('\u2518');
  });

  it('handles empty content', () => {
    const lines = box('Empty', [], 20);
    expect(lines.length).toBe(2); // top + bottom only
    expect(lines[0]).toContain('\u250c');
    expect(lines[1]).toContain('\u2514');
  });

  it('handles ANSI-colored content without breaking alignment', () => {
    const colored = colorize('hi', Color.Red);
    const lines = box('Test', [colored], 20);
    // The side borders should still be present
    expect(lines[1]).toContain('\u2502');
    // The colored text should be inside
    expect(lines[1]).toContain(colored);
  });
});

// --- sideBySide ---

describe('sideBySide', () => {
  it('merges two column arrays side by side', () => {
    const left = ['aaa', 'bbb'];
    const right = ['111', '222'];
    const result = sideBySide(left, right, 5, 5);
    expect(result.length).toBe(2);
    expect(result[0]).toContain('aaa');
    expect(result[0]).toContain('111');
  });

  it('pads shorter column with empty lines', () => {
    const left = ['a'];
    const right = ['1', '2', '3'];
    const result = sideBySide(left, right, 5, 5);
    expect(result.length).toBe(3);
  });
});

// --- terminal control sequences ---

describe('terminal control', () => {
  it('clearScreen returns correct sequence', () => {
    expect(clearScreen()).toBe('\x1b[2J\x1b[H');
  });

  it('hideCursor returns correct sequence', () => {
    expect(hideCursor()).toBe('\x1b[?25l');
  });

  it('showCursor returns correct sequence', () => {
    expect(showCursor()).toBe('\x1b[?25h');
  });
});
