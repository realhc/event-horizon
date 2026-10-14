import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createStaticServer } from "../scripts/server.mjs";

let fixture;
before(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), "event-horizon-signaling-"));
  await writeFile(
    path.join(fixture, "index.html"),
    "<!doctype html><title>Signaling test</title>",
  );
});
after(async () => {
  if (
    fixture &&
    path.dirname(fixture) === os.tmpdir() &&
    path.basename(fixture).startsWith("event-horizon-signaling-")
  ) {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function harness(context) {
  const server = await createStaticServer({ rootDir: fixture });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin.replace("http:", "ws:")}/signaling`;
  context.after(() =>
    !server.listening
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
  );
  async function connect() {
    const socket = new WebSocket(url, { origin });
    const messages = [];
    const waiting = [];
    socket.on("error", () => {});
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const index = waiting.findIndex((waiter) => waiter.type === message.type);
      if (index < 0) messages.push(message);
      else {
        const [waiter] = waiting.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
    await once(socket, "open");
    return {
      socket,
      send: (message) => socket.send(JSON.stringify(message)),
      next: (type) => {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { type, resolve, timer: null };
          waiter.timer = setTimeout(() => {
            waiting.splice(waiting.indexOf(waiter), 1);
            reject(new Error(`Timed out waiting for ${type}`));
          }, 2000);
          waiting.push(waiter);
        });
      },
    };
  }
  return { server, origin, url, connect };
}

async function createRoom(host, room) {
  host.send(room === undefined ? { type: "create" } : { type: "create", room });
  return host.next("created");
}
async function joinRoom(host, viewer, room) {
  viewer.send({ type: "join", room });
  const joined = await viewer.next("joined");
  assert.deepEqual(await host.next("peer-joined"), {
    type: "peer-joined",
    peerId: joined.clientId,
  });
  return joined;
}
async function expectError(client, message, code) {
  client.send(message);
  const response = await client.next("error");
  assert.equal(response.code, code);
  assert.equal(typeof response.message, "string");
}
function rejectedUpgrade(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out waiting for rejected upgrade"));
    }, 2000);
    socket.on("error", () => {});
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
    socket.on("open", () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error("Upgrade unexpectedly succeeded"));
    });
  });
}

test("health endpoint reports signaling without exposing backend files", async (context) => {
  const app = await harness(context);
  const response = await fetch(`${app.origin}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(await response.json(), {
    service: "event-horizon",
    signaling: true,
  });
  const head = await fetch(`${app.origin}/api/health`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const target of [
    "/scripts/server.mjs",
    "/SCRIPTS/signaling.mjs",
    "/node_modules/ws/package.json",
    "/tests/signaling.test.mjs",
    "/package.json",
    "/package.json::$DATA",
  ]) {
    assert.equal((await fetch(`${app.origin}${target}`)).status, 403, target);
  }
});

test("cross-origin, missing-origin, non-loopback and unknown-path upgrades are rejected", async (context) => {
  const app = await harness(context);
  assert.equal(
    await rejectedUpgrade(app.url, { origin: "http://evil.example" }),
    403,
  );
  assert.equal(await rejectedUpgrade(app.url, {}), 403);
  assert.equal(
    await rejectedUpgrade(app.url, { origin: "http://127.0.0.1:1" }),
    403,
  );
  assert.equal(
    await rejectedUpgrade(app.url, {
      origin: "http://evil.example",
      headers: { Host: "evil.example" },
    }),
    403,
  );
  assert.equal(
    await rejectedUpgrade(
      app.url.replace("/signaling", "/scripts/signaling.mjs"),
      { origin: app.origin },
    ),
    404,
  );
});

test("create and join establish identities, and SDP/ICE relay unchanged", async (context) => {
  const app = await harness(context);
  const host = await app.connect();
  const viewer = await app.connect();
  const created = await createRoom(host);
  assert.match(created.room, /^[A-Z0-9]{6}$/);
  assert.match(created.clientId, /^[a-f0-9-]{36}$/);
  const joined = await joinRoom(host, viewer, created.room);
  assert.equal(joined.room, created.room);
  assert.equal(joined.hostId, created.clientId);
  assert.notEqual(joined.clientId, created.clientId);
  for (const [sender, recipient, senderId, recipientId, payload] of [
    [
      host,
      viewer,
      created.clientId,
      joined.clientId,
      { description: { type: "offer", sdp: "v=0\r\na=sendonly\r\n" } },
    ],
    [
      viewer,
      host,
      joined.clientId,
      created.clientId,
      { description: { type: "answer", sdp: "v=0\r\na=recvonly\r\n" } },
    ],
    [
      host,
      viewer,
      created.clientId,
      joined.clientId,
      {
        candidate: {
          candidate: "candidate:1 1 UDP 1 127.0.0.1 12345 typ host",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: "test",
        },
      },
    ],
    [viewer, host, joined.clientId, created.clientId, { candidate: null }],
  ]) {
    sender.send({ type: "signal", to: recipientId, payload });
    assert.deepEqual(await recipient.next("signal"), {
      type: "signal",
      from: senderId,
      payload,
    });
  }
});

test("viewer-to-viewer, self, cross-room and unjoined signals are rejected", async (context) => {
  const app = await harness(context);
  const host = await app.connect();
  const first = await app.connect();
  const second = await app.connect();
  const otherHost = await app.connect();
  const idle = await app.connect();
  const created = await createRoom(host, "ROOMA");
  const firstJoined = await joinRoom(host, first, created.room);
  const secondJoined = await joinRoom(host, second, created.room);
  const other = await createRoom(otherHost, "ROOMB");
  const payload = { candidate: null };
  await expectError(
    first,
    { type: "signal", to: secondJoined.clientId, payload },
    "FORBIDDEN_SIGNAL",
  );
  await expectError(
    host,
    { type: "signal", to: created.clientId, payload },
    "FORBIDDEN_SIGNAL",
  );
  await expectError(
    host,
    { type: "signal", to: other.clientId, payload },
    "FORBIDDEN_SIGNAL",
  );
  await expectError(
    idle,
    { type: "signal", to: firstJoined.clientId, payload },
    "NOT_JOINED",
  );
  await expectError(
    host,
    { type: "signal", to: "missing-peer", payload },
    "PEER_NOT_FOUND",
  );
});

test("invalid JSON, binary frames, room codes and RTC payloads return errors", async (context) => {
  const app = await harness(context);
  const host = await app.connect();
  const viewer = await app.connect();
  host.socket.send("{");
  assert.equal((await host.next("error")).code, "INVALID_MESSAGE");
  host.socket.send(Buffer.from("{}"));
  assert.equal((await host.next("error")).code, "INVALID_MESSAGE");
  await expectError(host, { type: "unsupported" }, "INVALID_MESSAGE");
  for (const room of [
    "abc",
    "lowercase",
    "TOO_LONG_ROOM_CODE",
    "ROOM!",
    1234,
    null,
  ]) {
    await expectError(host, { type: "create", room }, "INVALID_ROOM");
  }
  await expectError(
    viewer,
    { type: "join", room: "MISSING" },
    "ROOM_NOT_FOUND",
  );
  const created = await createRoom(host, "VALID1");
  await expectError(host, { type: "create" }, "ALREADY_JOINED");
  await expectError(
    viewer,
    { type: "create", room: created.room },
    "ROOM_EXISTS",
  );
  const joined = await joinRoom(host, viewer, created.room);
  for (const payload of [
    {},
    null,
    { description: { type: "unknown" } },
    { description: { type: "offer", sdp: 5 } },
    { candidate: { sdpMLineIndex: -1 } },
    { candidate: { candidate: 42 } },
    { candidate: null, unrelated: true },
  ]) {
    await expectError(
      host,
      { type: "signal", to: joined.clientId, payload },
      "INVALID_SIGNAL",
    );
  }
});

test("viewer leave and disconnect notify the host; the socket can rejoin", async (context) => {
  const app = await harness(context);
  const host = await app.connect();
  const viewer = await app.connect();
  const created = await createRoom(host, "REJOIN");
  const first = await joinRoom(host, viewer, created.room);
  viewer.send({ type: "leave" });
  assert.deepEqual(await host.next("peer-left"), {
    type: "peer-left",
    peerId: first.clientId,
  });
  assert.equal(
    (await joinRoom(host, viewer, created.room)).clientId,
    first.clientId,
  );
  viewer.socket.close();
  assert.deepEqual(await host.next("peer-left"), {
    type: "peer-left",
    peerId: first.clientId,
  });
});

test("host leave and disconnect remove rooms and release viewers for reuse", async (context) => {
  const app = await harness(context);
  const host = await app.connect();
  const first = await app.connect();
  const second = await app.connect();
  const created = await createRoom(host, "REUSE1");
  await joinRoom(host, first, created.room);
  await joinRoom(host, second, created.room);
  host.send({ type: "leave" });
  assert.deepEqual(await first.next("host-left"), { type: "host-left" });
  assert.deepEqual(await second.next("host-left"), { type: "host-left" });
  const reused = await createRoom(first, created.room);
  await joinRoom(first, second, reused.room);
  first.socket.close();
  assert.deepEqual(await second.next("host-left"), { type: "host-left" });
  assert.equal((await createRoom(second, created.room)).room, created.room);
});

test("the eight-participant room cap releases capacity when a viewer leaves", async (context) => {
  const app = await harness(context);
  const host = await app.connect();
  const created = await createRoom(host, "LIMIT8");
  const viewers = [];
  for (let index = 0; index < 7; index += 1) {
    const viewer = await app.connect();
    await joinRoom(host, viewer, created.room);
    viewers.push(viewer);
  }
  const extra = await app.connect();
  await expectError(extra, { type: "join", room: created.room }, "ROOM_FULL");
  viewers[0].send({ type: "leave" });
  await host.next("peer-left");
  await joinRoom(host, extra, created.room);
});

test("the 32-room service cap reclaims a departed host room", async (context) => {
  const app = await harness(context);
  const hosts = [];
  for (let index = 0; index < 32; index += 1) {
    const host = await app.connect();
    await createRoom(host, `ROOM${String(index).padStart(2, "0")}`);
    hosts.push(host);
  }
  const extra = await app.connect();
  await expectError(extra, { type: "create" }, "ROOM_LIMIT");
  hosts[0].send({ type: "leave" });
  await expectError(
    hosts[0],
    { type: "join", room: "ROOM00" },
    "ROOM_NOT_FOUND",
  );
  assert.equal((await createRoom(extra, "ROOM00")).room, "ROOM00");
});

test("frames above 64 KiB close with code 1009 and clean membership", async (context) => {
  const app = await harness(context);
  const host = await app.connect();
  const viewer = await app.connect();
  const created = await createRoom(host, "FRAME1");
  const joined = await joinRoom(host, viewer, created.room);
  const closed = new Promise((resolve) =>
    viewer.socket.once("close", (code) => resolve(code)),
  );
  viewer.socket.send("x".repeat(64 * 1024 + 1));
  assert.equal(await closed, 1009);
  assert.deepEqual(await host.next("peer-left"), {
    type: "peer-left",
    peerId: joined.clientId,
  });
});

test("HTTP server close disposes active WebSockets without client action", async (context) => {
  const app = await harness(context);
  const host = await app.connect();
  const viewer = await app.connect();
  const created = await createRoom(host, "CLOSE1");
  await joinRoom(host, viewer, created.room);
  const closed = [host, viewer].map(
    (client) => new Promise((resolve) => client.socket.once("close", resolve)),
  );
  await new Promise((resolve, reject) =>
    app.server.close((error) => (error ? reject(error) : resolve())),
  );
  await Promise.all(closed);
});
