import { StreamStats, emptyStreamStats } from "./stream-stats.js";

const MAX_DATA_BYTES = 32768;
const MAX_BUFFERED_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const normalizeRoom = (room) => {
  const value = String(room ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(value))
    throw new Error("房间代码需为 4 到 12 位字母或数字。");
  return value;
};
const serialize = (message) => {
  if (JSON.stringify(message) === undefined)
    throw new Error("控制消息必须是 JSON 数据。");
  const payload = JSON.stringify({ v: 1, kind: "data", message });
  if (encoder.encode(payload).byteLength >= MAX_DATA_BYTES)
    throw new Error("控制消息需小于 32 KB。");
  return payload;
};

/** Same-origin signaling plus direct WebRTC video and reliable control data. */
export class LiveSession extends EventTarget {
  constructor({ role }) {
    super();
    if (role !== "host" && role !== "viewer")
      throw new Error("无法识别的直播角色。");
    if (typeof RTCPeerConnection !== "function")
      throw new Error("此浏览器不支持 WebRTC。");
    this.role = role;
    this.room = null;
    this.clientId = null;
    this.hostId = null;
    this.connections = new Map();
    this.channels = new Map();
    this.senders = new Map();
    this.queues = new Map();
    this.candidates = new Map();
    this.disconnectTimers = new Map();
    this.remoteStreams = new Map();
    this.remoteStreamActive = new Map();
    this.socket = null;
    this.pending = null;
    this.stream = null;
    this.maxBitrate = 6000000;
    this.disposed = false;
    this.state = "idle";
    this.stats = new StreamStats({
      role,
      connections: this.connections,
      onStats: (stats) => this.emit("stats", stats),
    });
    const url = new URL("/signaling", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.signalURL = url.href;
  }

  get isActive() {
    return Boolean(this.room && this.socket?.readyState === WebSocket.OPEN);
  }
  get connectedPeerCount() {
    return [...this.connections.values()].filter(
      (pc) => pc.connectionState === "connected",
    ).length;
  }
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  status(state, message) {
    this.state = state;
    this.emit("status", { state, message, room: this.room });
  }

  async create(room) {
    if (this.role !== "host") throw new Error("只有主机可以创建房间。");
    return this.enter(
      "create",
      room === undefined || room === "" ? undefined : normalizeRoom(room),
    );
  }
  async join(room) {
    if (this.role !== "viewer") throw new Error("观看端只能加入房间。");
    return this.enter("join", normalizeRoom(room));
  }

  async enter(type, room) {
    if (this.disposed) throw new Error("会话已释放。");
    if (this.socket || this.pending)
      throw new Error("已有直播会话，请先离开当前房间。");
    this.status("connecting", "正在连接信令服务…");
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(this.signalURL);
        this.socket = socket;
        this.pending = {
          resolve,
          reject,
          timeout: setTimeout(
            () =>
              this.end("error", "连接超时，请检查本地服务后重试。", "timeout"),
            15000,
          ),
        };
        socket.onopen = () => {
          if (this.socket !== socket) return;
          this.status(
            type === "create" ? "connecting" : "joining",
            type === "create" ? "正在创建直播房间…" : "正在加入直播房间…",
          );
          socket.send(JSON.stringify(room ? { type, room } : { type }));
        };
        socket.onmessage = (event) => {
          if (this.socket !== socket) return;
          try {
            if (typeof event.data !== "string")
              throw new Error("信令消息格式无效。");
            this.handleMessage(JSON.parse(event.data));
          } catch (error) {
            this.end(
              "error",
              error.message || "信令消息处理失败。",
              "signaling-error",
            );
          }
        };
        socket.onerror = () => {
          if (this.socket === socket)
            this.end(
              "error",
              "无法连接信令服务，请通过 npm start 启动本地程序。",
              "socket-error",
            );
        };
        socket.onclose = () => {
          if (this.socket === socket)
            this.end(
              "error",
              "信令连接已断开，请重新加入房间。",
              "socket-close",
            );
        };
      });
    } catch (error) {
      if (this.state !== "error")
        this.end(
          "error",
          error.message || "无法建立直播会话。",
          "connect-error",
        );
      throw error;
    }
  }

  resolveRoom() {
    if (!this.pending) return;
    clearTimeout(this.pending.timeout);
    this.pending.resolve(this.room);
    this.pending = null;
    this.stats.start();
  }

  handleMessage(message) {
    if (!message || typeof message.type !== "string")
      throw new Error("信令消息格式无效。");
    switch (message.type) {
      case "created":
        if (this.role !== "host" || !this.pending) return;
        this.room = message.room;
        this.clientId = message.clientId;
        this.hostId = message.clientId;
        this.status("hosting", "房间已创建，等待观看端加入。");
        this.resolveRoom();
        break;
      case "joined":
        if (this.role !== "viewer" || !this.pending) return;
        this.room = message.room;
        this.clientId = message.clientId;
        this.hostId = message.hostId;
        this.makePeer(message.hostId);
        this.status("joining", "已加入房间，正在建立视频连接…");
        this.resolveRoom();
        break;
      case "peer-joined":
        if (
          this.role !== "host" ||
          !this.isActive ||
          this.connections.has(message.peerId)
        )
          return;
        this.makePeer(message.peerId);
        this.enqueue(message.peerId, () => this.offer(message.peerId));
        break;
      case "signal":
        if (!this.connections.has(message.from)) return;
        this.enqueue(message.from, () =>
          this.handleSignal(message.from, message.payload),
        );
        break;
      case "peer-left":
        this.dropPeer(message.peerId, "left");
        if (this.role === "host" && this.isActive)
          this.status(
            "hosting",
            this.connectedPeerCount
              ? "正在向观看端发送实时画面。"
              : "观看端已离开，等待新的连接。",
          );
        break;
      case "host-left":
        this.end("idle", "主机已结束直播。", "host-left");
        break;
      case "error":
        if (message.code === "PEER_NOT_FOUND" && !this.pending) return;
        this.end(
          "error",
          message.message || "信令服务返回错误。",
          message.code || "server-error",
        );
        break;
    }
  }

  makePeer(peerId) {
    if (this.connections.has(peerId)) return this.connections.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.connections.set(peerId, pc);
    this.candidates.set(peerId, []);
    pc.onicecandidate = (event) =>
      this.signal(peerId, {
        candidate: event.candidate ? event.candidate.toJSON() : null,
      });
    pc.onconnectionstatechange = () => {
      if (this.connections.get(peerId) !== pc) return;
      const state = pc.connectionState;
      clearTimeout(this.disconnectTimers.get(peerId));
      this.disconnectTimers.delete(peerId);
      this.emit("peer", { peerId, count: this.connectedPeerCount, state });
      if (state === "connected")
        this.status(
          this.role === "host" ? "hosting" : "connected",
          this.role === "host"
            ? "正在向观看端发送实时画面。"
            : "已连接主机，正在接收实时画面。",
        );
      if (state === "failed" || state === "closed")
        this.peerFailed(peerId, "视频连接已断开，请重新加入房间。");
      else if (state === "disconnected") {
        if (this.role === "viewer")
          this.status("joining", "视频链路暂时断开，等待恢复…");
        this.disconnectTimers.set(
          peerId,
          setTimeout(() => {
            if (
              this.connections.get(peerId) === pc &&
              pc.connectionState === "disconnected"
            )
              this.peerFailed(peerId, "视频连接无法恢复，请重新加入房间。");
          }, 8000),
        );
      }
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.remoteStreams.set(peerId, stream);
      if (this.remoteStreamActive.get(peerId) !== false)
        this.emit("stream", { stream, peerId });
      event.track.addEventListener(
        "ended",
        () => {
          if (this.connections.get(peerId) === pc)
            this.emit("stream", { stream: null, peerId });
        },
        { once: true },
      );
    };
    pc.ondatachannel = (event) => this.attachChannel(peerId, event.channel);
    if (this.role === "host") {
      const track = this.stream
        ?.getVideoTracks()
        .find((track) => track.readyState === "live");
      const transceiver = pc.addTransceiver(track || "video", {
        direction: "sendonly",
        streams: this.stream ? [this.stream] : [],
        sendEncodings: [{ maxBitrate: this.maxBitrate }],
      });
      const codecs =
        globalThis.RTCRtpSender?.getCapabilities?.("video")?.codecs || [];
      const h264 = codecs.filter(
        (codec) => codec.mimeType.toLowerCase() === "video/h264",
      );
      if (
        h264.length &&
        typeof transceiver.setCodecPreferences === "function"
      ) {
        try {
          transceiver.setCodecPreferences([
            ...h264,
            ...codecs.filter(
              (codec) => codec.mimeType.toLowerCase() !== "video/h264",
            ),
          ]);
        } catch {
          // Codec preference is an optional hint; retain the browser's defaults.
        }
      }
      this.senders.set(peerId, transceiver.sender);
      this.attachChannel(
        peerId,
        pc.createDataChannel("control", { ordered: true }),
      );
    }
    this.emit("peer", {
      peerId,
      count: this.connectedPeerCount,
      state: "connecting",
    });
    return pc;
  }

  enqueue(peerId, operation) {
    const next = (this.queues.get(peerId) || Promise.resolve())
      .then(() => {
        if (!this.connections.has(peerId)) return;
        return operation();
      })
      .catch((error) =>
        this.peerFailed(peerId, error.message || "WebRTC 协商失败。"),
      );
    this.queues.set(peerId, next);
  }

  signal(peerId, payload) {
    if (!this.isActive || !this.connections.has(peerId)) return;
    this.socket.send(JSON.stringify({ type: "signal", to: peerId, payload }));
  }

  async offer(peerId) {
    const pc = this.connections.get(peerId);
    if (!pc || pc.signalingState !== "stable") return;
    await pc.setLocalDescription(await pc.createOffer());
    if (this.connections.get(peerId) !== pc) return;
    await this.applyBitrate(this.senders.get(peerId));
    this.signal(peerId, {
      description: {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp,
      },
    });
  }

  async handleSignal(peerId, payload) {
    const pc = this.connections.get(peerId);
    if (!pc || !payload || typeof payload !== "object") return;
    if (payload.description) {
      const description = payload.description;
      if (this.role === "host" && description.type !== "answer")
        throw new Error("主机收到了无效的视频协商消息。");
      if (this.role === "viewer" && description.type !== "offer")
        throw new Error("观看端收到了无效的视频协商消息。");
      await pc.setRemoteDescription(description);
      if (this.connections.get(peerId) !== pc) return;
      for (const candidate of this.candidates.get(peerId) || [])
        await pc.addIceCandidate(candidate);
      this.candidates.set(peerId, []);
      if (description.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        if (this.connections.get(peerId) === pc)
          this.signal(peerId, {
            description: {
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp,
            },
          });
      }
    }
    if (Object.hasOwn(payload, "candidate")) {
      if (!pc.remoteDescription)
        this.candidates.get(peerId)?.push(payload.candidate);
      else await pc.addIceCandidate(payload.candidate);
    }
  }

  attachChannel(peerId, channel) {
    if (channel.label !== "control") {
      channel.close();
      return;
    }
    const existing = this.channels.get(peerId);
    if (existing && existing !== channel) existing.close();
    this.channels.set(peerId, channel);
    channel.onopen = () => {
      if (this.role === "host")
        channel.send(
          JSON.stringify({
            v: 1,
            kind: "stream-state",
            active: Boolean(
              this.stream
                ?.getVideoTracks()
                .some((track) => track.readyState === "live"),
            ),
          }),
        );
      this.emit("peer", {
        peerId,
        count: this.connectedPeerCount,
        state: "connected",
        transport: "data",
      });
    };
    channel.onmessage = (event) => {
      if (
        typeof event.data !== "string" ||
        encoder.encode(event.data).byteLength >= MAX_DATA_BYTES
      )
        return;
      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return;
      }
      if (envelope?.v !== 1) return;
      if (envelope.kind === "data" && Object.hasOwn(envelope, "message"))
        this.emit("data", { message: envelope.message, peerId });
      else if (
        envelope.kind === "stream-state" &&
        this.role === "viewer" &&
        typeof envelope.active === "boolean"
      ) {
        this.remoteStreamActive.set(peerId, envelope.active);
        this.emit("stream", {
          stream: envelope.active
            ? this.remoteStreams.get(peerId) || null
            : null,
          peerId,
        });
      }
    };
    channel.onclose = () => {
      if (this.connections.has(peerId))
        this.emit("peer", {
          peerId,
          count: this.connectedPeerCount,
          state: "control-closed",
        });
    };
    channel.onerror = () => {
      if (this.connections.has(peerId))
        this.emit("peer", {
          peerId,
          count: this.connectedPeerCount,
          state: "control-error",
        });
    };
  }

  async setStream(stream, { maxBitrate = this.maxBitrate } = {}) {
    if (this.role !== "host") throw new Error("只有主机可以发送视频流。");
    if (this.disposed) throw new Error("会话已释放。");
    if (
      stream !== null &&
      (!stream || typeof stream.getVideoTracks !== "function")
    )
      throw new Error("需要有效的视频流。");
    const track =
      stream?.getVideoTracks().find((track) => track.readyState === "live") ||
      null;
    if (stream && !track) throw new Error("视频流没有可用的视频轨道。");
    this.stream = stream;
    this.maxBitrate = this.validBitrate(maxBitrate);
    await Promise.all(
      [...this.senders.values()].map(async (sender) => {
        await sender.replaceTrack(track);
        await this.applyBitrate(sender);
      }),
    );
    const message = JSON.stringify({
      v: 1,
      kind: "stream-state",
      active: Boolean(track),
    });
    for (const channel of this.channels.values())
      if (channel.readyState === "open") channel.send(message);
  }

  validBitrate(value) {
    if (!Number.isFinite(value) || value < 100000 || value > 50000000)
      throw new Error("视频码率需为 100 Kbps 到 50 Mbps。");
    return Math.round(value);
  }
  async setBitrate(bitsPerSecond) {
    if (this.role !== "host") throw new Error("只有主机可以调整视频码率。");
    this.maxBitrate = this.validBitrate(bitsPerSecond);
    await Promise.all(
      [...this.senders.values()].map((sender) => this.applyBitrate(sender)),
    );
  }
  async applyBitrate(sender) {
    if (!sender) return;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    for (const encoding of parameters.encodings)
      encoding.maxBitrate = this.maxBitrate;
    parameters.degradationPreference = "maintain-resolution";
    await sender.setParameters(parameters);
  }

  broadcast(message, targetPeerId) {
    if (this.role !== "host") throw new Error("观看端不能广播消息。");
    const payload = serialize(message);
    let sent = 0;
    for (const [peerId, channel] of this.channels) {
      if (targetPeerId !== undefined && peerId !== targetPeerId) continue;
      if (
        channel.readyState === "open" &&
        channel.bufferedAmount < MAX_BUFFERED_BYTES
      ) {
        channel.send(payload);
        sent++;
      }
    }
    return sent;
  }
  send(message) {
    if (this.role !== "viewer")
      throw new Error("主机应使用 broadcast 发送消息。");
    const payload = serialize(message);
    const channel = this.channels.get(this.hostId);
    if (
      !channel ||
      channel.readyState !== "open" ||
      channel.bufferedAmount >= MAX_BUFFERED_BYTES
    )
      return false;
    channel.send(payload);
    return true;
  }

  peerFailed(peerId, message) {
    if (!this.connections.has(peerId)) return;
    this.dropPeer(peerId, "failed");
    if (this.role === "viewer") this.end("error", message, "peer-failed");
    else if (this.isActive)
      this.status("hosting", `观看端连接失败：${message}`);
  }

  dropPeer(peerId, state = "left") {
    const pc = this.connections.get(peerId);
    if (!pc) return;
    this.connections.delete(peerId);
    const channel = this.channels.get(peerId);
    if (channel) {
      channel.onopen =
        channel.onmessage =
        channel.onclose =
        channel.onerror =
          null;
      channel.close();
    }
    pc.onicecandidate =
      pc.onconnectionstatechange =
      pc.ontrack =
      pc.ondatachannel =
        null;
    pc.close();
    clearTimeout(this.disconnectTimers.get(peerId));
    this.disconnectTimers.delete(peerId);
    this.channels.delete(peerId);
    this.senders.delete(peerId);
    this.queues.delete(peerId);
    this.candidates.delete(peerId);
    this.remoteStreams.delete(peerId);
    this.remoteStreamActive.delete(peerId);
    this.stats.removePeer(peerId);
    if (this.role === "viewer") this.emit("stream", { stream: null, peerId });
    this.emit("peer", { peerId, count: this.connectedPeerCount, state });
  }

  end(state, message, reason) {
    const hadRoom = Boolean(this.room);
    const peerId = this.hostId;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "leave" }));
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
    }
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new Error(message));
      this.pending = null;
    }
    for (const id of [...this.connections.keys()]) this.dropPeer(id);
    this.stats.stop();
    this.room = null;
    this.clientId = null;
    this.hostId = null;
    // Caller owns the capture stream and its tracks; this layer never stops them.
    if (hadRoom)
      this.emit("data", { message: { type: "session-ended", reason }, peerId });
    this.emit("stats", emptyStreamStats());
    this.status(state, message);
  }

  leave() {
    this.end("idle", "已离开直播房间。", "leave");
  }
  dispose() {
    if (this.disposed) return;
    this.leave();
    this.stream = null;
    this.disposed = true;
  }
}
