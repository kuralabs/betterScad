/**
 * Geometry reuse: a subtree is built once per render however often it
 * appears, keyed by what it is rather than where it was written.
 *
 * Counted at the kernel: the boolean an expensive part costs is the thing
 * reuse exists to avoid, so the tests count how often it runs.
 */

import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';

import { Engine, GeometrySession, compile } from '../dist/index.js';

let engine;
let differences = 0;
let restore;
before(async () => {
  engine = await Engine.create();
  const M = engine.api.Manifold;
  const original = M.difference;
  M.difference = function (...args) {
    differences++;
    return original.apply(this, args);
  };
  restore = () => (M.difference = original);
});
after(() => restore());

const PART = 'module part() difference() { cube(10, center = true); sphere(6, $fn = 32); }\n';

async function booleansFor(source, options = {}) {
  differences = 0;
  const result = await engine.render(PART + source, { preview: true, ...options });
  return { count: differences, result };
}

test('a part placed ten times is cut once', async () => {
  const { count, result } = await booleansFor('for (i = [0 : 9]) translate([i * 20, 0, 0]) part();');
  assert.equal(count, 1);
  assert.equal(result.geometry.parts.length, 10);
});

test('the copies are still moved: each lands where it was placed', async () => {
  const { result } = await booleansFor('part();\ntranslate([50, 0, 0]) part();');
  const centres = result.geometry.parts.map((p) => {
    let sum = 0;
    for (let i = 0; i < p.mesh.positions.length; i += 3) sum += p.mesh.positions[i];
    return Math.round(sum / (p.mesh.positions.length / 3));
  });
  assert.deepEqual(centres.sort((a, b) => a - b), [0, 50]);
});

test('measuring a part and then drawing it builds it once', async () => {
  const { count } = await booleansFor('translate([0, 0, get_size(part()).z]) part();\npart();');
  assert.equal(count, 1);
});

test('different parameters are different parts', async () => {
  const { count } = await booleansFor(
    'module hole(r) difference() { cube(10); cylinder(r = r, h = 30, center = true); }\nhole(2);\nhole(3);\nhole(2);',
  );
  assert.equal(count, 2);
});

test('the same shape at a different resolution is a different shape', async () => {
  const { count } = await booleansFor(
    'module h() difference() { cube(10); cylinder(r = 2, h = 30, center = true); }\nh($fn = 8);\nh($fn = 16);',
  );
  assert.equal(count, 2);
});

test('a modifier makes it a different subtree', async () => {
  // `#` draws an overlay the plain copy does not have, so it cannot share.
  const { result } = await booleansFor('part();\ntranslate([30, 0, 0]) #part();');
  assert.equal(result.geometry.annotations.length, 1);
});

test('a warning about a repeated part is given once, not once per copy', async () => {
  const result = await engine.render(
    'module p() intersection() { cube(1); square(1); }\np();\ntranslate([5, 0, 0]) p();',
    { preview: true },
  );
  const mixed = result.diagnostics.filter((d) => d.code === 'kernel.mixed-dimension');
  assert.equal(mixed.length, 1);
});

test('a session reuses what it built across compile and build', async () => {
  const session = new GeometrySession({ api: engine.api });
  try {
    const compiled = await compile(PART + 'echo(get_size(part()));\npart();', { session });
    const afterCompile = session.builtCount;
    differences = 0;
    await session.build(compiled.scene);
    assert.equal(differences, 0);
    assert.ok(session.builtCount > afterCompile, 'the scene adds its own wrappers');
  } finally {
    session.dispose();
  }
});
