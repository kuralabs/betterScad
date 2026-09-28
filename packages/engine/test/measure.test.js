/**
 * `get_size(object)` and `get_position(object)`: measuring geometry while the
 * code runs, and what the legacy export writes in their place.
 *
 * Size is the bounding box's extent, position its lowest corner — the corner
 * `cube()` grows from, so `translate(get_position(a)) cube(get_size(a))` is
 * the box itself. Always three numbers; a flat shape has z = 0.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, compile, measureKey, parse, toStockScad } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

/** Runs `source` and returns every echoed line. */
async function echoes(source) {
  const result = await engine.render(source, { preview: true });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors, []);
  return result.diagnostics.filter((d) => d.severity === 'echo').map((d) => d.message);
}

const warnings = (result) => result.diagnostics.filter((d) => d.severity === 'warning');

test('size and position of a plain shape', async () => {
  assert.deepEqual(await echoes('echo(get_size(cube([4, 5, 6])), get_position(cube([4, 5, 6])));'), [
    'ECHO: [4, 5, 6], [0, 0, 0]',
  ]);
  assert.deepEqual(await echoes('echo(get_position(cube(10, center = true)));'), ['ECHO: [-5, -5, -5]']);
});

test('the object is the real geometry: transforms, children and booleans all count', async () => {
  assert.deepEqual(await echoes('echo(get_position(translate([1, 2, 3]) cube(1)));'), ['ECHO: [1, 2, 3]']);
  // A difference can shrink the box, which is why the kernel has to build it.
  assert.deepEqual(
    await echoes('echo(get_size(difference() { cube(10); translate([0, 0, 5]) cube(20); }));'),
    ['ECHO: [10, 10, 5]'],
  );
  assert.deepEqual(
    await echoes('echo(get_size({ cube(1); translate([9, 0, 0]) cube(1); }));'),
    ['ECHO: [10, 1, 1]'],
  );
  assert.deepEqual(
    await echoes('echo(get_size(for (i = [0 : 2]) translate([i * 10, 0, 0]) cube(2)));'),
    ['ECHO: [22, 2, 2]'],
  );
});

test('a module is measured with the arguments it is given', async () => {
  const source = 'module box(w) cube([w, 2, 3]);\necho(get_size(box(7)).x, get_size(box(w = 9)).x);';
  assert.deepEqual(await echoes(source), ['ECHO: 7, 9']);
});

test('a flat shape has z = 0, so .z still reads', async () => {
  assert.deepEqual(await echoes('echo(get_size(square([3, 4])));'), ['ECHO: [3, 4, 0]']);
});

test('the value feeds ordinary code: stacking one part on another', async () => {
  const result = await engine.render(
    'module base() cube([20, 20, 7]);\nbase();\ntranslate([0, 0, get_size(base()).z]) cube(5);',
    { preview: true },
  );
  const tops = result.geometry.parts.map((p) => {
    let top = -Infinity;
    for (let i = 2; i < p.mesh.positions.length; i += 3) top = Math.max(top, p.mesh.positions[i]);
    return top;
  });
  assert.deepEqual(tops.sort((a, b) => a - b), [7, 12]);
});

test('floating-point dust is settled, so equality tests work', async () => {
  assert.deepEqual(
    await echoes('echo(get_size(translate([0.1, 0, 0]) translate([0.2, 0, 0]) cube([0.3, 1, 1])).x == 0.3);'),
    ['ECHO: true'],
  );
});

test('% and * are not part of the object; # is', async () => {
  assert.deepEqual(await echoes('echo(get_size({ cube(1); %translate([5, 0, 0]) cube(1); }));'), [
    'ECHO: [1, 1, 1]',
  ]);
  assert.deepEqual(await echoes('echo(get_size({ cube(1); *translate([5, 0, 0]) cube(1); }));'), [
    'ECHO: [1, 1, 1]',
  ]);
  assert.deepEqual(await echoes('echo(get_size({ cube(1); #translate([5, 0, 0]) cube(1); }));'), [
    'ECHO: [6, 1, 1]',
  ]);
});

test('an object with no geometry is undef, with a warning', async () => {
  const result = await engine.render('echo(get_size(cube(0)));', { preview: true });
  assert.ok(result.diagnostics.some((d) => d.message === 'ECHO: undef'));
  assert.ok(warnings(result).some((d) => d.code === 'eval.measure-empty'));
});

test('a value instead of an object says what was wanted', async () => {
  const result = await engine.render('echo(get_size(5));', { preview: true });
  assert.ok(warnings(result).some((d) => d.code === 'eval.measure-not-object'));
});

