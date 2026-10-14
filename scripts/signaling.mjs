import { randomInt, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_ROOMS = 32;
const MAX_PEERS = 8;
const ROOM_PATTERN = /^[A-Z0-9]{4,12}$/;
const ROOM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidPayload(payload) {
  if (!isObject(payload)) return false;
  const keys = Object.keys(payload);
  if (
    !keys.length ||
    keys.some((key) => !["description", "candidate"].includes(key))
  )
    return false;
  if (Object.hasOwn(payload, "description")) {
    const description = payload.description;
    if (
      !isObject(description) ||
      !["offer", "answer", "pranswer", "rollback"].includes(description.type)
    )
      return false;
    if (Object.keys(description).some((key) => !["type", "sdp"].includes(key)))
      return false;
    if (
      Object.hasOwn(description, "sdp") &&
      typeof description.sdp !== "string"
    )
      return false;
  }
  if (Object.hasOwn(payload, "candidate") && payload.candidate !== null) {
    const candidate = payload.candidate;
    if (!isObject(candidate)) return false;
    if (
      Object.keys(candidate).some(
        (key) =>
          ![
            "candidate",
            "sdpMid",
            "sdpMLineIndex",
            "usernameFragment",
          ].includes(key),
      )
    )
      return false;
    if (
      Object.hasOwn(candidate, "candidate") &&
      typeof candidate.candidate !== "string"
    )
      return false;
    if (
      Object.hasOwn(candidate, "sdpMid") &&
      candidate.sdpMid !== null &&
      typeof candidate.sdpMid !== "string"
    )
      return false;
    if (
      Object.hasOwn(candidate, "sdpMLineIndex") &&
      candidate.sdpMLineIndex !== null &&
      (!Number.isInteger(candidate.sdpMLineIndex) ||
        candidate.sdpMLineIndex < 0 ||
        candidate.sdpMLineIndex > 65535)
    )
      return false;
    if (
      Object.hasOwn(candidate, "usernameFragment") &&
      candidate.usernameFragment !== null &&
      typeof candidate.usernameFragment !== "string"
    )
      return false;
  }
  return true;
}

function isSameOrigin(request) {
  try {
    if (
      typeof request.headers.origin !== "string" ||
      typeof request.headers.host !== "string"
    )
      return false;
    const protocol = request.socket.encrypted ? "https:" : "http:";
    const expected = new URL(`${protocol}//${request.headers.host}`);
    const supplied = new URL(request.headers.origin);
    return (
      LOOPBACK_HOSTS.has(expected.hostname) &&
      supplied.origin === expected.origin
    );
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, status, reason) {
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/** Attach a bounded, same-origin WebRTC signaling service to an HTTP server. */
export function attachSignaling(server) {
  const rooms = new Map();
  const clients = new Map();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  let disposed = false;

  function send(client, message) {
    if (!disposed && client?.socket.readyState === WebSocket.OPEN)
      client.socket.send(JSON.stringify(message));
  }

  function error(client, code, message) {
    send(client, { type: "error", code, message });
  }

  function leave(client) {
    const room = client.room;
    if (!room) return;
    client.room = null;
    client.role = null;
    if (room.host === client) {
      rooms.delete(room.code);
      for (const viewer of room.viewers.values()) {
        viewer.room = null;
        viewer.role = null;
        send(viewer, { type: "host-left" });
      }
      room.viewers.clear();
    } else {
      room.viewers.delete(client.id);
      send(room.host, { type: "peer-left", peerId: client.id });
    }
  }

  function nextRoomCode() {
    let code;
    do {
      code = Array.from(
        { length: 6 },
        () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)],
      ).join("");
    } while (rooms.has(code));
    return code;
  }

  function handleMessage(client, data, isBinary) {
    if (isBinary)
      return error(
        client,
        "INVALID_MESSAGE",
        "Signaling messages must be JSON text.",
      );
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return error(
        client,
        "INVALID_MESSAGE",
        "Signaling messages must contain valid JSON.",
      );
    }
    if (!isObject(message) || typeof message.type !== "string")
      return error(client, "INVALID_MESSAGE", "A message type is required.");
    if (message.type === "leave") {
      leave(client);
      return;
    }
    if (message.type === "create" || message.type === "join") {
      if (client.room)
        return error(
          client,
          "ALREADY_JOINED",
          "Leave the current room before entering another one.",
        );
      if (
        (message.type === "join" || Object.hasOwn(message, "room")) &&
        (typeof message.room !== "string" || !ROOM_PATTERN.test(message.room))
      ) {
        return error(
          client,
          "INVALID_ROOM",
          "Room codes must contain 4 to 12 uppercase letters or digits.",
        );
      }
      if (message.type === "create") {
        if (rooms.has(message.room))
          return error(
            client,
            "ROOM_EXISTS",
            "This room code is already in use.",
          );
        if (rooms.size >= MAX_ROOMS)
          return error(
            client,
            "ROOM_LIMIT",
            "The signaling service has reached its room limit.",
          );
        const room = {
          code: message.room ?? nextRoomCode(),
          host: client,
          viewers: new Map(),
        };
        rooms.set(room.code, room);
        client.room = room;
        client.role = "host";
        send(client, { type: "created", room: room.code, clientId: client.id });
      } else {
        const room = rooms.get(message.room);
        if (!room)
          return error(client, "ROOM_NOT_FOUND", "This room is unavailable.");
        if (room.viewers.size + 1 >= MAX_PEERS)
          return error(
            client,
            "ROOM_FULL",
            "This room has reached its participant limit.",
          );
        client.room = room;
        client.role = "viewer";
        room.viewers.set(client.id, client);
        send(client, {
          type: "joined",
          room: room.code,
          clientId: client.id,
          hostId: room.host.id,
        });
        send(room.host, { type: "peer-joined", peerId: client.id });
      }
      return;
    }
    if (message.type === "signal") {
      if (!client.room)
        return error(
          client,
          "NOT_JOINED",
          "Join a room before sending a signal.",
        );
      if (typeof message.to !== "string" || !clients.has(message.to))
        return error(
          client,
          "PEER_NOT_FOUND",
          "The target peer is unavailable.",
        );
      const target = clients.get(message.to);
      if (
        target === client ||
        target.room !== client.room ||
        (target.role !== "host" && client.role !== "host")
      ) {
        return error(
          client,
          "FORBIDDEN_SIGNAL",
          "Signals may only be sent between the host and its viewers.",
        );
      }
      if (!isValidPayload(message.payload))
        return error(
          client,
          "INVALID_SIGNAL",
          "A valid WebRTC description or ICE candidate is required.",
        );
      send(target, {
        type: "signal",
        from: client.id,
        payload: message.payload,
      });
      return;
    }
    error(
      client,
      "INVALID_MESSAGE",
      "This signaling message type is unsupported.",
    );
  }

  sockets.on("connection", (socket) => {
    const client = { id: randomUUID(), socket, room: null, role: null };
    clients.set(client.id, client);
    socket.on("message", (data, isBinary) =>
      handleMessage(client, data, isBinary),
    );
    // ws closes invalid UTF-8 and oversized frames; observe errors to avoid process-level failures.
    socket.on("error", () => {});
    socket.on("close", () => {
      leave(client);
      clients.delete(client.id);
    });
  });

  function upgrade(request, socket, head) {
    if ((request.url || "").split("?")[0] !== "/signaling") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (disposed || !isSameOrigin(request)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) =>
      sockets.emit("connection", connection, request),
    );
  }

  const originalClose = server.close;
  function closeWithSignaling(...args) {
    dispose();
    return originalClose.apply(this, args);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    server.removeListener("upgrade", upgrade);
    for (const client of clients.values()) {
      client.room = null;
      client.role = null;
      client.socket.terminate();
    }
    rooms.clear();
    clients.clear();
    sockets.close();
    if (server.close === closeWithSignaling) server.close = originalClose;
  }

  server.on("upgrade", upgrade);
  server.once("close", dispose);
  // HTTP close does not itself terminate upgraded sockets, so close those first.
  server.close = closeWithSignaling;
  return { dispose };
}
