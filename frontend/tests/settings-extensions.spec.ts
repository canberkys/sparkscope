import { test, expect } from "@playwright/test";

async function settings(page: import("@playwright/test").Page) {
  await page.goto("/?demo=1&hosts=10#/settings");
  await page
    .getByRole("button", { name: "Operations & health", exact: true })
    .click();
  return page.locator(".panel").filter({
    has: page.getByRole("heading", {
      name: "Notification channels",
      exact: true,
    }),
  });
}

test("notification channel starts disabled, edit hides secrets, test is explicit simulation", async ({
  page,
}) => {
  const panel = await settings(page);
  await expect(panel).toContainText("Demo tests are simulated");
  await expect(panel.getByLabel("Enable alert delivery")).not.toBeChecked();
  await panel.getByLabel("Channel name").fill("Test webhook");
  await panel
    .getByLabel("HTTPS webhook URL")
    .fill("https://example.invalid/synthetic-only");
  await panel.getByLabel("Bearer token").fill("synthetic-token-only");
  await panel.getByRole("button", { name: "Add channel", exact: true }).click();
  const row = panel.locator(".row-between").filter({ hasText: "Test webhook" });
  await expect(row).toContainText("Disabled");
  await expect(
    row.getByRole("button", { name: "Send test", exact: true }),
  ).toBeDisabled();
  await expect(panel.locator("tbody tr")).toHaveCount(0);
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(panel.getByLabel("HTTPS webhook URL")).toHaveValue("");
  await expect(panel.getByLabel("Bearer token")).toHaveValue("");
  await panel.getByLabel("Channel name").fill("Updated webhook");
  await panel
    .getByRole("button", { name: "Save channel", exact: true })
    .click();
  const updated = panel
    .locator(".row-between")
    .filter({ hasText: "Updated webhook" });
  await updated.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(0);
  await updated.getByRole("button", { name: "Send test", exact: true }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await expect(panel.locator("tbody tr")).toContainText("simulated");
});

test("maintenance requires explicit scope and retains scope summary on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settings(page);
  const panel = page.locator(".panel").filter({
    has: page.getByRole("heading", {
      name: "Maintenance windows",
      exact: true,
    }),
  });
  await expect(
    panel.getByRole("button", { name: "Schedule maintenance", exact: true }),
  ).toBeDisabled();
  await panel.getByLabel("Maintenance name").fill("Inference maintenance");
  const local = (offset: number) => {
    const date = new Date(Date.now() + offset);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  };
  await panel.getByLabel("Start (local time)").fill(local(3600000));
  await panel.getByLabel("End (local time)").fill(local(7200000));
  await panel.getByLabel("Maintenance group").selectOption("Inference");
  await panel
    .getByLabel("Maintenance cluster")
    .selectOption("Inference cluster A");
  await panel
    .getByRole("button", { name: "Schedule maintenance", exact: true })
    .click();
  await expect(
    panel.locator(".row-between").filter({ hasText: "Inference maintenance" }),
  ).toContainText("Group: Inference · Cluster: Inference cluster A");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
