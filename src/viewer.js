import { LiveSession } from "./session.js";
import { createObservationControls, syncObservationUI } from "./observatory-ui.js";
import {
  DEFAULTS,
  BOUNDS,
  PRESETS,
  parseConfig,
  scenePatch,
} from "./params.js";

// This page only decodes a remote MediaStream. It never creates a WebGL context.
const $ = (selector) => document.querySelector(selector);
const video = $("#remote-video");
let session = null;
let parameters = { ...DEFAULTS };
let paused = false;
let preset = null;
let connectionState = "idle";
let granted = false;
let requestPending = false;
let sequence = 0;
let pendingPatch = {};
let patchTimer = null;
let lastPatchSent = 0;
let pointer = null;

createObservationControls({ remote: true, onPatch: queuePatch, onCommit: flushPatch });

function ready() {
  return connectionState === "connected";
}
function clearPatch() {
  if (patchTimer !== null) clearTimeout(patchTimer);
  patchTimer = null;
  pendingPatch = {};
}
function syncControls() {
  document.querySelectorAll("[data-remote-control]").forEach((element) => {
    element.disabled = !granted || !ready();
  });
  $("#request-control").disabled = !ready() || granted || requestPending;
  $("#request-control").hidden = granted;
  $("#request-control").textContent = requestPending
    ? "等待主持端授权"
    : "申请参数控制";
  $("#release-control").hidden = !granted;
  $("#release-control").disabled = !ready();
  $("#control-badge").textContent = granted
    ? "可控制"
    : requestPending
      ? "待授权"
      : "只读";
  $("#control-badge").dataset.granted = String(granted);
  $("#viewer-role-status").textContent = granted
    ? "VIDEO RECEIVER · CONTROL GRANTED"
    : "VIDEO RECEIVER · READ ONLY";
  $("#viewer-gesture").textContent = granted
    ? "拖动旋转 · 滚轮缩放 · 操作发送至主持端"
    : "观看模式 · 申请控制后可拖动旋转";
  document.body.classList.toggle("is-controller", granted && ready());
}
function setControl(value, message) {
  granted = Boolean(value && ready());
  requestPending = false;
  if (!granted) {
    clearPatch();
    pointer = null;
    video.classList.remove("dragging");
  }
  $("#control-message").textContent =
    message ||
    (granted
      ? "主持端已授权。调整参数将同步更新所有观众看到的画面。"
      : "观看无需控制权限，参数调整需主持端授权。");
  syncControls();
}
function syncParameters() {
  syncObservationUI(parameters, preset, { remote: true, connected: ready() });
  for (const key of ["lensing", "doppler", "disk"])
    $(`#viewer-${key}`).checked = parameters[key];
  $("#viewer-quality").value = parameters.quality;
  $("#viewer-pause").innerHTML = paused
    ? '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m6 3 9 6-9 6z" /></svg>'
    : '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M6 3v12M12 3v12" /></svg>';
  $("#viewer-pause").setAttribute(
    "aria-label",
    paused ? "继续主持端动画" : "暂停主持端动画",
  );
  $("#viewer-pause").setAttribute("aria-pressed", String(paused));
}
function resetStats() {
  for (const key of ["bitrate", "fps", "loss", "rtt", "resolution", "codec"])
    $(`[data-stat="${key}"]`).textContent = "—";
  $("#decoder-info").textContent = "解码器信息：等待连接";
}
function setStatus(state, message, room) {
  connectionState = state;
  const labels = {
    idle: "尚未连接",
    connecting: "连接信令服务",
    joining: "等待视频连接",
    connected: "实时视频已连接",
    error: "连接失败",
    disconnected: "连接已断开",
  };
  $("#connection-status").dataset.state = state;
  $("#connection-state").textContent = labels[state] || message || state;
  $("#connection-message").textContent =
    message ||
    (state === "connected"
      ? "视频与参数通过 WebRTC 在主持端和观众端之间传输。"
      : "主持端创建房间后，将房间码分享给观众。");
  if (room) $("#room-code").value = room;
  const active = ["connecting", "joining", "connected"].includes(state);
  $("#join-room").disabled = active;
  $("#leave-room").disabled = !active;
  $("#room-code").disabled = active;
  if (!ready()) {
    setControl(false);
    if (!active) {
      resetStats();
      clearVideo();
    }
  } else syncControls();
  $("#placeholder-title").textContent =
    state === "error"
      ? "观测信号未连接"
      : active
        ? "等待主持端画面"
        : "等待观测信号";
  $("#placeholder-message").textContent =
    message || "在右侧输入主持端房间码，连接实时天体画面。";
  syncParameters();
}
function clearVideo() {
  video.pause();
  video.srcObject = null;
  $("#video-placeholder").hidden = false;
  $("#play-video").hidden = true;
  $("#video-caption").textContent = "主持端 GPU 渲染 · 观众端视频播放";
}
async function playVideo() {
  const stream = video.srcObject;
  if (!stream) return;
  try {
    await video.play();
    if (video.srcObject === stream) $("#play-video").hidden = true;
  } catch {
    if (video.srcObject !== stream) return;
    $("#play-video").hidden = false;
    $("#video-caption").textContent =
      "浏览器暂停了自动播放 · 点击画面中央按钮播放";
  }
}
function send(message) {
  if (!session || !ready()) return false;
  try {
    if (session.send(message) === false) {
      $("#control-message").textContent =
        "数据通道暂未就绪或发送队列繁忙，请稍后重试。";
      return false;
    }
    return true;
  } catch (error) {
    $("#control-message").textContent =
      `操作未发送：${error.message || "数据通道暂不可用"}。`;
    return false;
  }
}
function sendCommand(message) {
  if (!granted || !ready()) return false;
  flushPatch();
  return send({ ...message, sequence: ++sequence });
}
function flushPatch() {
  if (patchTimer !== null) clearTimeout(patchTimer);
  patchTimer = null;
  if (!Object.keys(pendingPatch).length) return;
  const patch = pendingPatch;
  pendingPatch = {};
  if (!granted || !ready()) return;
  lastPatchSent = performance.now();
  send({ type: "patch", patch, sequence: ++sequence });
}
function queuePatch(patch) {
  if (!granted || !ready()) {
    syncParameters();
    return;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    parameters[key] = value;
    pendingPatch[key] = value;
  }
  preset = null;
  syncParameters();
  if (patchTimer === null)
    patchTimer = setTimeout(
      flushPatch,
      Math.max(0, 33 - (performance.now() - lastPatchSent)),
    );
}
function onData(detail, current) {
  const message = detail.message;
  if (!message || typeof message !== "object") return;
  if (message.type === "state") {
    try {
      parameters = parseConfig(
        JSON.stringify({ version: 1, parameters: message.parameters }),
      );
      paused = Boolean(message.paused);
      preset = Object.hasOwn(PRESETS, message.preset) ? message.preset : null;
      if (granted && message.controller !== current.clientId)
        setControl(false, "主持端已收回控制权限。仍可继续观看实时画面。");
      syncParameters();
    } catch {
      $("#control-message").textContent =
        "收到的参数状态无效，等待主持端再次同步。";
    }
  } else if (message.type === "control") {
    setControl(
      message.granted === true,
      typeof message.message === "string" ? message.message : undefined,
    );
  }
}
function onStats(stats) {
  const numeric = (value, digits = 0) =>
    typeof value === "number" && Number.isFinite(value)
      ? value.toFixed(digits)
      : "—";
  const assign = (key, text) => {
    $(`[data-stat="${key}"]`).textContent = text;
  };
  assign("bitrate", `${numeric(stats.bitrateKbps)} kbps`);
  assign("fps", `${numeric(stats.fps, 1)} fps`);
  assign("loss", `${numeric(stats.lossPercent, 2)} %`);
  assign("rtt", `${numeric(stats.rttMs)} ms`);
  assign(
    "resolution",
    stats.width > 0 && stats.height > 0
      ? `${stats.width} × ${stats.height}`
      : "—",
  );
  assign("codec", stats.codec || "—");
  $("#decoder-info").textContent =
    `解码器：${stats.decoderImplementation || "浏览器未报告"} · 累计丢包 ${numeric(stats.packetsLost)}。实现名称不保证硬件加速。`;
}
function bindSession(current) {
  const on = (name, callback) =>
    current.addEventListener(name, (event) => {
      if (session === current) callback(event.detail || {});
    });
  on("status", (detail) =>
    setStatus(detail.state, detail.message, detail.room),
  );
  on("stream", (detail) => {
    if (!detail.stream) {
      clearVideo();
      setControl(false);
      return;
    }
    video.srcObject = detail.stream;
    playVideo();
  });
  on("data", (detail) => onData(detail, current));
  on("stats", onStats);
}
async function joinRoom() {
  if (["connecting", "joining", "connected"].includes(connectionState)) return;
  const room = $("#room-code").value.trim().toUpperCase();
  if (!room) {
    $("#connection-message").textContent = "请输入主持端提供的房间码。";
    $("#room-code").focus();
    return;
  }
  if (session) {
    session.dispose();
    session = null;
  }
  clearVideo();
  resetStats();
  sequence = 0;
  setStatus("connecting", "正在连接信令服务，准备接收主持端画面。", room);
  let current;
  try {
    current = new LiveSession({ role: "viewer" });
    session = current;
    bindSession(current);
    await current.join(room);
  } catch (error) {
    if (!current || session === current)
      setStatus(
        "error",
        error.message || "无法加入房间，请检查房间码后重新连接。",
      );
  }
}
async function leaveRoom() {
  const current = session;
  session = null;
  clearPatch();
  setStatus("idle", "已离开房间。输入房间码可以重新连接。");
  if (current) {
    try {
      await current.leave();
    } finally {
      current.dispose();
    }
  }
}

