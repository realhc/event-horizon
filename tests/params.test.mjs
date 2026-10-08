import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  PRESETS,
  BOUNDS,
  parseConfig,
  encodeConfig,
  physicalReadout,
  wrapAngle,
} from "../src/params.js";

test("configuration export and import preserve every supported observation parameter", () => {
  for (const preset of Object.values(PRESETS))
    assert.deepEqual(parseConfig(encodeConfig(preset)), preset);
});
test("untrusted configurations reject non-finite, out-of-range and incorrect values before applying", () => {
  const config = (parameters) => JSON.stringify({ version: 1, parameters });
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    assert.throws(() => parseConfig(config({ [key]: min - 1 })));
    assert.throws(() => parseConfig(config({ [key]: max + 1 })));
    assert.throws(() => parseConfig(config({ [key]: "NaN" })));
    assert.throws(() => parseConfig(config({ [key]: null })));
  }
  for (const value of ["unknown", null, true])
    assert.throws(() => parseConfig(config({ quality: value })));
  assert.throws(() => parseConfig(config({ lensing: "false" })));
  assert.throws(() => parseConfig('{"version":2,"parameters":{}}'));
  assert.throws(() => parseConfig('{"version":1,"parameters":[]}'));
  assert.throws(() => parseConfig("not JSON"));
});
test("unknown and prototype keys are ignored and cannot pollute defaults", () => {
  const parsed = parseConfig(
    '{"version":1,"parameters":{"__proto__":{"polluted":true},"toString":5,"constructor":{},"unknown":15,"spin":0.7}}',
  );
  assert.equal(parsed.spin, 0.7);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(DEFAULTS).sort());
  assert.equal({}.polluted, undefined);
  assert.equal(DEFAULTS.spin, 0.65);
});
test("physical readout follows Schwarzschild mass scaling and known solar-mass radius", () => {
  assert.ok(
    Math.abs(physicalReadout(1 / 4.3e6).schwarzschildKm - 2.95334) < 0.001,
  );
  assert.equal(
    physicalReadout(2).schwarzschildKm,
    2 * physicalReadout(1).schwarzschildKm,
  );
  assert.equal(physicalReadout(1).solarMasses, 4.3e6);
});
test("yaw wraps to a bounded interval for repeated camera rotations", () => {
  assert.ok(Math.abs(wrapAngle(10 * Math.PI + 0.42) - 0.42) < 1e-12);
  for (const angle of [-1000, -Math.PI, 0, Math.PI, 1000])
    assert.ok(wrapAngle(angle) >= -Math.PI && wrapAngle(angle) <= Math.PI);
});
