import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
  ".frag": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function respond(request, response, status, message) {
  const body = `${message}\n`;
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

/** Create a static HTTP server without opening a port; useful for tests and embedding. */
export async function createStaticServer({ rootDir = projectDirectory } = {}) {
  const root = await realpath(rootDir);
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      respond(request, response, 405, "Method not allowed");
      return;
    }
    let decoded;
    try {
      const requestPath = (request.url || "/").split("?")[0];
      if (!requestPath.startsWith("/"))
        throw new Error("Invalid request target");
      decoded = decodeURIComponent(requestPath);
    } catch {
      respond(request, response, 400, "Invalid request path");
      return;
    }
    const segments = decoded.split("/").filter(Boolean);
    if (
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      segments.some((segment) => segment.startsWith("."))
    ) {
      respond(request, response, 403, "Forbidden");
      return;
    }
    const candidate = path.resolve(
      root,
      ...segments,
      ...(segments.length === 0 ? ["index.html"] : []),
    );
    if (!isWithin(root, candidate)) {
      respond(request, response, 403, "Forbidden");
      return;
    }
    try {
      const resolved = await realpath(candidate);
      if (!isWithin(root, resolved)) {
        respond(request, response, 403, "Forbidden");
        return;
      }
      const info = await stat(resolved);
      if (!info.isFile()) {
        respond(request, response, 404, "Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          mimeTypes[path.extname(resolved).toLowerCase()] ||
          "application/octet-stream",
        "Content-Length": info.size,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(resolved);
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (!response.headersSent) {
        const status = ["ENOENT", "ENOTDIR"].includes(error.code) ? 404 : 500;
        respond(
          request,
          response,
          status,
          status === 404 ? "Not found" : "Unable to read file",
        );
      } else {
        response.destroy();
      }
    }
  });
}

function parseOptions(args) {
  let port = process.env.PORT || "5173";
  let rootDir = projectDirectory;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dist") rootDir = path.join(projectDirectory, "dist");
    else if (arg === "--port") port = args[++index];
    else if (arg.startsWith("--port=")) port = arg.slice(7);
    else if (/^\d+$/.test(arg)) port = arg;
    else
      throw new Error(
        `Unknown option: ${arg}. Usage: npm start -- --port 5174 [--dist]`,
      );
  }
  if (!/^\d+$/.test(String(port)) || Number(port) > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return { port: Number(port), rootDir };
}

async function main() {
  const { port, rootDir } = parseOptions(process.argv.slice(2));
  const server = await createStaticServer({ rootDir });
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Try: npm start -- --port ${port === 65535 ? 5173 : port + 1}`
        : `Unable to start server: ${error.message}`,
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Event Horizon is ready at http://127.0.0.1:${server.address().port}`,
    );
    console.log("Press Ctrl+C to stop.");
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`Unable to start server: ${error.message}`);
    process.exitCode = 1;
  });
}
