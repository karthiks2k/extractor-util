const { expect, test } = require("@playwright/test");
const { readFile } = require("node:fs/promises");

async function reportProgress(progress) {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) return;

  const response = await fetch(`http://127.0.0.1:4173/api/runs/${runId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(progress)
  });
  if (!response.ok) {
    throw new Error(`Could not report test progress: ${response.status}`);
  }
}

test("logs in, opens reports, and downloads matching payslips", async ({ page }, testInfo) => {
  await page.goto("/login/");

  await page.getByLabel("Username").fill(process.env.E2E_USERNAME || "e2e-user");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD || "e2e-password");
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForTimeout(1000);

  await expect(page).toHaveURL(/\/reports\/?$/);
  await expect(page.getByRole("heading", { name: "Employee payslips" })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search payslips" })
    .fill(process.env.PAYSLIP_FILTER || "2025");
  await page.getByRole("button", { name: "Search" }).click();

  const payslipRows = page.locator("#payslip-rows tr");
  const resultCount = await payslipRows.count();
  await expect(page.locator("#result-count")).toHaveText(
    `${resultCount} ${resultCount === 1 ? "record" : "records"}`
  );
  await reportProgress({ total: resultCount, successful: 0, failed: 0 });

  let successful = 0;
  let failed = 0;
  for (let index = 0; index < resultCount; index += 1) {
    const row = payslipRows.nth(index);
    const downloadLink = row.getByRole("link", { name: /^Download payslip for/ });

    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 5000 }),
        downloadLink.click()
      ]);

      const filename = download.suggestedFilename();
      expect(filename).toMatch(/^EMP-\d+-\d{4}-[A-Za-z]+-payslip\.pdf$/);

      const filePath = testInfo.outputPath(filename);
      await download.saveAs(filePath);
      const contents = await readFile(filePath);
      expect(contents.subarray(0, 8).toString()).toBe("%PDF-1.4");
      successful += 1;
      await page.waitForTimeout(1000);
    } catch (error) {
      failed += 1;
      console.error(`Payslip download failed: ${error.message}`);
    }

    await reportProgress({ total: resultCount, successful, failed });
  }

  expect(failed, "all matching payslips should download successfully").toBe(0);
});
