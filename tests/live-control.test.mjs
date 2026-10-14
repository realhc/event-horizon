import test from "node:test";
import assert from "node:assert/strict";
import { validatePatch, commandSequence } from "../src/live-control.js";
import { DEFAULTS, scenePatch } from "../src/params.js";

test("remote patch preserves omitted settings and atomically rejects invalid values", () => {
  assert.deepEqual(validatePatch({ temperature: 12000, lensing: false }), {
    temperature: 12000,
    lensing: false,
  });
  for (const patch of [
    null,
    [],
    {},
    { spin: 99 },
    { temperature: 12000, spin: 99 },
    { yaw: Infinity },
    { lensing: "false" },
    { admin: true },
  ])
    assert.throws(() => validatePatch(patch));
  assert.throws(() =>
    validatePatch(JSON.parse('{"__proto__":{"controller":true}}')),
  );
});
test("control sequence rejects missing, negative and unsafe integers", () => {
  assert.equal(commandSequence({ sequence: 1 }), 1);
  for (const value of [undefined, -1, 0.2, "1", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => commandSequence({ sequence: value }));
});
test("remote celestial mode patches carry only supported settings and retain omitted fields", () => {
  const patch = scenePatch("nebula");
  assert.deepEqual(validatePatch(patch), patch);
  assert.equal(patch.scene, "nebula");
  assert.equal(patch.nebulaDensity, 1.1);
  assert.equal(Object.hasOwn(patch, "spin"), false);
  assert.deepEqual(validatePatch({ scene: "star", starActivity: 1.6 }), { scene: "star", starActivity: 1.6 });
  assert.deepEqual(validatePatch({ ...DEFAULTS, scene: "galaxy" }), { ...DEFAULTS, scene: "galaxy" });
});
test("remote scene changes atomically reject unknown modes, invalid ranges and fractional counts", () => {
  for (const patch of [
    { scene: "planet", planetBands: 3.5 },
    { scene: "galaxy", galaxyArms: 2.2 },
    { scene: "nebula", nebulaDensity: 9 },
    { scene: "star", starCorona: null },
    { scene: "__proto__" },
    { scene: true },
    { scene: "unknown", temperature: 5800 },
  ]) assert.throws(() => validatePatch(patch));
});
