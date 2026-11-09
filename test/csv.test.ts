import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/shared/csv';

describe('toCsv', () => {
  it('quotes commas, quotes, and newlines and leaves plain cells alone', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', 49]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",49\r\n');
  });

  it('writes empty cells for null and undefined', () => {
    expect(toCsv(['a', 'b', 'c'], [[null, undefined, 0]])).toBe('a,b,c\r\n,,0\r\n');
  });

  it('neutralizes cells a spreadsheet would run as formulas', () => {
    const out = toCsv(['detail'], [['=HYPERLINK("http://x")'], ['+1'], ['-2'], ['@SUM(A1)']]);
    expect(out).toBe('detail\r\n"\'=HYPERLINK(""http://x"")"\r\n\'+1\r\n\'-2\r\n\'@SUM(A1)\r\n');
  });
});
