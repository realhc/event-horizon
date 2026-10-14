/** Dimensionless visual parameters except angles (degrees/radians), temperature (K) and time. */
export const DEFAULTS = Object.freeze({
  scene: "blackHole", massScale: 1, spin: 0.65, inclination: 82, yaw: 0.22,
  distance: 18, temperature: 7000, diskOuter: 8, exposure: 1.25, stars: 1, speed: 0.7,
  lensing: true, doppler: true, disk: true, quality: "balanced",
  nebulaDensity: 1.1, nebulaHue: 280, nebulaTurbulence: 1,
  galaxyArms: 4, galaxyPitch: 0.4, galaxyDust: 0.8,
  planetRadius: 1, ringTilt: 25, ringWidth: 2.2, planetBands: 8,
  starActivity: 0.8, starCorona: 1,
});
export const BOUNDS = Object.freeze({
  massScale: [0.65, 1.8], spin: [0, 0.98], inclination: [5, 89],
  yaw: [-Math.PI, Math.PI], distance: [10, 40], temperature: [3000, 18000],
  diskOuter: [5, 16], exposure: [0.4, 3], stars: [0, 2], speed: [0, 2],
  nebulaDensity: [0.2, 2.5], nebulaHue: [0, 360], nebulaTurbulence: [0.2, 2],
  galaxyArms: [2, 6], galaxyPitch: [0.15, 0.8], galaxyDust: [0, 2],
  planetRadius: [0.65, 1.6], ringTilt: [0, 80], ringWidth: [1.2, 3],
  planetBands: [2, 16], starActivity: [0.1, 2], starCorona: [0.2, 2],
});
export const QUALITY = Object.freeze({ performance: 0.55, balanced: 0.8, ultra: 1 });
const integerParameters = new Set(["galaxyArms", "planetBands"]);
const commonParameters = ["inclination", "yaw", "distance", "temperature", "exposure", "stars", "speed", "quality"];
export const SCENES = Object.freeze({
  blackHole: {
    name: "黑洞", english: "BLACK HOLE", headline: ["凝视", "事件视界。"],
    description: "在光与引力的边界，探索不可见之物。",
    caption: "吸积盘 · 引力透镜 · 相对论性增亮", controlsTitle: "黑洞与吸积盘",
    note: "交互式近似模型。光线弯曲实时计算；自旋用于吸积盘表现，并非完整 Kerr 时空解。",
    keys: ["massScale", "spin", "diskOuter", "lensing", "doppler", "disk"],
    defaults: {}, defaultPreset: "cinematic", presets: ["cinematic", "faceOn", "blue"],
  },
  nebula: {
    name: "星云", english: "NEBULA", headline: ["穿行", "星云之间。"],
    description: "在尘埃与光的涌动中，发现恒星的摇篮。",
    caption: "体积云雾 · 发射辉光 · 湍流尘埃", controlsTitle: "星云与尘埃",
    note: "程序化体积星云。密度、色相与湍流用于视觉探索；色彩为艺术化发射光表现，并非实测光谱。",
    keys: ["nebulaDensity", "nebulaHue", "nebulaTurbulence"],
    defaults: { inclination: 65, yaw: 0.12, distance: 18, temperature: 9000, exposure: 1.4, speed: 0.4 },
    defaultPreset: "nebulaViolet", presets: ["nebulaViolet", "nebulaPillars"],
  },
  galaxy: {
    name: "螺旋星系", english: "SPIRAL GALAXY", headline: ["追随", "星系旋臂。"],
    description: "亿万星光汇聚成旋律，在旋臂中寻找秩序。",
    caption: "明亮核球 · 螺旋星臂 · 暗尘埃带", controlsTitle: "星系与旋臂",
    note: "程序化螺旋星系。旋臂、核球与尘埃带为形态近似，动画不代表实际恒星轨道或星系演化时标。",
    keys: ["galaxyArms", "galaxyPitch", "galaxyDust"],
    defaults: { inclination: 35, yaw: 0.3, distance: 19, temperature: 8000, exposure: 1.2, speed: 0.35 },
    defaultPreset: "galaxySpiral", presets: ["galaxySpiral", "galaxyFaceOn"],
  },
  planet: {
    name: "环状行星", english: "RINGED PLANET", headline: ["绕行", "光环世界。"],
    description: "掠过云带与冰尘光环，观察另一种世界。",
    caption: "气态云带 · 行星光环 · 昼夜阴影", controlsTitle: "行星与光环",
    note: "带环气态行星的艺术化模型。半径为相对尺度，色温调节云带配色，不表示真实行星表面温度。",
    keys: ["planetRadius", "ringTilt", "ringWidth", "planetBands"],
    defaults: { inclination: 65, yaw: 0.3, distance: 18, temperature: 5800, exposure: 1.2, speed: 0.4 },
    defaultPreset: "planetSaturn", presets: ["planetSaturn", "planetIce"],
  },
  star: {
    name: "恒星", english: "STAR", headline: ["靠近", "恒星之火。"],
    description: "在炽热表面与日冕之间，感受星光的起源。",
    caption: "光球纹理 · 耀斑活动 · 日冕辉光", controlsTitle: "恒星与日冕",
    note: "恒星光球与日冕的程序化近似。色温近似黑体配色；耀斑与日冕为可调视觉表现，不计算磁流体动力学。",
    keys: ["starActivity", "starCorona"],
    defaults: { inclination: 65, yaw: 0.15, distance: 18, temperature: 5800, exposure: 1.1, speed: 0.6 },
    defaultPreset: "starSolar", presets: ["starSolar", "starBlue"],
  },
});
export function sceneDefaults(scene = "blackHole") {
  if (!Object.hasOwn(SCENES, scene)) throw new Error("无法识别的天体模式。");
  return { ...DEFAULTS, ...SCENES[scene].defaults, scene };
}
/** Reset active settings while retaining unused settings of other celestial modes. */
export function scenePatch(scene, values = sceneDefaults(scene)) {
  if (!Object.hasOwn(SCENES, scene)) throw new Error("无法识别的天体模式。");
  return Object.fromEntries(["scene", ...commonParameters, ...SCENES[scene].keys].map((key) => [key, values[key]]));
}
export const PRESETS = Object.freeze({
  cinematic: sceneDefaults(),
  faceOn: { ...sceneDefaults(), inclination: 12, yaw: 0, distance: 21, exposure: 1.4 },
  blue: { ...sceneDefaults(), temperature: 18000, spin: 0.9, inclination: 80, exposure: 1.5 },
  nebulaViolet: sceneDefaults("nebula"),
  nebulaPillars: { ...sceneDefaults("nebula"), nebulaHue: 24, nebulaDensity: 1.65, nebulaTurbulence: 1.4, temperature: 6000, inclination: 75 },
  galaxySpiral: sceneDefaults("galaxy"),
  galaxyFaceOn: { ...sceneDefaults("galaxy"), inclination: 10, yaw: 0, galaxyArms: 2, galaxyPitch: 0.55, galaxyDust: 1.1 },
  planetSaturn: sceneDefaults("planet"),
  planetIce: { ...sceneDefaults("planet"), temperature: 13000, ringTilt: 45, ringWidth: 2.65, planetBands: 12 },
  starSolar: sceneDefaults("star"),
  starBlue: { ...sceneDefaults("star"), temperature: 18000, starActivity: 1.4, starCorona: 1.5, exposure: 0.95 },
});
export const PRESET_LABELS = Object.freeze({
  cinematic: "电影感", faceOn: "俯视", blue: "高温", nebulaViolet: "紫色云海", nebulaPillars: "金色尘柱",
  galaxySpiral: "螺旋星海", galaxyFaceOn: "正面双臂", planetSaturn: "土星印象", planetIce: "冰蓝光环", starSolar: "太阳印象", starBlue: "蓝色炽星",
});
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const wrapAngle = (value) => ((((value + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
export function parseConfig(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1 || !data.parameters || typeof data.parameters !== "object" || Array.isArray(data.parameters))
    throw new Error("需要 version: 1 的 Event Horizon 配置文件。");
  // Missing scene keeps old version-1 black-hole configurations compatible.
  const result = sceneDefaults(data.parameters.scene ?? "blackHole");
  for (const [key, value] of Object.entries(data.parameters)) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    if (Object.hasOwn(BOUNDS, key)) {
      const [min, max] = BOUNDS[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integerParameters.has(key) && !Number.isInteger(value)))
        throw new Error(`参数 ${key} 需在 ${min} 到 ${max} 之间${integerParameters.has(key) ? "且为整数" : ""}。`);
    } else if (key === "scene") {
      if (typeof value !== "string" || !Object.hasOwn(SCENES, value)) throw new Error("无法识别的天体模式。");
    } else if (key === "quality") {
      if (typeof value !== "string" || !Object.hasOwn(QUALITY, value)) throw new Error("无法识别的渲染质量。");
    } else if (typeof value !== "boolean") throw new Error(`参数 ${key} 需要布尔值。`);
    result[key] = value;
  }
  return result;
}
export function encodeConfig(parameters) {
  const complete = { ...sceneDefaults(parameters.scene ?? "blackHole"), ...parameters };
  return JSON.stringify({ application: "Event Horizon", version: 1, parameters: Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, complete[key]])) }, null, 2);
}
export function physicalReadout(massScale) {
  const solarMasses = 4.3e6 * massScale;
  return { solarMasses, schwarzschildKm: (2 * 6.6743e-11 * 1.98847e30 * solarMasses) / (299792458 * 299792458) / 1000 };
}
/** Readout values avoid attaching physical units to artistic controls. */
export function sceneReadouts(p) {
  const angle = { label: "观测倾角", value: `${Math.round(p.inclination)}`, unit: "deg" };
  if (p.scene === "nebula") return [{ label: "云雾密度", value: p.nebulaDensity.toFixed(2), unit: "相对" }, { label: "发射色相", value: `${Math.round(p.nebulaHue)}`, unit: "deg" }, angle];
  if (p.scene === "galaxy") return [{ label: "螺旋臂数", value: `${p.galaxyArms}`, unit: "arms" }, { label: "旋臂展开", value: p.galaxyPitch.toFixed(2), unit: "相对" }, angle];
  if (p.scene === "planet") return [{ label: "行星半径", value: p.planetRadius.toFixed(2), unit: "相对" }, { label: "光环倾角", value: `${Math.round(p.ringTilt)}`, unit: "deg" }, angle];
  if (p.scene === "star") return [{ label: "光球色温", value: `${Math.round(p.temperature).toLocaleString("en-US")}`, unit: "K" }, { label: "表面活动", value: p.starActivity.toFixed(2), unit: "相对" }, angle];
  const physical = physicalReadout(p.massScale);
  return [{ label: "黑洞质量", value: (physical.solarMasses / 1e6).toFixed(2), unit: "×10⁶ M☉" }, { label: "史瓦西半径", value: (physical.schwarzschildKm / 1e6).toFixed(2), unit: "百万 km" }, angle];
}
