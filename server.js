const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createReadStream, statSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = __dirname;
const port = 4173;
const runs = new Map();
let activeRunId = null;

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function serveFile(requestPath, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  const relativePath = decodedPath === "/" ? "/test-runner/" : decodedPath;
  const filePath = path.resolve(root, `.${relativePath.endsWith("/") ? `${relativePath}index.html` : relativePath}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    if (!statSync(filePath).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
  } catch {
    response.writeHead(404).end("Not found");
    return;
  }

  const contentType = filePath.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "POST" && requestUrl.pathname === "/api/run-tests") {
    if (activeRunId) {
      sendJson(response, 409, { error: "A test run is already in progress." });
      return;
    }

    try {
      const body = await readJson(request);
      const filter = typeof body.filter === "string" ? body.filter.trim() : "";
      if (!filter || filter.length > 100) {
        sendJson(response, 400, { error: "Enter a filter of 1 to 100 characters." });
        return;
      }

      const id = randomUUID();
      const run = {
        id,
        filter,
        status: "running",
        total: 0,
        successful: 0,
        failed: 0,
        message: "Starting Playwright tests."
      };
      runs.set(id, run);
      activeRunId = id;
      sendJson(response, 202, { id });

      const cliPath = require.resolve("@playwright/test/cli");
      const child = spawn(process.execPath, [
        cliPath,
        "test",
        "--config=playwright.config.js",
        "tests/payslips.spec.js"
      ], {
        cwd: root,
        env: { ...process.env, PAYSLIP_FILTER: filter, E2E_RUN_ID: id },
        stdio: "ignore"
      });

      child.once("error", (error) => {
        run.status = "failed";
        run.message = `Could not start Playwright: ${error.message}`;
        activeRunId = null;
      });
      child.once("close", (code) => {
        run.status = code === 0 ? "passed" : "failed";
        run.message = code === 0 ? "Test run completed." : "One or more tests failed.";
        activeRunId = null;
      });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, { error: error.message });
    }
    return;
  }

  const progressMatch = requestUrl.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/progress$/);
  if (request.method === "POST" && progressMatch) {
    const run = runs.get(progressMatch[1]);
    if (!run || run.id !== activeRunId) {
      sendJson(response, 404, { error: "Test run not found." });
      return;
    }

    try {
      const progress = await readJson(request);
      const validCount = (value) => Number.isInteger(value) && value >= 0;
      if (
        !validCount(progress.total) ||
        !validCount(progress.successful) ||
        !validCount(progress.failed) ||
        progress.successful + progress.failed > progress.total
      ) {
        sendJson(response, 400, { error: "Invalid progress values." });
        return;
      }
      Object.assign(run, {
        total: progress.total,
        successful: progress.successful,
        failed: progress.failed,
        message: "Downloading matching payslips."
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  const statusMatch = requestUrl.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/);
  if (request.method === "GET" && statusMatch) {
    const run = runs.get(statusMatch[1]);
    if (!run) {
      sendJson(response, 404, { error: "Test run not found." });
      return;
    }
    sendJson(response, 200, run);
    return;
  }

  if (request.method === "GET") {
    serveFile(requestUrl.pathname, response);
    return;
  }
  response.writeHead(405).end("Method not allowed");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Test runner page: http://127.0.0.1:${port}/`);
});
