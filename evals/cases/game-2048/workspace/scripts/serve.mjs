import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const port = parsePort(process.env.PORT ?? "4173");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new HttpError(403, "Forbidden");
    }
    if (!(await stat(target)).isFile()) {
      throw new HttpError(404, "Not found");
    }
    const body = await readFile(target);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes.get(path.extname(target)) ?? "application/octet-stream",
    });
    response.end(body);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 404;
    const message = error instanceof HttpError ? error.message : "Not found";
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${message}\n`);
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`2048 ready at http://127.0.0.1:${port}\n`);
});

function parsePort(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error("PORT must be an integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("PORT must be between 1 and 65535");
  }
  return parsed;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
