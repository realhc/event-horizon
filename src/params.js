/** Parameters are dimensionless except inclination (degrees), temperature (K) and time. */
export const DEFAULTS = Object.freeze({
  massScale: 1,
  spin: 0.65,
  inclination: 82,
  yaw: 0.22,
  distance: 18,
  temperature: 7000,
  diskOuter: 8,
  exposure: 1.25,
  stars: 1,
  speed: 0.7,
  lensing: true,
  doppler: true,
  disk: true,
  quality: "balanced",
});
export const BOUNDS = Object.freeze({
  massScale: [0.65, 1.8],
  spin: [0, 0.98],
  inclination: [5, 89],
  yaw: [-Math.PI, Math.PI],
  distance: [10, 40],
  temperature: [3000, 18000],
  diskOuter: [5, 16],
  exposure: [0.4, 3],
  stars: [0, 2],
  speed: [0, 2],
});
export const QUALITY = Object.freeze({
  performance: 0.55,
  balanced: 0.8,
  ultra: 1,
});
export const PRESETS = Object.freeze({
  cinematic: { ...DEFAULTS },
  faceOn: { ...DEFAULTS, inclination: 12, yaw: 0, distance: 21, exposure: 1.4 },
  blue: {
    ...DEFAULTS,
    temperature: 18000,
    spin: 0.9,
    inclination: 80,
    exposure: 1.5,
  },
});
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const wrapAngle = (value) =>
  ((((value + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
  Math.PI;
export function parseConfig(text) {
  const data = JSON.parse(text);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.version !== 1 ||
    !data.parameters ||
    typeof data.parameters !== "object" ||
    Array.isArray(data.parameters)
  )
    throw new Error("需要 version: 1 的 Event Horizon 配置文件。");
  const result = { ...DEFAULTS };
  for (const [key, value] of Object.entries(data.parameters)) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    if (Object.hasOwn(BOUNDS, key)) {
      const [min, max] = BOUNDS[key];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max
      )
        throw new Error(`参数 ${key} 需在 ${min} 到 ${max} 之间。`);
    } else if (key === "quality") {
      if (!Object.hasOwn(QUALITY, value))
        throw new Error("无法识别的渲染质量。");
    } else if (typeof value !== "boolean")
      throw new Error(`参数 ${key} 需要布尔值。`);
    Object.defineProperty(result, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}
export function encodeConfig(parameters) {
  return JSON.stringify(
    {
      application: "Event Horizon",
      version: 1,
      parameters: Object.fromEntries(
        Object.keys(DEFAULTS).map((key) => [key, parameters[key]]),
      ),
    },
    null,
    2,
  );
}
export function physicalReadout(massScale) {
  const solarMasses = 4.3e6 * massScale;
  const gravitationalConstant = 6.6743e-11;
  const solarMassKg = 1.98847e30;
  const lightSpeed = 299792458;
  return {
    solarMasses,
    schwarzschildKm:
      (2 * gravitationalConstant * solarMassKg * solarMasses) /
      (lightSpeed * lightSpeed) /
      1000,
  };
}
