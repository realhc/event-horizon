import { LiveSession } from "./session.js";
import { PRESETS } from "./params.js";
import { validatePatch, commandSequence } from "./live-control.js";

const $ = (selector) => document.querySelector(selector);

/** Owns canvas capture and remote-control permission; WebRTC never applies a command directly. */
export class LiveHost {
  constructor(canvas, adapter) {
    this.canvas = canvas;
    this.adapter = adapter;
    this.session = new LiveSession({ role: "host" });
    this.active = false;
    this.controller = null;
    this.pending = [];
    this.sequences = new Map();
    this.captureCanvas = document.createElement("canvas");
    this.captureContext = this.captureCanvas.getContext("2d", { alpha: false });
    this.stream = null;
    this.captureTimer = null;
    this.busy = false;
    this.stateTimer = null;
    this.experiment = [];
    this.startedAt = null;
    this.captureUpdate = Promise.resolve();
    this.captureEpoch = 0;

    $("#start-live").addEventListener("click", () => this.start());
    $("#stop-live").addEventListener("click", () => this.stop());
    $("#grant-control").addEventListener("click", () => this.grant());
    $("#deny-control").addEventListener("click", () => this.deny());
    $("#revoke-control").addEventListener("click", () => this.revoke());
    $("#copy-viewer-link").addEventListener("click", () => this.copyLink());
    $("#export-stats").addEventListener("click", () => this.exportStats());
    for (const id of ["#stream-size", "#stream-fps"]) {
      $(id).addEventListener("change", () => {
        this.captureUpdate = this.captureUpdate
          .then(() => this.updateCapture())
          .catch((error) => this.showStatus(error.message, "error"));
      });
    }
    $("#stream-bitrate").addEventListener("change", async () => {
      try {
        await this.session.setBitrate(this.bitrate);
      } catch (error) {
        this.showStatus(error.message, "error");
      }
    });
    this.session.addEventListener("status", ({ detail }) => {
      this.showStatus(detail.message || detail.state, detail.state);
      if (detail.state === "error" && !this.session.room) this.stop(false);
    });
    this.session.addEventListener("peer", ({ detail }) => {
      $("#live-peer-count").textContent = String(detail.count);
      const connected = detail.state === "connected";
      if (connected) this.publishState(true);
      if (
        detail.state === "closed" ||
        detail.state === "disconnected" ||
        detail.state === "failed" ||
        detail.state === "left"
      ) {
        this.pending = this.pending.filter(
          (peerId) => peerId !== detail.peerId,
        );
        this.sequences.delete(detail.peerId);
        if (this.controller === detail.peerId) this.revoke();
        this.syncPermission();
      }
    });
    this.session.addEventListener("data", ({ detail }) => this.receive(detail));
    this.session.addEventListener("stats", ({ detail }) =>
      this.renderStats(detail),
    );
    this.syncPermission();
  }

  get bitrate() {
    return Number($("#stream-bitrate").value) * 1000000;
  }
  get fps() {
    return Number($("#stream-fps").value);
  }
  get room() {
    return this.session.room;
  }

  showStatus(message, state = "idle") {
    $("#host-connection-state").textContent = message;
    $("#host-connection-state").dataset.state = state;
  }

  async start() {
    if (this.busy || this.active) return;
    this.busy = true;
    $("#start-live").disabled = true;
    try {
      if (!this.adapter.ready()) throw new Error("请先等待 GPU 渲染器启动。");
      if (!this.canvas.captureStream || !this.captureContext)
        throw new Error("当前浏览器不支持画布直播采集。");
      await this.updateCapture();
      const room = await this.session.create();
      this.active = true;
      this.startedAt = performance.now();
      this.experiment = [];
      $("#host-room").textContent = room;
      $("#stop-live").disabled = false;
      $("#copy-viewer-link").disabled = false;
      $("#viewer-link").href = `./viewer.html?room=${encodeURIComponent(room)}`;
      $("#viewer-link").removeAttribute("aria-disabled");
      $("#export-stats").disabled = false;
      this.showStatus("直播中 · 等待观众连接", "hosting");
      this.publishState(true);
    } catch (error) {
      await this.stop(false);
      this.showStatus(`无法开始直播：${error.message}`, "error");
    } finally {
      this.busy = false;
      $("#start-live").disabled = this.active;
    }
  }

