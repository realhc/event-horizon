import { BOUNDS, SCENES, PRESETS, PRESET_LABELS, sceneReadouts } from "./params.js";

const multiplier = (value) => `${value.toFixed(2)}×`;
const degrees = (value) => `${Math.round(value)}°`;
export const SLIDERS = [
  { key: "massScale", label: "质量尺度", scene: "blackHole", step: 0.01, format: (value) => `${(4.3 * value).toFixed(2)} ×10⁶ M☉` },
  { key: "spin", label: "自旋参数", scene: "blackHole", step: 0.01, format: (value) => `a* ${value.toFixed(2)}` },
  { key: "temperature", label: "吸积盘温度", step: 100, format: (value) => `${Math.round(value).toLocaleString("en-US")} K` },
  { key: "diskOuter", label: "吸积盘外半径", scene: "blackHole", step: 0.1, format: (value) => `${value.toFixed(1)} rₛ` },
  { key: "nebulaDensity", label: "云雾密度", scene: "nebula", step: 0.05, format: multiplier },
  { key: "nebulaHue", label: "发射色相", scene: "nebula", step: 1, format: degrees },
  { key: "nebulaTurbulence", label: "湍流强度", scene: "nebula", step: 0.05, format: multiplier },
  { key: "galaxyArms", label: "螺旋臂数", scene: "galaxy", step: 1, format: (value) => `${value} 条` },
  { key: "galaxyPitch", label: "旋臂展开", scene: "galaxy", step: 0.01, format: multiplier },
  { key: "galaxyDust", label: "尘埃带强度", scene: "galaxy", step: 0.05, format: multiplier },
  { key: "planetRadius", label: "行星半径尺度", scene: "planet", step: 0.01, format: multiplier },
  { key: "ringTilt", label: "光环倾角", scene: "planet", step: 1, format: degrees },
  { key: "ringWidth", label: "光环外半径", scene: "planet", step: 0.05, format: (value) => `${value.toFixed(2)} Rₚ` },
  { key: "planetBands", label: "云带数量", scene: "planet", step: 1, format: (value) => `${value} 条` },
  { key: "starActivity", label: "表面活动", scene: "star", step: 0.05, format: multiplier },
  { key: "starCorona", label: "日冕强度", scene: "star", step: 0.05, format: multiplier },
  { key: "inclination", label: "观测倾角", shared: true, step: 1, format: degrees },
  { key: "distance", label: "观测距离", shared: true, step: 0.1, format: (value) => `${value.toFixed(1)} r_ref` },
  { key: "exposure", label: "曝光强度", shared: true, step: 0.05, format: multiplier },
  { key: "stars", label: "星空亮度", shared: true, step: 0.05, format: multiplier },
  { key: "speed", label: "时间流速", shared: true, step: 0.05, format: multiplier },
];
const $ = (selector) => document.querySelector(selector);

export function createObservationControls({ remote = false, onPatch, onCommit }) {
  const prefix = remote ? "viewer-" : "";
  for (const control of SLIDERS) {
    const { key, label, step } = control;
    const id = `${prefix}${key}`;
    const [min, max] = BOUNDS[key];
    const wrapper = document.createElement("div");
    wrapper.className = "slider-control";
    wrapper.dataset.parameter = key;
    if (control.scene) wrapper.dataset.sceneOnly = control.scene;
    wrapper.innerHTML = `<div class="slider-label"><label for="${id}">${label}</label><output id="${id}-value" for="${id}"></output></div><input type="range" id="${id}" min="${min}" max="${max}" step="${step}"${remote ? " data-remote-control disabled" : ""} />`;
    const container = remote ? "#viewer-parameter-controls" : control.shared ? "#render-controls" : "#physics-controls";
    $(container).append(wrapper);
    $(`#${id}`).addEventListener("input", (event) => onPatch({ [key]: Number(event.target.value) }));
    if (onCommit) $(`#${id}`).addEventListener("change", onCommit);
  }
  const selector = remote ? $("#viewer-scene-mode") : $("#scene");
  for (const [scene, { name, english }] of Object.entries(SCENES)) {
    const option = document.createElement("option");
    option.value = scene;
    option.textContent = `${name} / ${english}`;
    selector.append(option);
  }
  const presetAttribute = remote ? "livePreset" : "preset";
  const container = remote ? $("#viewer-presets") : $("#scene-presets");
  for (const [key, values] of Object.entries(PRESETS)) {
    if (values.scene === "blackHole") continue;
    const button = document.createElement("button");
    button.className = "preset";
    button.dataset[presetAttribute] = key;
    button.setAttribute("aria-pressed", "false");
    if (remote) { button.dataset.remoteControl = ""; button.disabled = true; }
    button.innerHTML = `<span class="preset-orbit scene-${values.scene}"></span>${PRESET_LABELS[key]}`;
    container.append(button);
  }
}

