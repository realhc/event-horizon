/** Real RTC statistics. Missing browser fields remain null. */
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const sum = (values) => {
  const available = values.filter(finite);
  return available.length
    ? available.reduce((total, value) => total + value, 0)
    : null;
};
const mean = (values) => {
  const available = values.filter(finite);
  return available.length
    ? available.reduce((total, value) => total + value, 0) / available.length
    : null;
};
const labels = (values) =>
  [
    ...new Set(
      values.filter((value) => typeof value === "string" && value.length),
    ),
  ].join(" / ") || null;

export function emptyStreamStats(state = "idle", peers = 0) {
  return {
    bitrateKbps: null,
    fps: null,
    packetsLost: null,
    lossPercent: null,
    rttMs: null,
    width: null,
    height: null,
    codec: null,
    encoderImplementation: null,
    decoderImplementation: null,
    frames: null,
    peers,
    state,
  };
}

/** Extract one peer's video statistics using this report's own timestamps. */
export function readStreamStats(report, previous = new Map(), role = "viewer") {
  const outbound = role === "host";
  const kind = outbound ? "outbound-rtp" : "inbound-rtp";
  const result = emptyStreamStats();
  const samples = new Map();
  const bitrates = [],
    frameRates = [],
    lostTotals = [],
    lostDeltas = [],
    packetDeltas = [];
  const codecs = [],
    encoders = [],
    decoders = [],
    frames = [];
  const reports = [...report.values()];
  let largestFrame = 0;
  for (const stat of reports) {
    if (
      stat.type !== kind ||
      (stat.kind ?? stat.mediaType) !== "video" ||
      stat.isRemote
    )
      continue;
    const bytes = outbound ? stat.bytesSent : stat.bytesReceived;
    const frameCount = outbound ? stat.framesSent : stat.framesDecoded;
    const packets = outbound ? stat.packetsSent : stat.packetsReceived;
    const remote = outbound && stat.remoteId ? report.get(stat.remoteId) : null;
    const lost = outbound ? remote?.packetsLost : stat.packetsLost;
    const before = previous.get(stat.id);
    const seconds =
      before && finite(stat.timestamp)
        ? (stat.timestamp - before.timestamp) / 1000
        : null;
    if (
      seconds > 0 &&
      finite(bytes) &&
      finite(before.bytes) &&
      bytes >= before.bytes
    )
      bitrates.push(((bytes - before.bytes) * 8) / seconds / 1000);
    if (
      seconds > 0 &&
      finite(frameCount) &&
      finite(before.frames) &&
      frameCount >= before.frames
    )
      frameRates.push((frameCount - before.frames) / seconds);
    else if (finite(stat.framesPerSecond))
      frameRates.push(stat.framesPerSecond);
    if (finite(lost)) lostTotals.push(Math.max(0, lost));
    if (
      before &&
      finite(lost) &&
      finite(before.lost) &&
      finite(packets) &&
      finite(before.packets) &&
      packets >= before.packets
    ) {
      // RTCP loss can be revised downward by late packets; use zero interval loss then.
      lostDeltas.push(Math.max(0, lost - before.lost));
      packetDeltas.push(Math.max(0, packets - before.packets));
    }
    samples.set(stat.id, {
      timestamp: stat.timestamp,
      bytes,
      frames: frameCount,
      packets,
      lost,
    });
    if (finite(frameCount)) frames.push(frameCount);
    const pixels = stat.frameWidth * stat.frameHeight;
    if (finite(pixels) && pixels > largestFrame) {
      largestFrame = pixels;
      result.width = stat.frameWidth;
      result.height = stat.frameHeight;
    }
    const codec = stat.codecId && report.get(stat.codecId);
    if (codec?.mimeType) codecs.push(codec.mimeType);
    if (stat.encoderImplementation) encoders.push(stat.encoderImplementation);
    if (stat.decoderImplementation) decoders.push(stat.decoderImplementation);
  }
  result.bitrateKbps = sum(bitrates);
  result.fps = mean(frameRates);
  result.packetsLost = sum(lostTotals);
  result.frames = sum(frames);
  result.codec = labels(codecs);
  result.encoderImplementation = labels(encoders);
  result.decoderImplementation = labels(decoders);
  const intervalLost = sum(lostDeltas);
  const intervalPackets = sum(packetDeltas);
  const lossDenominator = finite(intervalPackets)
    ? intervalPackets + (outbound ? 0 : (intervalLost ?? 0))
    : null;
  result.lossPercent =
    lossDenominator > 0 && finite(intervalLost)
      ? Math.min(100, (intervalLost / lossDenominator) * 100)
      : null;
  let pair;
  for (const stat of reports) {
    if (stat.type === "transport" && stat.selectedCandidatePairId) {
      pair = report.get(stat.selectedCandidatePairId);
      if (pair) break;
    }
  }
  if (!pair)
    pair = reports.find(
      (stat) =>
        stat.type === "candidate-pair" &&
        stat.state === "succeeded" &&
        stat.nominated === true,
    );
  if (pair && finite(pair.currentRoundTripTime))
    result.rttMs = pair.currentRoundTripTime * 1000;
  return { result, samples, intervalLost, intervalPackets };
}