  captureFrame() {
    if (!this.stream || !this.canvas.width || !this.canvas.height) return;
    const context = this.captureContext;
    const width = this.captureCanvas.width;
    const height = this.captureCanvas.height;
    const scale = Math.min(
      width / this.canvas.width,
      height / this.canvas.height,
    );
    const w = this.canvas.width * scale;
    const h = this.canvas.height * scale;
    context.fillStyle = "#050609";
    context.fillRect(0, 0, width, height);
    context.drawImage(this.canvas, (width - w) / 2, (height - h) / 2, w, h);
    this.stream.getVideoTracks()[0]?.requestFrame?.();
  }

  async updateCapture() {
    if (this.busy && this.stream) return;
    if (!this.active && !this.busy) return;
    const epoch = ++this.captureEpoch;
    const [width, height] = $("#stream-size").value.split("x").map(Number);
    const previous = this.stream;
    const previousWidth = this.captureCanvas.width;
    const previousHeight = this.captureCanvas.height;
    this.captureCanvas.width = width;
    this.captureCanvas.height = height;
    const next = this.captureCanvas.captureStream(0);
    next.getVideoTracks()[0].contentHint = "detail";
    try {
      await this.session.setStream(next, { maxBitrate: this.bitrate });
      if (epoch !== this.captureEpoch || (!this.active && !this.busy)) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = next;
      clearInterval(this.captureTimer);
      this.captureTimer = setInterval(
        () => this.captureFrame(),
        1000 / this.fps,
      );
      previous?.getTracks().forEach((track) => track.stop());
      this.captureFrame();
      $("#capture-size").textContent = `${width} × ${height} / ${this.fps} FPS`;
    } catch (error) {
      next.getTracks().forEach((track) => track.stop());
      this.captureCanvas.width = previousWidth;
      this.captureCanvas.height = previousHeight;
      this.showStatus(`采集设置失败：${error.message}`, "error");
      if (!previous) throw error;
    }
  }

  async stop(showMessage = true) {
    this.captureEpoch++;
    this.active = false;
    clearInterval(this.captureTimer);
    clearTimeout(this.stateTimer);
    this.captureTimer = null;
    this.stateTimer = null;
    this.session.leave();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.controller = null;
    this.pending = [];
    this.sequences.clear();
    $("#host-room").textContent = "—";
    $("#live-peer-count").textContent = "0";
    $("#start-live").disabled = false;
    $("#stop-live").disabled = true;
    $("#copy-viewer-link").disabled = true;
    $("#viewer-link").href = "./viewer.html";
    $("#viewer-link").setAttribute("aria-disabled", "true");
    this.syncPermission();
    this.renderStats(null);
    if (showMessage) this.showStatus("直播已结束", "idle");
  }

  publishState(immediate = false) {
    if (!this.active) return;
    const publish = () => {
      this.stateTimer = null;
      this.session.broadcast({
        type: "state",
        ...this.adapter.getState(),
        controller: this.controller,
      });
    };
    if (immediate) {
      clearTimeout(this.stateTimer);
      publish();
    } else if (!this.stateTimer) this.stateTimer = setTimeout(publish, 33);
  }

  sendTo(peerId, message) {
    // The transport accepts an optional target; state broadcasts remain shared.
    this.session.broadcast(message, peerId);
  }

  receive({ message, peerId }) {
    if (!message || typeof message !== "object" || !this.active) return;
    if (message.type === "control-request") {
      if (this.controller === peerId)
        return this.sendTo(peerId, {
          type: "control",
          granted: true,
          message: "你已获得控制权",
        });
      if (!this.pending.includes(peerId)) this.pending.push(peerId);
      this.syncPermission();
      return;
    }
    if (message.type === "control-release") {
      this.pending = this.pending.filter((id) => id !== peerId);
      if (this.controller === peerId) this.revoke();
      this.syncPermission();
      return;
    }
    if (message.type === "ping") {
      return this.sendTo(peerId, {
        type: "pong",
        sentAt: message.sentAt,
        sequence: message.sequence,
      });
    }
    if (this.controller !== peerId) {
      return this.sendTo(peerId, {
        type: "control",
        granted: false,
        message: "请先获得主机授权",
      });
    }
    try {
      const sequence = commandSequence(message);
      if (sequence <= (this.sequences.get(peerId) ?? -1))
        throw new Error("指令序号已过期。");
      switch (message.type) {
        case "patch":
          this.adapter.applyPatch(validatePatch(message.patch));
          break;
        case "preset":
          if (!Object.hasOwn(PRESETS, message.preset))
            throw new Error("预设不存在。");
          this.adapter.applyPreset(message.preset);
          break;
        case "pause":
          if (typeof message.paused !== "boolean")
            throw new Error("暂停状态不正确。");
          this.adapter.setPaused(message.paused);
          break;
        case "reset-camera":
          this.adapter.resetCamera();
          break;
        default:
          throw new Error("不支持的控制指令。");
      }
      this.sequences.set(peerId, sequence);
      this.sendTo(peerId, { type: "ack", sequence, applied: true });
      this.publishState(true);
    } catch (error) {
      this.sendTo(peerId, {
        type: "ack",
        sequence: message.sequence,
        applied: false,
        message: error.message,
      });
    }
  }

