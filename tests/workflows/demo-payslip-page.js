const { expect } = require("@playwright/test");
const { readFile } = require("node:fs/promises");

const fileNamePattern = /^EMP-\d+-\d{4}-[A-Za-z]+-payslip\.pdf$/;

async function openPayslipSearch(page, filter) {
  await page.goto("/login/");
  await page.getByLabel("Username").fill(process.env.E2E_USERNAME || "e2e-user");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD || "e2e-password");

  await Promise.all([
    page.waitForURL(/\/reports\/?$/),
    page.getByRole("button", { name: "Login" }).click()
  ]);
  await expect(page.getByRole("heading", { name: "Employee payslips" })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search payslips" }).fill(filter);
  await page.getByRole("button", { name: "Search" }).click();

  const rows = page.locator("#payslip-rows tr");
  const count = await rows.count();
  await expect(page.locator("#result-count")).toHaveText(
    `${count} ${count === 1 ? "record" : "records"}`
  );

  return Promise.all(Array.from({ length: count }, async (_, index) => {
    const row = rows.nth(index);
    return {
      employeeNumber: await row.locator("td").nth(0).innerText(),
      row
    };
  }));
}

function shouldSimulateFailure(employeeNumber, attempt) {
  const simulatedEmployees = (process.env.E2E_SIMULATE_TRANSIENT_FAILURES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return attempt === 1 && simulatedEmployees.includes(employeeNumber);
}

async function downloadPayslip(page, row, employeeNumber, filePath, attempt) {
  if (shouldSimulateFailure(employeeNumber, attempt)) {
    throw new Error(`Simulated transient failure for ${employeeNumber}.`);
  }

  const downloadLink = row.getByRole("link", { name: /^Download payslip for/ });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 5000 }),
    downloadLink.click()
  ]);

  const fileName = download.suggestedFilename();
  expect(fileName).toMatch(fileNamePattern);
  expect(fileName).toContain(employeeNumber);

  await download.saveAs(filePath);
  const contents = await readFile(filePath);
  expect(contents.subarray(0, 8).toString()).toBe("%PDF-1.4");

  return fileName;
}

module.exports = { downloadPayslip, openPayslipSearch };
