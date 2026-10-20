// Splits a document into overlapping chunks for search.
//
// Text is split into paragraphs (blank lines), lines, then sentences
// (Intl.Segmenter), and sentences are packed greedily into chunks of at most
// maxWords words. A chunk never ends mid-sentence, except when a single
// sentence is longer than maxWords on its own; such a sentence is split by
// words. Each new chunk starts with the last sentences of the previous chunk
// (up to overlapWords words), so context spanning a boundary is not lost.
//
// "Words" are whitespace-separated tokens, i.e. syllables for Vietnamese.
// Sentence detection is ICU's generic rules: abbreviations such as "TP." may
// end a sentence early. That only shifts where a chunk may break; no text is
// lost.

export interface ChunkOptions {
  /** Maximum words per chunk. */
  maxWords: number;
  /** Maximum words repeated from the end of the previous chunk. */
  overlapWords: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxWords: 250, overlapWords: 40 };

type Separator = '\n\n' | '\n' | ' ';

interface Sentence {
  text: string;
  words: number;
  /** Placed before this sentence when it is not the first one in a chunk. */
  separator: Separator;
}

const segmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });

export function chunkText(text: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): string[] {
  const { maxWords, overlapWords } = options;
  if (!(maxWords > 0 && overlapWords >= 0 && overlapWords < maxWords)) {
    throw new RangeError('chunkText requires 0 <= overlapWords < maxWords');
  }

  const chunks: string[] = [];
  let current: Sentence[] = [];
  let currentWords = 0;

  for (const sentence of splitSentences(text, maxWords)) {
    if (current.length > 0 && currentWords + sentence.words > maxWords) {
      chunks.push(render(current));
      // The overlap must leave room for the sentence that did not fit.
      current = overlapTail(current, Math.min(overlapWords, maxWords - sentence.words));
      currentWords = current.reduce((sum, s) => sum + s.words, 0);
    }
    current.push(sentence);
    currentWords += sentence.words;
  }
  if (current.length > 0) chunks.push(render(current));
  return chunks;
}

function splitSentences(text: string, maxWords: number): Sentence[] {
  const sentences: Sentence[] = [];
  const paragraphs = text.normalize('NFC').replace(/\r\n?/g, '\n').split(/\n\s*\n/);

  for (const paragraph of paragraphs) {
    let separator: Separator = '\n\n';
    for (const line of paragraph.split('\n')) {
      const clean = line.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      for (const { segment } of segmenter.segment(clean)) {
        const sentence = segment.trim();
        if (!sentence) continue;
        for (const piece of splitLongSentence(sentence, maxWords)) {
          sentences.push({ text: piece, words: countWords(piece), separator });
          separator = ' ';
        }
      }
      // The next non-empty line of this paragraph starts on a new line.
      if (separator === ' ') separator = '\n';
    }
  }
  return sentences;
}

function splitLongSentence(sentence: string, maxWords: number): string[] {
  const words = sentence.split(' ');
  if (words.length <= maxWords) return [sentence];
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) pieces.push(words.slice(i, i + maxWords).join(' '));
  return pieces;
}

/** The longest run of trailing sentences that fits in `budget` words. */
function overlapTail(chunk: Sentence[], budget: number): Sentence[] {
  const tail: Sentence[] = [];
  let words = 0;
  for (let i = chunk.length - 1; i >= 0; i--) {
    const sentence = chunk[i]!;
    if (words + sentence.words > budget) break;
    tail.unshift(sentence);
    words += sentence.words;
  }
  return tail;
}

function render(sentences: Sentence[]): string {
  return sentences.map((s, i) => (i === 0 ? s.text : s.separator + s.text)).join('');
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