  syncPermission() {
    $("#control-request").hidden = !this.pending.length;
    $("#request-peer").textContent = this.pending.length
      ? `观众 ${this.pending[0].slice(0, 6)} 申请控制`
      : "暂无申请";
    $("#controller-name").textContent = this.controller
      ? `观众 ${this.controller.slice(0, 6)}`
      : "仅主机控制";
    $("#revoke-control").disabled = !this.controller;
  }

  grant() {
    const peerId = this.pending.shift();
    if (!peerId) return;
    if (this.controller && this.controller !== peerId)
      this.sendTo(this.controller, {
        type: "control",
        granted: false,
        message: "主机已转交控制权",
      });
    this.controller = peerId;
    this.sendTo(peerId, {
      type: "control",
      granted: true,
      message: "主机已授权，可以调参",
    });
    this.syncPermission();
    this.publishState(true);
  }
  deny() {
    const peerId = this.pending.shift();
    if (peerId)
      this.sendTo(peerId, {
        type: "control",
        granted: false,
        message: "主机未授予控制权",
      });
    this.syncPermission();
  }
  revoke() {
    if (this.controller)
      this.sendTo(this.controller, {
        type: "control",
        granted: false,
        message: "控制权已收回",
      });
    this.controller = null;
    this.syncPermission();
    this.publishState(true);
  }

  renderStats(stats) {
    const values = {
      bitrate:
        stats?.bitrateKbps == null
          ? "—"
          : `${Math.round(stats.bitrateKbps)} kbps`,
      fps: stats?.fps == null ? "—" : `${stats.fps.toFixed(1)} FPS`,
      loss:
        stats?.lossPercent == null ? "—" : `${stats.lossPercent.toFixed(2)}%`,
      rtt: stats?.rttMs == null ? "—" : `${stats.rttMs.toFixed(1)} ms`,
      resolution: stats?.width ? `${stats.width} × ${stats.height}` : "—",
      codec: stats?.codec || "—",
    };
    for (const [key, value] of Object.entries(values))
      $(`[data-host-stat="${key}"]`).textContent = value;
    $("#encoder-info").textContent =
      stats?.encoderImplementation ||
      (stats?.frames > 0 ? "浏览器未报告编码实现" : "等待编码器统计");
    if (this.active && stats?.frames > 0) {
      this.experiment.push({
        elapsedSeconds: (performance.now() - this.startedAt) / 1000,
        targetBitrateMbps: this.bitrate / 1e6,
        captureFps: this.fps,
        captureResolution: $("#stream-size").value,
        ...stats,
      });
      if (this.experiment.length > 3600) this.experiment.shift();
    }
  }

  async copyLink() {
    const url = new URL(
      `viewer.html?room=${encodeURIComponent(this.room)}`,
      location.href,
    ).href;
    try {
      await navigator.clipboard.writeText(url);
      this.adapter.toast("观众链接已复制");
    } catch {
      this.adapter.toast(`观众链接：${url}`);
    }
  }
  exportStats() {
    const rows = [
      [
        "elapsed_s",
        "target_mbps",
        "capture_fps",
        "capture_size",
        "actual_kbps",
        "video_fps",
        "loss_percent",
        "network_rtt_ms",
        "video_width",
        "video_height",
        "codec",
        "encoder",
        "peers",
      ],
    ];
    for (const row of this.experiment)
      rows.push([
        row.elapsedSeconds.toFixed(2),
        row.targetBitrateMbps,
        row.captureFps,
        row.captureResolution,
        row.bitrateKbps,
        row.fps,
        row.lossPercent,
        row.rttMs,
        row.width,
        row.height,
        row.codec,
        row.encoderImplementation,
        row.peers,
      ]);
    const csv = rows
      .map((row) =>
        row
          .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\r\n");
    this.adapter.download(
      new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }),
      "event-horizon-webrtc-stats.csv",
    );
    this.adapter.toast(`已导出 ${this.experiment.length} 个统计样本`);
  }
  dispose() {
    this.stop(false);
    this.session.dispose();
  }
}
