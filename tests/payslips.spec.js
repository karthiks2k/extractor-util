const { expect, test } = require("@playwright/test");
const path = require("node:path");
const { downloadPayslip, openPayslipSearch } = require("./workflows/demo-payslip-page");

const maxAttempts = 3;
const retryDelayMs = 300;
const serverUrl = process.env.E2E_SERVER_URL || `http://127.0.0.1:${Number(process.env.PORT) || 4173}`;

async function reportProgress(files) {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) return;

  const successful = files.filter((file) => file.status === "downloaded").length;
  const failed = files.filter((file) => file.status === "failed").length;
  const response = await fetch(`${serverUrl}/api/runs/${runId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ total: files.length, successful, failed, files })
  });

  if (!response.ok) {
    throw new Error(`Could not report test progress: ${response.status}`);
  }
}

function waitBeforeRetry(attempt) {
  const delay = retryDelayMs * (2 ** (attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function downloadWithRetries(page, payslip, fileResult, files, testInfo) {
  const filePath = testInfo.outputPath("downloads", `${payslip.employeeNumber}.pdf`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    fileResult.attempts = attempt;
    fileResult.status = "downloading";
    fileResult.error = "";
    await reportProgress(files);

    let fileName;
    try {
      fileName = await downloadPayslip(
        page,
        payslip.row,
        payslip.employeeNumber,
        filePath,
        attempt
      );
    } catch (error) {
      fileResult.error = error.message.slice(0, 500);
      fileResult.status = attempt < maxAttempts ? "retrying" : "failed";
      await reportProgress(files);

      if (attempt < maxAttempts) {
        await waitBeforeRetry(attempt);
      }
      continue;
    }

    fileResult.fileName = fileName;
    fileResult.filePath = path.relative(process.cwd(), filePath);
    fileResult.status = "downloaded";
    await reportProgress(files);
    return;
  }
}

test("downloads matching payslips and retries transient failures", async ({ page }, testInfo) => {
  const filter = process.env.PAYSLIP_FILTER || "2025";
  const payslips = await openPayslipSearch(page, filter);
  const files = payslips.map(({ employeeNumber }) => ({
    employeeNumber,
    fileName: "",
    filePath: "",
    status: "pending",
    attempts: 0,
    error: ""
  }));
  await reportProgress(files);

  for (const [index, payslip] of payslips.entries()) {
    await downloadWithRetries(page, payslip, files[index], files, testInfo);
  }

  const simulatedEmployees = (process.env.E2E_SIMULATE_TRANSIENT_FAILURES || "")
    .split(",")
    .map((employeeNumber) => employeeNumber.trim())
    .filter(Boolean);

  if (simulatedEmployees.length > 0) {
    const simulatedFiles = files.filter((file) => simulatedEmployees.includes(file.employeeNumber));
    expect(simulatedFiles, "a simulated employee should match the selected filter").not.toHaveLength(0);

    for (const file of simulatedFiles) {
      expect(file.attempts, "the transient failure should be retried").toBe(2);
      expect(file.status).toBe("downloaded");
    }
  }

  expect(files.filter((file) => file.status === "failed"), "all matching payslips should download")
    .toHaveLength(0);
});
