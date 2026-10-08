import { BlackHoleRenderer } from "./renderer.js";
import {
  DEFAULTS,
  BOUNDS,
  QUALITY,
  PRESETS,
  clamp,
  wrapAngle,
  parseConfig,
  encodeConfig,
  physicalReadout,
} from "./params.js";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#universe");
const icons = {
  camera: '<path d="M3 5h3l1-2h4l1 2h3v9H3z"/><circle cx="9" cy="9" r="2.7"/>',
  pause: '<path d="M6 3v12M12 3v12"/>',
  play: '<path d="m6 3 9 6-9 6z"/>',
  mouse: '<rect x="5" y="1.5" width="8" height="14" rx="4"/><path d="M9 2v5"/>',
  orbit:
    '<circle cx="9" cy="9" r="3"/><ellipse cx="9" cy="9" rx="8" ry="4" transform="rotate(-30 9 9)"/>',
  panel:
    '<rect x="2" y="2" width="14" height="14" rx="2"/><path d="M11 2v14"/>',
  fullscreen: '<path d="M6 2H2v4m10-4h4v4M2 12v4h4m10-4v4h-4"/>',
  reset: '<path d="M2 7a7 7 0 1 1 1 7M2 2v5h5"/>',
  download: '<path d="M9 2v9m-4-4 4 4 4-4M3 12v4h12v-4"/>',
  upload: '<path d="M9 11V2m-4 4 4-4 4 4M3 12v4h12v-4"/>',
  info: '<circle cx="9" cy="9" r="7"/><path d="M9 8v5m0-8h.01"/>',
  alert: '<path d="m9 2 8 14H1zM9 7v4m0 2h.01"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 18 18" aria-hidden="true">${icons[name] || icons.info}</svg>`;
}
document.querySelectorAll("[data-icon]").forEach((el) => {
  el.innerHTML = icon(el.dataset.icon);
});

let params = { ...DEFAULTS };
let renderer;
let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
let dirty = true;
let simTime = 0;
let previousTime = performance.now();
let frameCount = 0;
let sampleStart = previousTime;
let toastTimer;
let pointer = null;
let currentPreset = "cinematic";
let contextLost = false;

