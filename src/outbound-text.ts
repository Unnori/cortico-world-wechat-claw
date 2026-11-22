import { latexToUnicode, looksLikeMath } from './latex.ts';

const CODE_FENCE = /^(?: {0,3}(?:> ?)*|[ \t]*)(?:[-+*][ \t]+|\d{1,9}[.)][ \t]+)?(\x60{3,}|~{3,})([^\r\n]*)/gm;
const INLINE_CODE = /\x60+/g;
const LIST_ITEM = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)(\S.*)$/;
const PROTECTED = '\uE000';

interface Span {
  start: number;
  end: number;
}

function escaped(text: string, at: number): boolean {
  let before = at;
  while (text[before - 1] === '\\') before -= 1;
  return (at - before) % 2 === 1;
}

function codeSpans(text: string): Span[] {
  const fences: Span[] = [];
  for (const match of text.matchAll(CODE_FENCE)) {
    const start = match.index;
    if (start < (fences.at(-1)?.end ?? 0)) continue;
    const marker = match[1]!;
    if (marker[0] === '\x60' && match[2]!.includes('\x60')) continue;
    const close = new RegExp('^[ \\t]*(?:> ?)*' + marker[0] + '{' + marker.length + ',}[ \\t]*(?=\\r?$)', 'gm');
    close.lastIndex = start + match[0].length;
    const closing = close.exec(text);
    fences.push({ start, end: closing ? closing.index + closing[0].length : text.length });
  }

  const spans: Span[] = [];
  let cursor = 0;
  for (const fence of [...fences, { start: text.length, end: text.length }]) {
    const runs = Array.from(text.slice(cursor, fence.start).matchAll(INLINE_CODE));
    const closingByLength = new Map<number, number>();
    const closings = runs.map(() => -1);
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const run = runs[i]![0];
      const next = runs[i + 1];
      if (next && /\n[ \t\r]*\n/.test(text.slice(cursor + runs[i]!.index + run.length, cursor + next.index))) {
        closingByLength.clear();
      }
      closings[i] = closingByLength.get(run.length) ?? -1;
      closingByLength.set(run.length, i);
    }
    for (let i = 0; i < runs.length; i += 1) {
      const start = cursor + runs[i]!.index;
      const closing = runs[closings[i]!];
      if (!closing || escaped(text, start)) continue;
      spans.push({ start, end: cursor + closing.index + closing[0].length });
      i = closings[i]!;
    }
    if (fence.start < fence.end) spans.push(fence);
    cursor = fence.end;
  }
  return spans;
}

function maskSpans(text: string, spans: readonly Span[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end } of spans) {
    parts.push(text.slice(cursor, start), text.slice(start, end).replace(/[^\n]/g, PROTECTED));
    cursor = end;
  }
  return parts.join('') + text.slice(cursor);
}

const indentWidth = (indent: string) => indent.replace(/\t/g, '    ').length;

function flattenLists(text: string): string {
  const source = text.split('\n');
  const masked = maskSpans(text, codeSpans(text)).split('\n');
  const output: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    let line = source[i]!;
    const item = LIST_ITEM.exec(masked[i]!.trimEnd());
    if (item) {
      const base = indentWidth(item[1]!);
      const width = item[0].length - item[3]!.length - item[1]!.length;
      let joiner = /[：:]\s*(?:\*\*|__)?\s*$/.test(line) ? ' ' : '：';
      for (let next = i + 1; next < source.length; next += 1) {
        const visible = masked[next]!;
        const trimmed = visible.trimStart();
        if (!trimmed) {
          joiner = joiner === '：' ? joiner : '　';
          continue;
        }
        const indent = indentWidth(visible.slice(0, visible.length - trimmed.length));
        if (indent <= base || indent >= base + width + 4 ||
            LIST_ITEM.test(visible) || /^(?:>|#{1,6}\s|---\s*$)/.test(trimmed)) break;
        line = line.trimEnd() + joiner + source[next]!.trim();
        i = next;
        joiner = ' ';
      }
    }
    output.push(line);
  }
  return output.join('\n');
}

function mathInText(text: string, pieces: string[], boundaries: string[]): void {
  const delimiters = Array.from(text.matchAll(/\$+/g)).filter(match => !escaped(text, match.index));
  let cursor = 0;
  for (let i = 0; i + 1 < delimiters.length; i += 1) {
    const open = delimiters[i]!;
    const close = delimiters[i + 1]!;
    const size = open[0].length;
    if (size > 2 || close[0].length !== size) continue;
    const body = text.slice(open.index + size, close.index);
    if (size === 1 && (/\r|\n/.test(body) || /\d/.test(text[close.index + 1] ?? ''))) continue;
    if (!looksLikeMath(body, size === 2)) continue;
    const rendered = latexToUnicode(body).replaceAll('$', '＄');
    if (!rendered) continue;
    const prefix = text.slice(cursor, open.index);
    pieces.push(prefix, rendered);
    boundaries.push(prefix, PROTECTED.repeat(rendered.length));
    cursor = close.index + size;
    i += 1;
  }
  pieces.push(text.slice(cursor));
  boundaries.push(text.slice(cursor));
}

/** Retain UTF-16 offsets while hiding code, formulas and the body of each list item from the sentence splitter. */
export function prepareOutboundText(input: string): { text: string; boundaries: string } {
  const source = flattenLists(input);
  const pieces: string[] = [];
  const boundaries: string[] = [];
  let cursor = 0;
  for (const { start, end } of codeSpans(source)) {
    mathInText(source.slice(cursor, start), pieces, boundaries);
    pieces.push(source.slice(start, end));
    boundaries.push(PROTECTED.repeat(end - start));
    cursor = end;
  }
  mathInText(source.slice(cursor), pieces, boundaries);
  return {
    text: pieces.join(''),
    boundaries: boundaries.join('').replace(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\S[^\r\n]*/gm, (item) => {
      const tail = /(?:[。．]|(?<!\.)\.)+$/.exec(item)?.[0] ?? '';
      return PROTECTED.repeat(item.length - tail.length) + tail;
    }),
  };
}
