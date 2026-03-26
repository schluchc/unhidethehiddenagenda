import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onRequestOptions, onRequestPost } from "./functions/api/analyze.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;
const port = Number(process.env.PORT || 8788);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/api/analyze") {
      await handleAnalyze(req, res);
      return;
    }

    await handleStatic(url.pathname, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, () => {
  console.log(`Local server running at http://localhost:${port}`);
  console.log("Required env for AI calls: OPENAI_API_KEY (or AI_API_KEY)");
});

async function handleAnalyze(req, res) {
  const bodyBuffer = await readBody(req);
  const request = new Request(`http://localhost:${port}/api/analyze`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuffer
  });

  const context = { request, env: process.env };
  let workerResponse;

  if (req.method === "OPTIONS") {
    workerResponse = await onRequestOptions(context);
  } else if (req.method === "POST") {
    workerResponse = await onRequestPost(context);
  } else {
    workerResponse = new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  res.statusCode = workerResponse.status;
  for (const [key, value] of workerResponse.headers.entries()) {
    res.setHeader(key, value);
  }

  const output = Buffer.from(await workerResponse.arrayBuffer());
  res.end(output);
}

async function handleStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const normalized = path.normalize(requested).replace(/^\.+/, "");
  const fullPath = path.resolve(rootDir, `.${normalized}`);

  if (!fullPath.startsWith(rootDir)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const finalPath = stat.isDirectory() ? path.join(fullPath, "index.html") : fullPath;
  const data = await fs.readFile(finalPath);
  const ext = path.extname(finalPath).toLowerCase();

  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypes[ext] || "application/octet-stream");
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