/** One-second aggregate monitoring, without overlapping getStats calls. */
export class StreamStats {
  constructor({ role, connections, onStats, interval = 1000 }) {
    this.role = role;
    this.connections = connections;
    this.onStats = onStats;
    this.interval = interval;
    this.previous = new Map();
    this.timer = null;
    this.running = false;
    this.generation = 0;
  }

  start() {
    if (this.timer) return;
    this.generation++;
    this.timer = setInterval(() => void this.collect(), this.interval);
    void this.collect();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    this.previous.clear();
  }

  removePeer(peerId) {
    this.previous.delete(peerId);
  }

  async collect() {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    const entries = [...this.connections.entries()];
    try {
      const reports = await Promise.all(
        entries.map(async ([peerId, pc]) => {
          try {
            const report = await pc.getStats();
            if (this.connections.get(peerId) !== pc) return null;
            const sample = readStreamStats(
              report,
              this.previous.get(peerId),
              this.role,
            );
            if (generation === this.generation)
              this.previous.set(peerId, sample.samples);
            return sample;
          } catch {
            return null;
          }
        }),
      );
      if (generation !== this.generation) return;
      const samples = reports.filter(Boolean);
      const connected = entries.filter(
        ([, pc]) => pc.connectionState === "connected",
      ).length;
      const state = connected
        ? "connected"
        : entries.length
          ? "connecting"
          : "idle";
      const aggregate = emptyStreamStats(state, connected);
      for (const name of ["bitrateKbps", "packetsLost", "frames"])
        aggregate[name] = sum(samples.map((sample) => sample.result[name]));
      aggregate.fps = mean(samples.map((sample) => sample.result.fps));
      aggregate.rttMs = mean(samples.map((sample) => sample.result.rttMs));
      for (const name of [
        "codec",
        "encoderImplementation",
        "decoderImplementation",
      ])
        aggregate[name] = labels(samples.map((sample) => sample.result[name]));
      const largest = samples
        .map((sample) => sample.result)
        .filter((sample) => finite(sample.width) && finite(sample.height))
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (largest) {
        aggregate.width = largest.width;
        aggregate.height = largest.height;
      }
      const lost = sum(samples.map((sample) => sample.intervalLost));
      const packets = sum(samples.map((sample) => sample.intervalPackets));
      const denominator = finite(packets)
        ? packets + (this.role === "host" ? 0 : (lost ?? 0))
        : null;
      aggregate.lossPercent =
        denominator > 0 && finite(lost)
          ? Math.min(100, (lost / denominator) * 100)
          : null;
      this.onStats(aggregate);
    } finally {
      this.running = false;
    }
  }
}