$("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoom();
});
$("#leave-room").addEventListener("click", () => {
  leaveRoom().catch((error) => {
    $("#connection-message").textContent = error.message;
  });
});
$("#room-code").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase();
});
$("#request-control").addEventListener("click", () => {
  if (!ready() || granted || requestPending) return;
  if (send({ type: "control-request" })) {
    requestPending = true;
    $("#control-message").textContent =
      "申请已发送，等待主持端决定是否授权。当前仍为观看模式。";
    syncControls();
  }
});
$("#release-control").addEventListener("click", () => {
  flushPatch();
  send({ type: "control-release" });
  setControl(false, "已交还控制权限，可继续观看或重新申请。");
});
$("#play-video").addEventListener("click", playVideo);
video.addEventListener("playing", () => {
  $("#video-placeholder").hidden = true;
  $("#play-video").hidden = true;
  $("#video-caption").textContent = "主持端 GPU 渲染 · 观众端视频播放";
});
video.addEventListener("loadeddata", () => {
  if (video.readyState >= 2) $("#video-placeholder").hidden = true;
});
video.addEventListener("error", () => {
  $("#video-caption").textContent = "视频播放失败，请离开后重新连接。";
});
for (const key of ["lensing", "doppler", "disk"])
  $(`#viewer-${key}`).addEventListener("change", (event) => {
    queuePatch({ [key]: event.target.checked });
    flushPatch();
  });
