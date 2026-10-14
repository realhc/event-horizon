import test from "node:test";
import assert from "node:assert/strict";
import { readStreamStats, StreamStats } from "../src/stream-stats.js";

const report = (video, extras = []) =>
  new Map([
    [
      video.id || "video",
      { id: "video", type: "inbound-rtp", kind: "video", ...video },
    ],
    ...extras.map((item) => [item.id, item]),
  ]);
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("video bitrate and decoded FPS use report timestamp deltas", () => {
  const first = readStreamStats(
    report({
      timestamp: 1000,
      bytesReceived: 10000,
      framesDecoded: 30,
      packetsReceived: 100,
      packetsLost: 2,
    }),
  );
  assert.equal(first.result.bitrateKbps, null);
  assert.equal(first.result.fps, null);
  const second = readStreamStats(
    report({
      timestamp: 2500,
      bytesReceived: 385000,
      framesDecoded: 75,
      packetsReceived: 400,
      packetsLost: 5,
    }),
    first.samples,
  );
  assert.equal(second.result.bitrateKbps, 2000);
  assert.equal(second.result.fps, 30);
  assert.equal(second.result.frames, 75);
  assert.equal(second.result.packetsLost, 5);
  near(second.result.lossPercent, (3 / 303) * 100);
});

test("host uses outbound bytes/frames and actual remote RTCP packet loss", () => {
  const hostReport = (
    timestamp,
    bytesSent,
    framesSent,
    packetsSent,
    packetsLost,
  ) =>
    report(
      {
        type: "outbound-rtp",
        timestamp,
        bytesSent,
        framesSent,
        packetsSent,
        remoteId: "remote",
        codecId: "codec",
        encoderImplementation: "reported-encoder",
      },
      [
        { id: "remote", type: "remote-inbound-rtp", packetsLost },
        { id: "codec", type: "codec", mimeType: "video/H264" },
      ],
    );
  const first = readStreamStats(
    hostReport(1000, 1000, 10, 100, 2),
    undefined,
    "host",
  );
  const second = readStreamStats(
    hostReport(2000, 251000, 70, 200, 4),
    first.samples,
    "host",
  );
  assert.equal(second.result.bitrateKbps, 2000);
  assert.equal(second.result.fps, 60);
  assert.equal(second.result.packetsLost, 4);
  assert.equal(second.result.lossPercent, 2);
  assert.equal(second.result.codec, "video/H264");
  assert.equal(second.result.encoderImplementation, "reported-encoder");
  assert.equal(second.result.decoderImplementation, null);
});

test("RTT comes from the transport's selected ICE candidate pair", () => {
  const result = readStreamStats(
    report({ timestamp: 1000 }, [
      {
        id: "other",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 9,
      },
      { id: "selected", type: "candidate-pair", currentRoundTripTime: 0.014 },
      {
        id: "transport",
        type: "transport",
        selectedCandidatePairId: "selected",
      },
    ]),
  ).result;
  assert.equal(result.rttMs, 14);
});

test("unsupported statistics remain null and reported decoder details are retained", () => {
  const unknown = readStreamStats(new Map()).result;
  for (const name of [
    "bitrateKbps",
    "fps",
    "rttMs",
    "width",
    "height",
    "codec",
    "frames",
    "packetsLost",
    "lossPercent",
    "encoderImplementation",
    "decoderImplementation",
  ])
    assert.equal(unknown[name], null, name);
  const actual = readStreamStats(
    report({
      timestamp: 1000,
      frameWidth: 1280,
      frameHeight: 720,
      framesPerSecond: 24,
      decoderImplementation: "reported-decoder",
    }),
  ).result;
  assert.equal(actual.width, 1280);
  assert.equal(actual.height, 720);
  assert.equal(actual.fps, 24);
  assert.equal(actual.decoderImplementation, "reported-decoder");
});

test("counter resets never produce negative video rates or fabricated interval loss", () => {
  const first = readStreamStats(
    report({
      timestamp: 1000,
      bytesReceived: 90000,
      framesDecoded: 100,
      packetsReceived: 200,
      packetsLost: 4,
    }),
  );
  const reset = readStreamStats(
    report({
      timestamp: 2000,
      bytesReceived: 1000,
      framesDecoded: 1,
      packetsReceived: 5,
      packetsLost: 0,
    }),
    first.samples,
  );
  assert.equal(reset.result.bitrateKbps, null);
  assert.equal(reset.result.fps, null);
  assert.equal(reset.result.lossPercent, null);
  const next = readStreamStats(
    report({
      timestamp: 3000,
      bytesReceived: 126000,
      framesDecoded: 31,
      packetsReceived: 105,
      packetsLost: 1,
    }),
    reset.samples,
  );
  assert.equal(next.result.bitrateKbps, 1000);
  assert.equal(next.result.fps, 30);
  near(next.result.lossPercent, 100 / 101);
});

test("late packets revising cumulative loss downward give zero interval loss", () => {
  const first = readStreamStats(
    report({ timestamp: 1000, packetsReceived: 100, packetsLost: 4 }),
  );
  const next = readStreamStats(
    report({ timestamp: 2000, packetsReceived: 200, packetsLost: 3 }),
    first.samples,
  );
  assert.equal(next.result.packetsLost, 3);
  assert.equal(next.result.lossPercent, 0);
});

test("multiple peers sum transmitted bitrate while averaging FPS and RTT", async () => {
  let timestamp = 1000;
  const peerReport = (id, rate, fps, rtt) =>
    report(
      {
        id,
        type: "outbound-rtp",
        timestamp,
        bytesSent: (timestamp * rate) / 8,
        framesSent: (timestamp * fps) / 1000,
        packetsSent: timestamp / 10,
        frameWidth: id === "a" ? 1280 : 1920,
        frameHeight: id === "a" ? 720 : 1080,
      },
      [
        {
          id: "pair",
          type: "candidate-pair",
          nominated: true,
          state: "succeeded",
          currentRoundTripTime: rtt,
        },
      ],
    );
  const connections = new Map([
    [
      "a",
      {
        connectionState: "connected",
        getStats: async () => peerReport("a", 2000, 30, 0.01),
      },
    ],
    [
      "b",
      {
        connectionState: "connected",
        getStats: async () => peerReport("b", 1000, 60, 0.03),
      },
    ],
  ]);
  let aggregate;
  const collector = new StreamStats({
    role: "host",
    connections,
    onStats: (value) => {
      aggregate = value;
    },
  });
  await collector.collect();
  timestamp = 2000;
  await collector.collect();
  assert.equal(aggregate.bitrateKbps, 3000);
  assert.equal(aggregate.fps, 45);
  assert.equal(aggregate.rttMs, 20);
  assert.equal(aggregate.peers, 2);
  assert.equal(aggregate.state, "connected");
  assert.equal(aggregate.width, 1920);
  assert.equal(aggregate.height, 1080);
  collector.stop();
  await collector.collect();
  assert.equal(aggregate.bitrateKbps, null);
});
