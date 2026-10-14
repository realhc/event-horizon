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
  SCENES,
  sceneDefaults,
  scenePatch,
  sceneReadouts,
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
test("legacy version-1 black-hole files receive celestial defaults without changing their controls", () => {
  const old = { massScale: 1.2, spin: 0.8, temperature: 12000, quality: "ultra", lensing: false };
  const parsed = parseConfig(JSON.stringify({ version: 1, parameters: old }));
  assert.equal(parsed.scene, "blackHole");
  for (const [key, value] of Object.entries(old)) assert.equal(parsed[key], value);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(DEFAULTS).sort());
  assert.equal(parsed.nebulaDensity, 1.1);
});
test("all celestial defaults and presets are complete valid configurations", () => {
  assert.deepEqual(Object.keys(SCENES), ["blackHole", "nebula", "galaxy", "planet", "star"]);
  for (const [scene, catalog] of Object.entries(SCENES)) {
    const defaults = sceneDefaults(scene);
    assert.equal(defaults.scene, scene);
    assert.deepEqual(parseConfig(encodeConfig(defaults)), defaults);
    assert.deepEqual(parseConfig(JSON.stringify({ version: 1, parameters: { scene } })), defaults);
    assert.equal(PRESETS[catalog.defaultPreset].scene, scene);
  }
  assert.equal(sceneDefaults("star").temperature, 5800);
});
test("scene enum and integer-valued celestial controls reject unsafe configurations", () => {
  const config = (parameters) => JSON.stringify({ version: 1, parameters });
  for (const scene of [null, false, 1, "__proto__", "constructor", "unknown"])
    assert.throws(() => parseConfig(config({ scene })));
  for (const key of ["galaxyArms", "planetBands"]) {
    assert.throws(() => parseConfig(config({ [key]: BOUNDS[key][0] + 0.5 })));
    assert.equal(parseConfig(config({ [key]: BOUNDS[key][1] }))[key], BOUNDS[key][1]);
  }
});
test("switching and resetting modes retains dormant settings in exported flat state", () => {
  const changed = { ...DEFAULTS, spin: 0.9, nebulaDensity: 2.1, ringTilt: 63, starActivity: 1.8 };
  const nebula = { ...changed, ...scenePatch("nebula") };
  assert.equal(nebula.scene, "nebula");
  assert.equal(nebula.nebulaDensity, 1.1);
  assert.equal(nebula.spin, 0.9);
  assert.equal(nebula.ringTilt, 63);
  assert.equal(nebula.starActivity, 1.8);
  const planet = { ...nebula, ...scenePatch("planet", PRESETS.planetIce) };
  assert.equal(planet.ringTilt, 45);
  assert.equal(planet.nebulaDensity, 1.1);
  assert.equal(planet.spin, 0.9);
  assert.deepEqual(parseConfig(encodeConfig(planet)), planet);
});
test("readout units describe the active scene rather than showing black-hole measurements", () => {
  for (const scene of ["nebula", "galaxy", "planet", "star"]) {
    const readouts = sceneReadouts(sceneDefaults(scene));
    assert.equal(readouts.length, 3);
    assert.ok(readouts.every(({ label, value, unit }) => typeof label === "string" && typeof value === "string" && typeof unit === "string"));
    assert.ok(readouts.every(({ label, unit }) => !label.includes("黑洞") && !unit.includes("M☉") && !unit.includes("km")));
  }
});
