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

/**
 * Render an array of numbers as a Unicode sparkline string.
 * Each value maps to one of 8 block-element characters, scaled relative to the max.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max === 0) return BLOCKS[0].repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.min(
        Math.floor((v / max) * (BLOCKS.length - 1)),
        BLOCKS.length - 1,
      );
      return BLOCKS[idx];
    })
    .join('');
}

/**
 * Render a simple horizontal bar chart.
 * Returns one string per data item: `${label} ${bar} ${count}`
 */
export function barChart(
  data: Array<{ label: string; count: number }>,
  maxWidth: number,
): string[] {
  const max = Math.max(...data.map((d) => d.count));
  return data.map((d) => {
    const barLen = max === 0 ? 0 : Math.round((d.count / max) * maxWidth);
    const bar = '\u2588'.repeat(barLen);
    return `${d.label} ${bar} ${d.count}`;
  });
}
