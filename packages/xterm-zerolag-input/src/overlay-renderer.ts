import type { RenderParams, FontStyle, XtermTerminal } from './types.js';

// ─── CJK / fullwidth character width detection ───────────────────────

/**
 * Get visual cell width of a single character.
 * CJK wide characters occupy 2 cells, others occupy 1.
 * Prefers the terminal's Unicode addon when available.
 */
export function charCellWidth(terminal: XtermTerminal | null | undefined, ch: string): number {
  if (terminal?.unicode?.getStringCellWidth) {
    return terminal.unicode.getStringCellWidth(ch);
  }
  // Fallback: detect CJK wide characters by Unicode range
  const code = ch.codePointAt(0);
  if (
    code !== undefined &&
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo
      (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals, Kangxi, Ideographic
      (code >= 0x3040 && code <= 0x33bf) || // Hiragana, Katakana, Bopomofo, CJK Compat
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ext A
      (code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified, Yi
      (code >= 0xa960 && code <= 0xa97c) || // Hangul Jamo Extended-A
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compat Forms
      (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
      (code >= 0x1f000 && code <= 0x1fbff) || // Mahjong, Domino, Emoji
      (code >= 0x20000 && code <= 0x2ffff) || // CJK Unified Ext B-F
      (code >= 0x30000 && code <= 0x3ffff)) // CJK Unified Ext G+
  )
    return 2;
  return 1;
}

/**
 * Get visual cell width of a string (sum of all character widths).
 */
export function stringCellWidth(terminal: XtermTerminal | null | undefined, str: string): number {
  let w = 0;
  for (const ch of str) w += charCellWidth(terminal, ch);
  return w;
}

// ─── Overlay rendering ────────────────────────────────────────────────

/**
 * Render the overlay content into the container element.
 *
 * Creates per-character `<span>` elements positioned on an exact grid
 * matching xterm.js's canvas renderer. This avoids sub-pixel drift that
 * occurs with normal DOM text flow.
 *
 * CJK wide characters are rendered with double-width spans.
 */
export function renderOverlay(container: HTMLDivElement, params: RenderParams): void {
  const {
    lines,
    startCol,
    totalCols,
    cellW,
    cellH,
    charTop,
    charHeight,
    promptRow,
    font,
    showCursor,
    cursorColor,
    terminal,
  } = params;

  // Position container at prompt row.
  container.style.left = '0px';
  container.style.top = promptRow * cellH + 'px';

  // Clear and rebuild (typically 1-3 line divs, negligible cost)
  container.innerHTML = '';
  const fullWidthPx = totalCols * cellW;

  // Full-area opaque background to cover canvas text beneath the overlay.
  // Uses clip-path for an L-shape: first line starts at startCol, rest at 0.
  const bg = document.createElement('div');
  bg.style.cssText = 'position:absolute;pointer-events:none';
  bg.style.backgroundColor = font.backgroundColor;
  const startPx = startCol * cellW;
  // Count extra rows of echo content below the overlay text by scanning the
  // buffer until we hit a separator (───), empty row, or non-text content.
  // This covers all canvas echo rows without hiding the separator/status bar.
  let extraCoverRows = 0;
  if (terminal && totalCols > 0) {
    const buf = terminal.buffer.active;
    for (let r = 0; r < 4; r++) {
      const absRow = buf.viewportY + promptRow + lines.length + r;
      const line = buf.getLine(absRow);
      if (!line) break;
      const text = line.translateToString(true).trimEnd();
      if (!text || /^[─━═─\u2500-\u257f]+$/.test(text)) break;
      extraCoverRows++;
    }
  }
  const totalH = (lines.length + extraCoverRows) * cellH;
  const bleed = 4;
  bg.style.left = -bleed + 'px';
  bg.style.top = -bleed + 'px';
  bg.style.width = fullWidthPx + bleed * 2 + 'px';
  bg.style.height = totalH + bleed * 2 + 'px';
  // Clip the top-left corner (prompt area before overlay text)
  const clipLeft = Math.max(0, startPx - bleed);
  const clipBottom = cellH + bleed;
  bg.style.clipPath = `polygon(${clipLeft}px 0, 100% 0, 100% 100%, 0 100%, 0 ${clipBottom}px, ${clipLeft}px ${clipBottom}px)`;
  container.appendChild(bg);

  for (let i = 0; i < lines.length; i++) {
    const leftPx = i === 0 ? startCol * cellW : 0;
    const widthPx = i === 0 ? fullWidthPx - leftPx : fullWidthPx;
    const topPx = i * cellH;
    const lineEl = makeLine(lines[i], leftPx, topPx, widthPx, cellH, cellW, charTop, charHeight, font, terminal);
    container.appendChild(lineEl);
  }

  // Block cursor at cursorCharIndex position (or end of text if -1)
  if (showCursor) {
    const { cursorCharIndex } = params;
    // Compute total display text to find cursor's visual position
    const fullText = lines.join('');
    const targetIdx = cursorCharIndex < 0 || cursorCharIndex >= fullText.length ? fullText.length : cursorCharIndex;

    // Walk through lines to find which line and column the cursor lands on
    let charsSeen = 0;
    let cursorLine = 0;
    let charsInLine = 0;
    for (let li = 0; li < lines.length; li++) {
      const lineChars = [...lines[li]];
      if (charsSeen + lineChars.length >= targetIdx) {
        cursorLine = li;
        charsInLine = targetIdx - charsSeen;
        break;
      }
      charsSeen += lineChars.length;
      if (li === lines.length - 1) {
        cursorLine = li;
        charsInLine = lineChars.length;
      }
    }

    const lineLeft = cursorLine === 0 ? startCol : 0;
    // Compute visual column width of chars before cursor on this line
    const lineText = lines[cursorLine] || '';
    const charsBeforeCursor = [...lineText].slice(0, charsInLine);
    let colOffset = 0;
    for (const ch of charsBeforeCursor) colOffset += charCellWidth(terminal, ch);
    const cursorCol = lineLeft + colOffset;

    if (cursorCol < totalCols) {
      const cursor = document.createElement('span');
      cursor.style.cssText = 'position:absolute;display:inline-block';
      cursor.style.left = cursorCol * cellW + 'px';
      cursor.style.top = cursorLine * cellH + 'px';
      cursor.style.width = cellW + 'px';
      cursor.style.height = cellH + 'px';
      cursor.style.backgroundColor = cursorColor;
      container.appendChild(cursor);
    }
  }

  container.style.display = '';
}

/**
 * Create a styled line `<div>` with per-character grid positioning.
 *
 * Each character gets its own `<span>` positioned by visual column offset.
 * CJK wide characters occupy 2 cell widths.
 */
// Padding (px) added around each line div to cover sub-pixel compositing
// seams between the DOM overlay and the canvas layer below. Without this,
// canvas-rendered text can "peek through" at line-wrap boundaries due to
// fractional cellW/cellH values and browser anti-aliasing.
// 3px covers worst-case glyph overshoot on mobile (10px font, fractional cellW).
const LINE_PAD_X = 3;
const LINE_PAD_Y = 3;

function makeLine(
  text: string,
  leftPx: number,
  topPx: number,
  widthPx: number,
  cellH: number,
  cellW: number,
  _charTop: number,
  _charHeight: number,
  font: FontStyle,
  terminal?: XtermTerminal | null
): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;pointer-events:none';
  // No per-line background — the container-level bg div handles coverage.
  el.style.left = leftPx + 'px';
  el.style.top = topPx + 'px';
  el.style.width = widthPx + 'px';
  el.style.height = cellH + 'px';

  // CJK wide chars occupy 2 cells — position by visual column offset
  let colOffset = 0;
  for (const ch of text) {
    const cw = charCellWidth(terminal, ch);
    const span = document.createElement('span');
    // No ligatures — canvas renders each glyph independently.
    span.style.cssText =
      'position:absolute;display:inline-block;text-align:center;pointer-events:none;' +
      "font-feature-settings:'liga' 0,'calt' 0";
    span.style.left = colOffset * cellW + 'px';
    span.style.top = '0px';
    span.style.width = cw * cellW + 'px';
    span.style.height = cellH + 'px';
    span.style.lineHeight = cellH + 'px';
    span.style.fontFamily = font.fontFamily;
    span.style.fontSize = font.fontSize;
    span.style.fontWeight = font.fontWeight;
    span.style.color = font.color;
    if (font.letterSpacing) span.style.letterSpacing = font.letterSpacing;
    span.textContent = ch;
    el.appendChild(span);
    colOffset += cw;
  }

  return el;
}
