const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createReadStream, statSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT) || 4173;
const maxBodySize = 32768;
const maxFilterLength = 100;
const defaultPage = process.argv.includes("--login") ? "/login/" : "/extractor-util/";
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
      if (body.length > maxBodySize) {
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

function getFilePath(requestPath) {
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return { error: "Bad request", statusCode: 400 };
  }

  const relativePath = decodedPath === "/" ? defaultPage : decodedPath;
  const filePath = path.resolve(root, `.${relativePath.endsWith("/") ? `${relativePath}index.html` : relativePath}`);

  if (!filePath.startsWith(`${root}${path.sep}`)) {
    return { error: "Forbidden", statusCode: 403 };
  }

  try {
    if (!statSync(filePath).isFile()) {
      return { error: "Not found", statusCode: 404 };
    }
  } catch {
    return { error: "Not found", statusCode: 404 };
  }

  return { filePath, statusCode: 200 };
}

function serveFile(requestPath, response) {
  const result = getFilePath(requestPath);

  if (result.statusCode !== 200) {
    response.writeHead(result.statusCode).end(result.error);
    return;
  }

  const contentType = result.filePath.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType });
  createReadStream(result.filePath).pipe(response);
}

function createRun(id, filter) {
  return {
    id,
    filter,
    status: "running",
    total: 0,
    successful: 0,
    failed: 0,
    files: [],
    message: "Starting Playwright tests."
  };
}

function startRunProcess(run) {
  const cliPath = require.resolve("@playwright/test/cli");
  const child = spawn(process.execPath, [
    cliPath,
    "test",
    "--config=playwright.config.js",
    "tests/payslips.spec.js"
  ], {
    cwd: root,
    env: {
      ...process.env,
      PAYSLIP_FILTER: run.filter,
      E2E_RUN_ID: run.id,
      E2E_SERVER_URL: `http://127.0.0.1:${port}`
    },
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
}

function normalizeFilter(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function isValidProgress(progress) {
  const validCount = (value) => Number.isInteger(value) && value >= 0;
  const validFileStatuses = new Set(["pending", "downloading", "retrying", "downloaded", "failed"]);

  if (
    !progress ||
    !Array.isArray(progress.files) ||
    !validCount(progress.total) ||
    progress.files.length !== progress.total
  ) {
    return false;
  }

  const validFiles = progress.files.every((file) =>
    file &&
    typeof file.employeeNumber === "string" &&
    file.employeeNumber.length > 0 &&
    file.employeeNumber.length <= 32 &&
    typeof file.fileName === "string" &&
    file.fileName.length <= 255 &&
    typeof file.filePath === "string" &&
    file.filePath.length <= 500 &&
    validFileStatuses.has(file.status) &&
    validCount(file.attempts) &&
    file.attempts <= 3 &&
    typeof file.error === "string" &&
    file.error.length <= 500
  );
  const successful = progress.files.filter((file) => file.status === "downloaded").length;
  const failed = progress.files.filter((file) => file.status === "failed").length;

  return validFiles &&
    validCount(progress.total) &&
    progress.successful === successful &&
    progress.failed === failed;
}

async function handleRunTests(request, response) {
  if (activeRunId) {
    sendJson(response, 409, { error: "A test run is already in progress." });
    return;
  }

  try {
    const body = await readJson(request);
    const filter = normalizeFilter(body.filter);

    if (!filter || filter.length > maxFilterLength) {
      sendJson(response, 400, { error: "Enter a filter of 1 to 100 characters." });
      return;
    }

    const id = randomUUID();
    const run = createRun(id, filter);
    runs.set(id, run);
    activeRunId = id;
    sendJson(response, 202, { id });

    startRunProcess(run);
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 400, { error: error.message });
    }
  }
}

async function handleProgressUpdate(request, response, runId) {
  const run = runs.get(runId);
  if (!run || run.id !== activeRunId) {
    sendJson(response, 404, { error: "Test run not found." });
    return;
  }

  try {
    const progress = await readJson(request);

    if (!isValidProgress(progress)) {
      sendJson(response, 400, { error: "Invalid progress values." });
      return;
    }

    Object.assign(run, {
      total: progress.total,
      successful: progress.successful,
      failed: progress.failed,
      files: progress.files,
      message: "Downloading matching payslips."
    });

    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

function handleStatusRequest(response, runId) {
  const run = runs.get(runId);
  if (!run) {
    sendJson(response, 404, { error: "Test run not found." });
    return;
  }

  sendJson(response, 200, run);
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "POST" && requestUrl.pathname === "/api/run-tests") {
    await handleRunTests(request, response);
    return;
  }

  const progressMatch = requestUrl.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/progress$/);
  if (request.method === "POST" && progressMatch) {
    await handleProgressUpdate(request, response, progressMatch[1]);
    return;
  }

  const statusMatch = requestUrl.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/);
  if (request.method === "GET" && statusMatch) {
    handleStatusRequest(response, statusMatch[1]);
    return;
  }

  if (request.method === "GET") {
    serveFile(requestUrl.pathname, response);
    return;
  }

  response.writeHead(405).end("Method not allowed");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Server page: http://0.0.0.0:${port}/`);
});