test('a file with its own get_size() keeps calling it', async () => {
  const source = 'function get_size(v) = v * 2;\nfunction f(x) = x + 1;\necho(get_size(f(1)));';
  assert.deepEqual(await echoes(source), ['ECHO: 4']);
  const legacy = toStockScad(source, 'own.scad');
  assert.equal(legacy.verbatim, true);
  assert.deepEqual(legacy.errors, []);
});

test('an imported file is read before the object that imports it is measured', async () => {
  const stl = engine.export(await engine.render('cube([3, 4, 5]);'), 'stl').data;
  const assets = { read: async (path) => (path === 'part.stl' ? stl : undefined) };
  const result = await engine.render('echo(get_size(import("part.stl")));', { preview: true, assets });
  assert.ok(result.diagnostics.some((d) => d.message === 'ECHO: [3, 4, 5]'), JSON.stringify(result.diagnostics));
});

test('without a kernel there is nothing to measure with: undef and a warning', async () => {
  // `compile` alone uses the kernel only once one is loaded, which it is here;
  // an engine-free evaluate is what a host without WASM has.
  const { evaluate } = await import('../dist/index.js');
  const result = evaluate(parse('x = get_size(cube(1));').file);
  assert.equal(result.topLevelVars.get('x'), undefined);
  assert.ok(result.diagnostics.items.some((d) => d.code === 'eval.measure-no-kernel'));
});

test('the parser takes modifiers, blocks and a trailing semicolon as the object', () => {
  for (const source of [
    'x = get_size(#cube(1));',
    'x = get_size({ cube(1); sphere(1); });',
    'x = get_size(cube(1););',
    'x = get_size(translate([1, 0, 0]) rotate(45) cube(1));',
    'x = get_size(if (true) cube(1));',
  ]) {
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, [], source);
    assert.equal(parsed.file.body[0].value.kind, 'measure', source);
  }
});

// --- legacy export -----------------------------------------------------------

async function legacy(source, parameters) {
  const compiled = await engine.compile(source, { file: 'part.scad', parameters });
  return toStockScad(source, 'part.scad', { measurements: compiled.measurements });
}

test('the export writes the measured value, with the call in a comment', async () => {
  const source = 'module base() cube([20, 10, 4]);\nbase();\ntranslate([0, 0, get_size(base()).z]) cube(2);\n';
  const out = await legacy(source);
  assert.deepEqual(out.errors, []);
  assert.match(out.source, /translate\(\[0, 0, \/\* get_size\(base\(\)\) \*\/ \[20, 10, 4\]\.z\]\)/);
  assert.ok(out.extensions.some((e) => e.name === 'get_size()'));
});

test('the exported file draws the same model', async () => {
  const source =
    'w = 30;\nmodule base() cube([w, 10, 4]);\nbase();\n' +
    'translate(get_position(base()) + [0, 0, get_size(base()).z]) cube([w, 2, 2]);\n';
  const out = await legacy(source);
  assert.deepEqual(out.errors, []);
  const volume = async (s) => (await engine.render(s)).geometry.stats.volume;
  assert.equal(await volume(out.source), await volume(source));
});

test('the value is the one for the parameters it was saved with', async () => {
  const source = 'w = 10;\nmodule base() cube([w, 1, 1]);\nx = get_size(base()).x;\necho(x);\n';
  assert.match((await legacy(source, { w: 25 })).source, /\[25, 1, 1\]/);
});

test('a measurement that differs from run to run is refused, naming the line', async () => {
  const source = 'module m(n) cube(get_size(cube(n)).x);\nm(1);\nm(2);\n';
  const out = await legacy(source);
  assert.equal(out.verbatim, true);
  assert.equal(out.errors[0].code, 'transpile.measure-varies');
  assert.match(out.errors[0].message, /line 1/);
});

test('the same object measured on every run is fine', async () => {
  const out = await legacy('module m() cube(get_size(cube(3)).x);\nm();\ntranslate([9, 0, 0]) m();\n');
  assert.deepEqual(out.errors, []);
});

test('a measurement that never ran is written as undef, and says so', async () => {
  const out = await legacy('if (false) echo(get_size(cube(1)));\ncube(1);\n');
  assert.deepEqual(out.errors, []);
  assert.match(out.source, /\/\* get_size\(cube\(1\)\): not reached \*\/ undef/);
});

test('without measurements the export refuses rather than guess', () => {
  const out = toStockScad('x = get_size(cube(1));\n', 'part.scad');
  assert.equal(out.errors[0].code, 'transpile.measure-unmeasured');
});

test('measurements are keyed by where the call was written', async () => {
  const compiled = await compile('x = get_size(cube(1));', { file: 'k.scad' });
  const call = parse('x = get_size(cube(1));', 'k.scad').file.body[0].value;
  assert.deepEqual(compiled.measurements.get(measureKey(call.span)), [[1, 1, 1]]);
});
