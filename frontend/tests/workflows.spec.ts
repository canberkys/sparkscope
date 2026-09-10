import { test, expect } from "@playwright/test";

test("device detail returns to exact list context", async ({ page }) => {
  await page.goto("/?demo=1&hosts=50#/devices?sort=status&view=cards&page=2");
  await expect(page.locator(".pagination")).toContainText("page 2 of 2");
  await expect(page.getByLabel("Sort devices")).toHaveValue("status");
  const first = page.locator(".device-card").first();
  const name = await first.locator("strong").first().textContent();
  await first.click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name!);
  await page.getByRole("button", { name: "All devices" }).click();
  await expect(page.locator(".pagination")).toContainText("page 2 of 2");
  await expect(page.locator(".device-card").first()).toContainText(name!);
  await expect(page).toHaveURL(/view=cards.*page=2/);
});

test("saved view config applies TV density and fixed rotation", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=10");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Saved monitoring views" });
  await dialog.getByLabel("Open in Live TV").check();
  await dialog.getByLabel("TV cards per page").selectOption("4");
  await dialog.getByLabel("Page rotation").selectOption("0");
  await dialog.getByRole("button", { name: "Apply without saving" }).click();
  await expect(page.locator("body")).toHaveClass(/monitor-tv/);
  await expect(page.locator(".monitor-device")).toHaveCount(4);
  await expect(
    page.getByRole("checkbox", { name: /Rotate pages/ }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/monitor-tv/);
});

test("comparison limits selection and uses common scale", async ({ page }) => {
  await page.goto("/?demo=1&hosts=10");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Compare devices & GPUs" });
  for (let i = 0; i < 4; i++) await dialog.getByRole("checkbox").nth(i).check();
  await expect(dialog.getByRole("checkbox").nth(4)).toBeDisabled();
  await expect(dialog.getByRole("slider")).toHaveCount(4);
  const axis = await dialog
    .locator(".history-plot svg")
    .evaluateAll((elements) =>
      elements.map((el) =>
        [...el.querySelectorAll("text")].map((t) => t.textContent).slice(0, 5),
      ),
    );
  expect(
    axis.every((a) => JSON.stringify(a) === JSON.stringify(axis[0])),
  ).toBeTruthy();
});

test("saved views support account persistence, update, copy and delete", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=10");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Saved monitoring views" });
  await dialog.getByLabel("View name").fill("Night wall");
  await dialog.getByRole("button", { name: "Save new view" }).click();
  const row = dialog.locator(".row-between").filter({ hasText: "Night wall" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("View name").fill("Night wall updated");
  await dialog.getByRole("button", { name: "Update view" }).click();
  await expect(
    dialog.locator(".row-between").filter({ hasText: "Night wall updated" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Saved monitoring views" });
  const saved = dialog
    .locator(".row-between")
    .filter({ hasText: "Night wall updated" });
  await saved.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(dialog.getByLabel("View name")).toHaveValue(
    "Night wall updated copy",
  );
  await dialog.getByRole("button", { name: "Save new view" }).click();
  await expect(dialog.locator(".row-between")).toHaveCount(2);
  await dialog
    .locator(".row-between")
    .filter({ hasText: "Night wall updated copy" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(dialog.locator(".row-between")).toHaveCount(1);
});

test("GPU model search matches mixed hardware case insensitively in monitor and devices", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=10&hardware=mixed");
  for (const query of ["h200", "4090", "gb10"]) {
    await page.getByLabel("Search monitored devices").fill(query);
    await expect(page.locator(".monitor-device").first()).toBeVisible();
  }
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  for (const query of ["H200", "4090", "GB10"]) {
    await page.getByLabel("Search devices").fill(query);
    await expect(page.locator("tbody tr").first()).toBeVisible();
  }
});

test("Settings configures saved monitoring summaries, filters, colors and chart window", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=10&hardware=mixed#/settings");
  await page
    .getByRole("button", { name: "Monitoring views", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Configure monitoring views", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Saved monitoring views" });
  await dialog.getByLabel("Search filter").fill("h200");
  await dialog.getByLabel("Active incidents", { exact: true }).uncheck();
  await dialog.getByLabel("GPU power", { exact: true }).uncheck();
  await dialog
    .getByLabel("Live chart window", { exact: true })
    .selectOption("60");
  await dialog.getByLabel("Saved gpu color").fill("#ff8800");
  await dialog
    .getByRole("button", { name: "Apply without saving", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Search monitored devices")).toHaveValue("h200");
  await expect(page.locator(".monitor-summary > *")).toHaveCount(2);
  await expect(page.locator(".monitor-window")).toContainText("up to 1 minute");
});

test("GPU temperature color follows active component incidents rather than a fixed hardware limit", async ({
  page,
}) => {
  const now = Date.now() / 1000;
  const device = {
    id: "h200",
    name: "H200 test",
    address: "127.0.0.1",
    port: 22,
    username: "test",
    group: "Test",
    tags: [],
    status: "online",
    paused: false,
    archived: false,
    last_seen: now,
    stale: false,
    metrics: { "gpu.GPU-test.temp_c": 95 },
    error: null,
    host_key_verified: true,
    created_at: now,
    revision: 1,
    services: [],
    info: {
      gpu: "NVIDIA H200",
      gpu_count: 1,
      gpus: [{ id: "GPU-test", index: 0, name: "NVIDIA H200", present: true }],
    },
  };
  let active = false;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const responses: Record<string, unknown> = {
      "/auth/status": { setup_required: false },
      "/auth/me": {
        user: {
          id: "viewer",
          username: "viewer",
          role: "viewer",
          active: true,
        },
        csrf: "test",
      },
      "/devices": [device],
      "/devices/h200": device,
      "/alerts": active
        ? [
            {
              id: "incident",
              device_id: "h200",
              metric: "gpu.GPU-test.temp_c",
              severity: "critical",
              message: "Configured H200 threshold exceeded",
              first_seen: now,
              last_seen: now,
              resolved_at: null,
              occurrences: 3,
            },
          ]
        : [],
      "/services": [],
      "/history": [],
      "/events": [],
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto("/#/devices");
  const temp = page.locator("tbody tr").first().locator("td").nth(5);
  await expect(temp).toContainText("95");
  await expect(temp).not.toHaveClass(/red|amber/);
  await page.getByRole("button", { name: "Open H200 test" }).click();
  const stat = page
    .locator(".stat")
    .filter({ hasText: "GPU temperature" })
    .locator(".stat-value");
  await expect(stat).toContainText("95");
  await expect(stat).not.toHaveClass(/red|amber/);
  active = true;
  await page.reload();
  await expect(stat).toHaveClass(/red/);
  active = false;
  await page.reload();
  await expect(stat).not.toHaveClass(/red|amber/);
});
