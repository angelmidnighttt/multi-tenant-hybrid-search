import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkText, countWords } from '../../src/documents/chunker.ts';

const SMALL = { maxWords: 20, overlapWords: 6 };

/** A sentence of exactly 6 words. */
const sentence = (n: number) => `Câu ${n} có đúng sáu từ.`;
const sentences = (count: number) => Array.from({ length: count }, (_, i) => sentence(i + 1));
const SENTENCE_RE = /Câu (\d+) có đúng sáu từ\./g;
const numbersIn = (chunk: string) => [...chunk.matchAll(SENTENCE_RE)].map((m) => Number(m[1]));

describe('chunkText', () => {
  it('returns short text as a single chunk', () => {
    assert.deepEqual(chunkText('Xin chào. Đây là một tài liệu ngắn.'), ['Xin chào. Đây là một tài liệu ngắn.']);
  });

  it('returns no chunks for empty or blank text', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText(' \n\n \t '), []);
  });

  it('never exceeds maxWords', () => {
    for (const chunk of chunkText(sentences(30).join(' '), SMALL)) {
      assert.ok(countWords(chunk) <= SMALL.maxWords, `${countWords(chunk)} words: ${chunk}`);
    }
  });

  it('never cuts a sentence', () => {
    const whole = /^Câu \d+ có đúng sáu từ\.( Câu \d+ có đúng sáu từ\.)*$/;
    for (const chunk of chunkText(sentences(30).join(' '), SMALL)) assert.match(chunk, whole);
  });

  it('covers every sentence, in order', () => {
    const seen = chunkText(sentences(30).join(' '), SMALL).flatMap(numbersIn);
    assert.deepEqual([...new Set(seen)], Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('starts each chunk with the end of the previous one', () => {
    const chunks = chunkText(sentences(30).join(' '), SMALL).map(numbersIn);
    assert.ok(chunks.length > 1);
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i]![0], chunks[i - 1]!.at(-1), `chunk ${i} does not overlap chunk ${i - 1}`);
    }
  });

  it('keeps paragraph and line breaks, normalizing whitespace', () => {
    assert.equal(chunkText('Một.   Hai.\n\n\nBa.\r\nBốn.')[0], 'Một. Hai.\n\nBa.\nBốn.');
  });

  it('splits a sentence longer than maxWords by words, losing nothing', () => {
    const words = Array.from({ length: 50 }, (_, i) => `từ${i}`);
    const chunks = chunkText(words.join(' '), SMALL);
    for (const chunk of chunks) assert.ok(countWords(chunk) <= SMALL.maxWords);
    assert.deepEqual(chunks.join(' ').split(' '), words);
  });

  it('normalizes decomposed (NFD) text to NFC', () => {
    assert.equal(chunkText('Học sinh'.normalize('NFD'))[0], 'Học sinh'.normalize('NFC'));
  });

  it('uses about 250 words per chunk by default', () => {
    const chunks = chunkText(sentences(200).join(' ')); // 1200 words
    assert.ok(chunks.length >= 5 && chunks.length <= 7, `${chunks.length} chunks`);
    for (const chunk of chunks) assert.ok(countWords(chunk) <= 250);
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    assert.throws(() => chunkText('x', { maxWords: 10, overlapWords: 10 }), RangeError);
  });
});
