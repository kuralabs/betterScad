/**
 * An imported SVG lands in millimetres, the way OpenSCAD reads it.
 *
 * Coordinates were once passed through as raw user units, so a drawing came in
 * about 2.8 times too large at the default 72 dpi.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { importSVG } from '../dist/index.js';

const box = (attrs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><path d="M 0,0 H 100 V 200 H 0 Z"/></svg>`;

function extent(result) {
  const xs = result.contours.flat().map((p) => p[0]);
  const ys = result.contours.flat().map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.min(...ys)];
}

test('a unitless SVG is in pixels, so 1 unit is 25.4/dpi mm', () => {
  const [w, h] = extent(importSVG(box('width="100" height="200"'), { dpi: 72 }));
  assert.ok(Math.abs(w - (100 * 25.4) / 72) < 1e-9);
  assert.ok(Math.abs(h - (200 * 25.4) / 72) < 1e-9);
  const [w96] = extent(importSVG(box('width="100" height="200"'), { dpi: 96 }));
  assert.ok(Math.abs(w96 - (100 * 25.4) / 96) < 1e-9);
});

test('a size in pt with a matching viewBox is 25.4/72 mm per unit', () => {
  const [w, h, minY] = extent(importSVG(box('width="100pt" height="200pt" viewBox="0 0 100 200"'), { dpi: 72 }));
  assert.ok(Math.abs(w - (100 * 25.4) / 72) < 1e-9);
  assert.ok(Math.abs(h - (200 * 25.4) / 72) < 1e-9);
  assert.ok(Math.abs(minY) < 1e-9, 'the drawing sits on the x axis after the flip');
});

test('the viewBox, not the pixel size, scales a declared mm size', () => {
  const [w] = extent(importSVG(box('width="50mm" height="100mm" viewBox="0 0 100 200"')));
  assert.ok(Math.abs(w - 50) < 1e-9);
});