const sliders = [
  [
    "massScale",
    "质量尺度",
    "physics-controls",
    0.01,
    (v) => `${(4.3 * v).toFixed(2)} ×10⁶ M☉`,
  ],
  ["spin", "自旋参数", "physics-controls", 0.01, (v) => `a* ${v.toFixed(2)}`],
  [
    "temperature",
    "吸积盘温度",
    "physics-controls",
    100,
    (v) => `${Math.round(v).toLocaleString("en-US")} K`,
  ],
  [
    "diskOuter",
    "吸积盘外半径",
    "physics-controls",
    0.1,
    (v) => `${v.toFixed(1)} rₛ`,
  ],
  ["inclination", "观测倾角", "render-controls", 1, (v) => `${Math.round(v)}°`],
  [
    "distance",
    "观测距离",
    "render-controls",
    0.1,
    (v) => `${v.toFixed(1)} r_ref`,
  ],
  ["exposure", "曝光强度", "render-controls", 0.05, (v) => `${v.toFixed(2)}×`],
  ["stars", "星空亮度", "render-controls", 0.05, (v) => `${v.toFixed(2)}×`],
  ["speed", "时间流速", "render-controls", 0.05, (v) => `${v.toFixed(2)}×`],
];
for (const [key, label, container, step] of sliders) {
  const [min, max] = BOUNDS[key];
  const wrapper = document.createElement("div");
  wrapper.className = "slider-control";
  wrapper.innerHTML = `<div class="slider-label"><label for="${key}">${label}</label><output id="${key}-value" for="${key}"></output></div><input type="range" id="${key}" min="${min}" max="${max}" step="${step}" value="${params[key]}" />`;
  $(`#${container}`).append(wrapper);
  $(`#${key}`).addEventListener("input", (event) => {
    params[key] = Number(event.target.value);
    currentPreset = null;
    dirty = true;
    syncUI();
  });
}
function syncUI() {
  for (const [key, , , , format] of sliders) {
    const input = $(`#${key}`);
    input.value = params[key];
    input.style.setProperty(
      "--progress",
      `${(100 * (params[key] - BOUNDS[key][0])) / (BOUNDS[key][1] - BOUNDS[key][0])}%`,
    );
    $(`#${key}-value`).textContent = format(params[key]);
    input.setAttribute("aria-valuetext", format(params[key]));
  }
  for (const key of ["lensing", "doppler", "disk"])
    $(`#${key}`).checked = params[key];
  $("#quality").value = params.quality;
  const physical = physicalReadout(params.massScale);
  $("#mass-readout").innerHTML =
    `${(physical.solarMasses / 1e6).toFixed(2)} <small>×10⁶ M☉</small>`;
  $("#radius-readout").innerHTML =
    `${(physical.schwarzschildKm / 1e6).toFixed(2)} <small>百万 km</small>`;
  $("#angle-readout").innerHTML =
    `${Math.round(params.inclination)} <small>deg</small>`;
  document.querySelectorAll("[data-preset]").forEach((button) => {
    const active = button.dataset.preset === currentPreset;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#scene-label").textContent =
    {
      cinematic: "CINEMATIC VIEW",
      faceOn: "POLAR VIEW",
      blue: "HIGH ENERGY VIEW",
    }[currentPreset] || "CUSTOM OBSERVATION";
  $("#pause").innerHTML = icon(paused ? "play" : "pause");
  $("#pause").setAttribute("aria-label", paused ? "继续动画" : "暂停动画");
  $("#pause").setAttribute("aria-pressed", String(paused));
  if (paused) $("#fps").textContent = "PAUSED";
}
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 3500);
}
function resize() {
  if (!renderer || contextLost) return;
  let size;
  try {
    size = renderer.resize(QUALITY[params.quality]);
  } catch (error) {
    renderer.dispose();
    renderer = null;
    fail(error);
    return;
  }
  $("#resolution").textContent = `${size.width} × ${size.height}`;
  dirty = true;
}
function fail(error) {
  $("#error-state").hidden = false;
  $("#error-message").textContent =
    `${error.message || error} 请使用支持 WebGL2 的浏览器，并检查浏览器硬件加速设置。`;
  $("#gpu-badge span").textContent = "渲染不可用";
  $("#export-image").disabled = true;
  $("#renderer-label").textContent = "RENDERER UNAVAILABLE";
  console.error(error);
}
function initialize() {
  try {
    renderer?.dispose();
    renderer = new BlackHoleRenderer(canvas);
    contextLost = false;
    $("#error-state").hidden = true;
    $("#export-image").disabled = false;
    const { hardware, renderer: device } = renderer.info;
    $("#gpu-badge span").textContent =
      hardware === false
        ? "WEBGL2 · 软件渲染"
        : hardware === true
          ? "WEBGL2 · GPU ONLINE"
          : "WEBGL2 · 设备未知";
    $("#renderer-label").textContent =
      hardware === false
        ? "SOFTWARE RENDERER"
        : hardware === true
          ? "GPU ACCELERATED"
          : "WEBGL2 · DEVICE UNKNOWN";
    $("#renderer-label").title = device;
    $("#gpu-badge").title = device;
    resize();
    dirty = true;
  } catch (error) {
    renderer?.dispose();
    renderer = null;
    fail(error);
  }
}
function loop(now) {
  const dt = Math.min((now - previousTime) / 1000, 0.05);
  previousTime = now;
  if (renderer && !contextLost && !document.hidden && (!paused || dirty)) {
    if (!paused) simTime += dt * params.speed;
    try {
      renderer.render(simTime, params);
      dirty = false;
      frameCount++;
    } catch (error) {
      renderer?.dispose();
      renderer = null;
      fail(error);
    }
  }
  if (now - sampleStart >= 700) {
    if (!paused && renderer && !contextLost)
      $("#fps").textContent =
        `${Math.round((frameCount * 1000) / (now - sampleStart))} FPS`;
    sampleStart = now;
    frameCount = 0;
  }
  requestAnimationFrame(loop);
}
function applyPreset(key) {
  params = { ...PRESETS[key] };
  currentPreset = key;
  dirty = true;
  syncUI();
  resize();
}
function togglePause() {
  paused = !paused;
  sampleStart = performance.now();
  frameCount = 0;
  dirty = true;
  syncUI();
}
function resetCamera() {
  params.inclination = DEFAULTS.inclination;
  params.yaw = DEFAULTS.yaw;
  params.distance = DEFAULTS.distance;
  currentPreset = null;
  dirty = true;
  syncUI();
}
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("#viewport").requestFullscreen();
  } catch {
    toast("此浏览器暂不支持全屏，请使用浏览器全屏功能。");
  }
}
function togglePanel() {
  document.body.classList.toggle("panel-hidden");
  $("#hide-panel").setAttribute(
    "aria-label",
    document.body.classList.contains("panel-hidden")
      ? "显示参数面板"
      : "隐藏参数面板",
  );
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$("#export-image").addEventListener("click", () => {
  if (!renderer || contextLost) return;
  try {
    renderer.render(simTime, params);
    canvas.toBlob((blob) => {
      if (!blob) return toast("画面导出失败，请重试。");
      download(
        blob,
        `event-horizon-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
      );
      toast("已导出当前渲染画面 PNG");
    }, "image/png");
  } catch (error) {
    toast(`导出失败：${error.message}`);
  }
});
$("#export-config").addEventListener("click", () => {
  download(
    new Blob([encodeConfig(params)], { type: "application/json" }),
    "event-horizon-config.json",
  );
  toast("观测配置已保存");
});
$("#import-config").addEventListener("click", () => $("#config-file").click());
$("#config-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 64 * 1024) throw new Error("配置文件不能超过 64 KB。");
    const incoming = parseConfig(await file.text());
    params = incoming;
    currentPreset = null;
    dirty = true;
    syncUI();
    resize();
    toast("观测配置已载入");
  } catch (error) {
    toast(`载入失败：${error.message}`);
  }
  event.target.value = "";
});
for (const key of ["lensing", "doppler", "disk"])
  $(`#${key}`).addEventListener("change", (event) => {
    params[key] = event.target.checked;
    currentPreset = null;
    dirty = true;
    syncUI();
  });
$("#quality").addEventListener("change", (event) => {
  params.quality = event.target.value;
  currentPreset = null;
  syncUI();
  resize();
});
document
  .querySelectorAll("[data-preset]")
  .forEach((button) =>
    button.addEventListener("click", () => applyPreset(button.dataset.preset)),
  );
$("#pause").addEventListener("click", togglePause);
$("#reset-camera").addEventListener("click", resetCamera);
$("#reset-all").addEventListener("click", () => {
  applyPreset("cinematic");
  toast("已恢复默认观测参数");
});
$("#hide-panel").addEventListener("click", togglePanel);
$("#fullscreen").addEventListener("click", fullscreen);
$("#retry").addEventListener("click", initialize);
canvas.addEventListener("pointerdown", (event) => {
  if (pointer || event.button !== 0) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  params.yaw = wrapAngle(params.yaw - (event.clientX - pointer.x) * 0.004);
  params.inclination = clamp(
    params.inclination + (event.clientY - pointer.y) * 0.15,
    ...BOUNDS.inclination,
  );
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  currentPreset = null;
  dirty = true;
  syncUI();
});
function stopDrag(event) {
  if (pointer?.id !== event.pointerId) return;
  pointer = null;
  canvas.classList.remove("dragging");
}
canvas.addEventListener("pointerup", stopDrag);
canvas.addEventListener("pointercancel", stopDrag);
canvas.addEventListener("lostpointercapture", stopDrag);
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const delta =
      event.deltaY *
      (event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? canvas.clientHeight
          : 1);
    params.distance = clamp(
      params.distance * Math.exp(delta * 0.001),
      ...BOUNDS.distance,
    );
    currentPreset = null;
    dirty = true;
    syncUI();
  },
  { passive: false },
);
document.addEventListener("keydown", (event) => {
  if (
    event.repeat ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName) ||
    event.target.isContentEditable
  )
    return;
  if (event.code === "Space") {
    event.preventDefault();
    togglePause();
  }
  if (event.code === "KeyR") {
    applyPreset("cinematic");
    toast("已恢复默认观测参数");
  }
  if (event.code === "KeyH") togglePanel();
  if (event.code === "KeyF") fullscreen();
});
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  contextLost = true;
  renderer?.dispose();
  fail(new Error("WebGL 上下文已丢失，正在等待浏览器恢复。"));
});
canvas.addEventListener("webglcontextrestored", () => {
  initialize();
  toast("GPU 渲染已恢复");
});
document.addEventListener("visibilitychange", () => {
  previousTime = performance.now();
  dirty = true;
});
window.addEventListener("pagehide", () => renderer?.dispose());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) initialize();
});
new ResizeObserver(resize).observe($("#viewport"));
syncUI();
initialize();
requestAnimationFrame(loop);
