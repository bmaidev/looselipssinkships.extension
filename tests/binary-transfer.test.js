const { toBase64, fromBase64 } = require('../lib/binary-transfer');

describe('bounded binary extension-message transport', () => {
  test('round-trips data across multiple encoding chunks', () => {
    const source = new Uint8Array(100_003);
    for (let index = 0; index < source.length; index++) source[index] = index % 251;
    const encoded = toBase64(source, source.length);
    expect(Array.from(fromBase64(encoded, source.length))).toEqual(Array.from(source));
  });

  test('respects typed-array offsets', () => {
    const source = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    expect(Array.from(fromBase64(toBase64(source, 3), 3))).toEqual([1, 2, 3]);
  });

  test('rejects empty and oversized input before encoding', () => {
    expect(() => toBase64(new Uint8Array(), 10)).toThrow(/safety limit/i);
    expect(() => toBase64(new Uint8Array(11), 10)).toThrow(/safety limit/i);
  });

  test('rejects malformed and oversized encoded input before allocation', () => {
    expect(() => fromBase64('not base64!', 100)).toThrow(/malformed|safety limit/i);
    expect(() => fromBase64('AAAA', 2)).toThrow(/safety limit/i);
  });
});
