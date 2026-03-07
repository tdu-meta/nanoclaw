import { describe, it, expect } from 'vitest';

import { sparkline, barChart } from './charts.js';

const BLOCKS = [
  '\u2581',
  '\u2582',
  '\u2583',
  '\u2584',
  '\u2585',
  '\u2586',
  '\u2587',
  '\u2588',
];

describe('sparkline', () => {
  it('renders values as block chars scaled to max', () => {
    // 8 evenly spaced values from 1..8 should map to the 8 block elements in order
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = sparkline(values);
    expect(result.length).toBe(8);
    expect(result[0]).toBe(BLOCKS[0]); // lowest
    expect(result[7]).toBe(BLOCKS[7]); // highest
  });

  it('returns empty string for empty array', () => {
    expect(sparkline([])).toBe('');
  });

  it('returns lowest blocks for all zeros', () => {
    const result = sparkline([0, 0, 0]);
    expect(result).toBe(BLOCKS[0].repeat(3));
  });
});

describe('barChart', () => {
  it('renders labeled bars with highest count having longest bar', () => {
    const data = [
      { label: 'alpha', count: 10 },
      { label: 'beta', count: 5 },
      { label: 'gamma', count: 20 },
    ];
    const lines = barChart(data, 20);
    expect(lines).toHaveLength(3);

    // Each line should contain label and count
    expect(lines[0]).toContain('alpha');
    expect(lines[0]).toContain('10');
    expect(lines[2]).toContain('gamma');
    expect(lines[2]).toContain('20');

    // gamma (highest) should have the longest bar
    const barLength = (line: string) => (line.match(/\u2588/g) || []).length;
    expect(barLength(lines[2])).toBeGreaterThan(barLength(lines[1]));
    expect(barLength(lines[2])).toBeGreaterThan(barLength(lines[0]));
    // The highest bar should fill maxWidth
    expect(barLength(lines[2])).toBe(20);
  });
});
