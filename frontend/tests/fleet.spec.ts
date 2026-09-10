import { test, expect } from "@playwright/test";
test("50-device fleet filters, paging and device history", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=1&hosts=50");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(
    page.getByRole("button", { name: "GB10-50", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search devices" }).fill("GB10-04");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "GB10-04", exact: true }).click();
  await expect(page.getByRole("heading", { name: "GB10-04" })).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "Inspect GPU utilization samples" }),
  ).toBeVisible();
  await page.getByLabel("History range").selectOption("86400");
  await expect(
    page.getByRole("slider", { name: "Inspect GPU utilization samples" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("empty inventory to verified demo device", async ({ page }) => {
  await page.goto("/?demo=1&scenario=empty");
  await page
    .getByRole("button", { name: "Add your first device", exact: true })
    .click();
  await page.getByLabel("IP address or hostname").fill("10.20.0.99");
  await page.getByLabel("SSH username").fill("operator");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Verify this device’s identity")).toBeVisible();
  await page.getByRole("button", { name: "Trust this host & connect" }).click();
  await expect(page.getByText("Connected successfully")).toBeVisible();
  await page.getByLabel("Device name", { exact: true }).fill("New GB10");
  await page.getByRole("button", { name: "Save device", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New GB10" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("alerts acknowledge without resolving and command failure is explicit", async ({
  page,
}) => {
  await page.goto("/?demo=1&scenario=failure");
  await page.getByRole("button", { name: /^Alerts/ }).click();
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByText(/Acknowledged by operator/)).toBeVisible();
  await expect(page.locator(".badge.critical")).toBeVisible();
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Command", exact: true })
    .selectOption("reboot");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Review & confirm" }).click();
  await page.getByRole("button", { name: "Confirm & run" }).click();
  await expect(page.locator(".job-summary .badge")).toHaveText("failed");
  await page.locator(".job-summary").first().click();
  await expect(page.getByText("Exit code: 1")).toBeVisible();
});
test("viewer restrictions and mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1&role=viewer&hosts=10");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add device", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(10);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  const table = page.locator(".table-scroll");
  await table.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  expect(await table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(
    0,
  );
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Run command", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
test("keyboard dialog focus and escape", async ({ page }) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Add device", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add device", exact: true }),
  ).toBeFocused();
});