$("#viewer-quality").addEventListener("change", (event) => {
  queuePatch({ quality: event.target.value });
  flushPatch();
});
$("#viewer-scene-mode").addEventListener("change", (event) => {
  queuePatch(scenePatch(event.target.value));
  flushPatch();
});
document
  .querySelectorAll("[data-live-preset]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      sendCommand({ type: "preset", preset: button.dataset.livePreset }),
    ),
  );
$("#viewer-pause").addEventListener("click", () =>
  sendCommand({ type: "pause", paused: !paused }),
);
$("#viewer-reset-camera").addEventListener("click", () =>
  sendCommand({ type: "reset-camera" }),
);
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("#viewer-stage").requestFullscreen();
  } catch {
    $("#video-caption").textContent =
      "此浏览器无法切换页面全屏，可使用浏览器的全屏功能。";
  }
}
$("#viewer-fullscreen").addEventListener("click", fullscreen);
video.addEventListener("pointerdown", (event) => {
  if (!granted || !ready() || pointer || event.button !== 0) return;
  event.preventDefault();
  video.focus();
  pointer = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    yaw: parameters.yaw,
    inclination: parameters.inclination,
  };
  video.setPointerCapture(event.pointerId);
  video.classList.add("dragging");
});
video.addEventListener("pointermove", (event) => {
  if (!pointer || pointer.id !== event.pointerId || !granted) return;
  const clamp = (value, bounds) =>
    Math.min(bounds[1], Math.max(bounds[0], value));
  const wrap = (value) =>
    ((((value + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
    Math.PI;
  pointer.yaw = wrap(pointer.yaw - (event.clientX - pointer.x) * 0.004);
  pointer.inclination = clamp(
    pointer.inclination + (event.clientY - pointer.y) * 0.15,
    BOUNDS.inclination,
  );
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  queuePatch({ yaw: pointer.yaw, inclination: pointer.inclination });
});
function stopDrag(event) {
  if (pointer?.id !== event.pointerId) return;
  pointer = null;
  video.classList.remove("dragging");
  flushPatch();
}
for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
  video.addEventListener(type, stopDrag);
video.addEventListener(
  "wheel",
  (event) => {
    if (!granted || !ready()) return;
    event.preventDefault();
    const delta =
      event.deltaY *
      (event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? video.clientHeight
          : 1);
    const distance = Math.min(
      BOUNDS.distance[1],
      Math.max(
        BOUNDS.distance[0],
        parameters.distance * Math.exp(delta * 0.001),
      ),
    );
    queuePatch({ distance });
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
  if (event.code === "Space" && granted) {
    event.preventDefault();
    sendCommand({ type: "pause", paused: !paused });
  }
  if (event.code === "KeyF") fullscreen();
});
window.addEventListener("pagehide", () => {
  clearPatch();
  session?.dispose();
});
syncParameters();
syncControls();
resetStats();
const query = new URLSearchParams(location.search);
if (query.has("room"))
  $("#room-code").value = query.get("room").trim().toUpperCase();
if (query.get("auto") === "1" && $("#room-code").value) joinRoom();