export function syncObservationUI(parameters, currentPreset, { remote = false, connected = true } = {}) {
  const prefix = remote ? "viewer-" : "";
  const scene = SCENES[parameters.scene];
  document.body.dataset.scene = parameters.scene;
  const selector = remote ? $("#viewer-scene-mode") : $("#scene");
  selector.value = parameters.scene;
  for (const { key, format } of SLIDERS) {
    const input = $(`#${prefix}${key}`);
    input.value = parameters[key];
    input.style.setProperty("--progress", `${(100 * (parameters[key] - BOUNDS[key][0])) / (BOUNDS[key][1] - BOUNDS[key][0])}%`);
    input.setAttribute("aria-valuetext", format(parameters[key]));
    $(`#${prefix}${key}-value`).textContent = format(parameters[key]);
  }
  const temperatureLabels = { blackHole: "吸积盘温度", nebula: "辉光色温", galaxy: "星光色温", planet: "云带色温", star: "光球色温" };
  $(`label[for="${prefix}temperature"]`).textContent = temperatureLabels[parameters.scene];
  // These camera units express the renderer's normalized scene scale, not a distance measurement.
  $(`#${prefix}distance-value`).textContent = parameters.scene === "blackHole" ? `${parameters.distance.toFixed(1)} r_ref` : `${parameters.distance.toFixed(1)} 相对`;
  $(`#${prefix}distance`).setAttribute("aria-valuetext", $(`#${prefix}distance-value`).textContent);
  document.querySelectorAll("[data-scene-only]").forEach((element) => { element.hidden = element.dataset.sceneOnly !== parameters.scene; });
  const presetSelector = remote ? "[data-live-preset]" : "[data-preset]";
  for (const button of document.querySelectorAll(presetSelector)) {
    const key = remote ? button.dataset.livePreset : button.dataset.preset;
    button.hidden = PRESETS[key].scene !== parameters.scene;
    const active = key === currentPreset;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  $(remote ? "#viewer-scene" : "#scene-label").textContent = !connected ? "WAITING FOR SIGNAL" : `${scene.english} / ${remote ? "LIVE" : currentPreset ? "OBSERVATORY" : "CUSTOM"}`;
  const headline = $(remote ? "#viewer-scene-title" : "#scene-title");
  headline.replaceChildren(document.createTextNode(scene.headline[0]));
  const emphasis = document.createElement("span");
  emphasis.textContent = scene.headline[1];
  headline.append(emphasis);
  $(remote ? "#viewer-scene-description" : "#scene-description").textContent = remote ? `共享${scene.name}观测，主持端渲染，观众端共同探索。` : scene.description;
  $(remote ? "#viewer-model-note" : "#model-note").textContent = remote ? `${scene.note} 主持端渲染，观众端只播放视频；参数调整需授权。` : scene.note;
  $(remote ? "#viewer-controls-title" : "#scene-controls-title").textContent = scene.controlsTitle;
  if (!remote) $("#scene-caption").textContent = scene.caption;
  const viewport = $(remote ? "#viewer-stage" : "#viewport");
  viewport.setAttribute("aria-label", `${remote ? "主持端实时" : "实时"}${scene.name}可视化`);
  $(remote ? "#remote-video" : "#universe").setAttribute("aria-label", `${remote ? "主持端发送" : "GPU 渲染"}的${scene.name}画面，可拖动旋转与滚轮缩放`);
  if (!remote) $("#export-image").title = `导出当前${scene.name}画面为 PNG`;
  const readoutIds = ["mass-readout", "radius-readout", "angle-readout"];
  sceneReadouts(parameters).forEach(({ label, value, unit }, index) => {
    const output = $(`#${prefix}${readoutIds[index]}`);
    output.previousElementSibling.textContent = label;
    output.replaceChildren(document.createTextNode(`${value} `));
    const small = document.createElement("small"); small.textContent = unit; output.append(small);
  });
}
