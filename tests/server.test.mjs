import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createStaticServer } from "../scripts/server.mjs";
import { buildProject } from "../scripts/build.mjs";

let temporaryDirectory;
let fixture;
let server;
let port;
const html = "<!doctype html><title>Test observatory</title>";

before(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "event-horizon-test-"),
  );
  fixture = path.join(temporaryDirectory, "app");
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await mkdir(path.join(fixture, "public"), { recursive: true });
  await writeFile(path.join(fixture, "index.html"), html);
  await writeFile(
    path.join(fixture, "src", "main.js"),
    "export const ready = true;",
  );
  await writeFile(path.join(fixture, "src", "shader.glsl"), "void main() {}");
  await writeFile(
    path.join(fixture, "src", "style.css"),
    "body { margin: 0; }",
  );
  await writeFile(
    path.join(fixture, "public", "favicon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  await writeFile(path.join(fixture, ".secret"), "private fixture");
  await writeFile(
    path.join(temporaryDirectory, "outside.txt"),
    "outside fixture",
  );
  server = await createStaticServer({ rootDir: fixture });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (temporaryDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true });
});

function request(target, method = "GET") {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path: target, method },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("GET serves the entry point with query strings and browser security headers", async () => {
  const response = await request("/?demo=1");
  assert.equal(response.status, 200);
  assert.equal(response.body, html);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
});

test("HEAD retains GET metadata and sends no body", async () => {
  const response = await request("/index.html", "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.body, "");
  assert.equal(
    Number(response.headers["content-length"]),
    Buffer.byteLength(html),
  );
});

test("JavaScript, CSS, GLSL and SVG have usable MIME types", async () => {
  for (const [file, contentType] of [
    ["/src/main.js", "text/javascript; charset=utf-8"],
    ["/src/style.css", "text/css; charset=utf-8"],
    ["/src/shader.glsl", "text/plain; charset=utf-8"],
    ["/public/favicon.svg", "image/svg+xml"],
  ]) {
    const response = await request(file);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], contentType);
  }
});

test("missing files and directories return 404 without an HTML fallback", async () => {
  assert.equal((await request("/missing.js")).status, 404);
  assert.equal((await request("/src/")).status, 404);
});

test("unsupported methods return 405 and advertise GET and HEAD", async () => {
  const response = await request("/", "POST");
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET, HEAD");
});

test("raw and encoded traversal, dotfiles, and Windows path separators are blocked", async () => {
  for (const target of [
    "/../outside.txt",
    "/%2e%2e/outside.txt",
    "/src/%2e%2e/%2e%2e/outside.txt",
    "/.secret",
    "/%2esecret",
    "/%5c..%5coutside.txt",
  ]) {
    const response = await request(target);
    assert.equal(response.status, 403, target);
    assert.ok(!response.body.includes("fixture"));
  }
});

test("malformed percent encoding is rejected", async () => {
  assert.equal((await request("/%zz")).status, 400);
  assert.equal((await request("/%00")).status, 403);
});

test("symbolic links cannot expose files outside the static root", async (context) => {
  try {
    await symlink(
      temporaryDirectory,
      path.join(fixture, "external"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      context.skip(
        `This environment cannot create symbolic links: ${error.code}`,
      );
      return;
    }
    throw error;
  }
  assert.equal((await request("/external/outside.txt")).status, 403);
});

test("build packages relative paths, drops stale output, and omits private project files", async () => {
  await mkdir(path.join(fixture, "dist"), { recursive: true });
  await writeFile(path.join(fixture, "dist", "stale.txt"), "old build");
  const output = await buildProject(fixture);
  assert.equal(await readFile(path.join(output, "index.html"), "utf8"), html);
  assert.equal(
    await readFile(path.join(output, "src", "main.js"), "utf8"),
    "export const ready = true;",
  );
  assert.match(
    await readFile(path.join(output, "public", "favicon.svg"), "utf8"),
    /<svg/,
  );
  await assert.rejects(readFile(path.join(output, "stale.txt")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(path.join(output, ".secret")), {
    code: "ENOENT",
  });
  const builtServer = await createStaticServer({ rootDir: output });
  builtServer.listen(0, "127.0.0.1");
  await once(builtServer, "listening");
  const originalPort = port;
  try {
    port = builtServer.address().port;
    assert.equal((await request("/")).status, 200);
    assert.equal((await request("/src/main.js")).status, 200);
    assert.equal((await request("/public/favicon.svg")).status, 200);
  } finally {
    port = originalPort;
    await new Promise((resolve) => builtServer.close(resolve));
  }
});
