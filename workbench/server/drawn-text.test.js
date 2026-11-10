import assert from 'node:assert/strict';
import test from 'node:test';
import { glyphStrokes, splitRun } from './library/drawn-text.js';

test('two names OCR read as one run are split and placed along it', () => {
  const parts = splitRun({ text: '原材料检验区高温冷却暂存点', x: 0, y: 5, width: 130, height: 4, score: 0.99 });
  assert.deepEqual(parts.map((p) => p.text), ['原材料检验区', '高温冷却暂存点']);
  assert.equal(parts[0].x, -35);
  assert.equal(parts[1].x, 30);
  assert.equal(parts[1].y, 5);
});

test('a single name keeps its place; stray OCR punctuation is trimmed', () => {
  assert.deepEqual(splitRun({ text: '‘化学线下线点', x: 1, y: 2, width: 60 }), [{ text: '化学线下线点', x: 1, y: 2, width: 60 }]);
  assert.deepEqual(splitRun({ text: '1#气垫炉', x: 0, y: 0, width: 10 }).map((p) => p.text), ['1#气垫炉']);
  assert.deepEqual(splitRun({ text: '  ', x: 0, y: 0 }), []);
});

test('glyph strokes keep the short lines among the curves and drop walls', () => {
  const glyph = (x) => [{ x, y: 0 }, { x: x + 300, y: 400 }, { x: x + 600, y: 0 }];
  const splines = Array.from({ length: 10 }, (_, i) => glyph(i * 800));
  const stroke = [{ x: 100, y: 100 }, { x: 500, y: 100 }];
  const wall = [{ x: 0, y: 0 }, { x: 100000, y: 0 }];
  const far = [{ x: 50000, y: 50000 }, { x: 50400, y: 50000 }];
  const found = glyphStrokes(splines, [stroke, wall, far]);
  assert.equal(found.unit, 600);
  assert.equal(found.strokes.length, 11);
  assert.ok(found.strokes.includes(stroke));
  assert.equal(glyphStrokes(splines.slice(0, 3), [stroke]), null);
});
