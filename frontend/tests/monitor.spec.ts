import { test, expect } from "@playwright/test";

test("live device panels expand hardware and chart colors persist", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=2");
  const first = page.locator(".monitor-device").first();
  await expect(
    first.getByRole("button", { name: "Collapse GB10-01" }),
  ).toBeVisible();
  await expect(
    first.getByRole("heading", { name: "Top processes" }),
  ).toBeVisible();
  await expect(
    first.getByRole("slider", { name: "Inspect CPU samples" }),
  ).toBeVisible();
  await expect(
    first.getByRole("slider", { name: "Inspect GPU samples" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chart colors", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Chart colors" });
  await dialog.getByLabel("GPU chart color", { exact: true }).fill("#ff8800");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(first.locator('[aria-label="GPU history"]')).toHaveCSS(
    "--history-color",
    "#ff8800",
  );
  await page.reload();
  await expect(
    page
      .locator(".monitor-device")
      .first()
      .locator('[aria-label="GPU history"]'),
  ).toHaveCSS("--history-color", "#ff8800");
  await page.getByRole("button", { name: "Collapse GB10-01" }).click();
  await expect(page.locator("#monitor-node-1")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand GB10-01" }).click();
  await expect(page.locator("#monitor-node-1 .monitor-hardware")).toBeVisible();
});

test("explicit clusters keep membership separate from groups", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=10");
  await page.getByRole("button", { name: "Cluster view", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Inference cluster A", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Research cluster B", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Standalone devices", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".monitor-cluster-note")).toContainText(
    "does not verify cluster links",
  );
  await page.getByLabel("Monitor cluster").selectOption("Inference cluster A");
  await expect(page.locator(".monitor-device")).toHaveCount(2);
  await page.getByLabel("Monitor group").selectOption("Research");
  await expect(page.locator(".monitor-device")).toHaveCount(1);
  await expect(page.locator(".monitor-device h3")).toHaveText("GB10-02");
});

test("TV monitoring rotates pages and Escape restores navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?demo=1&hosts=50&mode=tv");
  await expect(
    page.getByRole("heading", { name: "SparkScope · Live TV" }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/monitor-tv/);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeHidden();
  await expect(page.locator(".monitor-device")).toHaveCount(6);
  await expect(page.locator(".monitor-pagination")).toContainText(
    "page 1 of 9",
  );
  await expect(page.locator(".monitor-pagination")).toContainText(
    "page 2 of 9",
    { timeout: 25000 },
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBeTruthy();
  await page.getByLabel("Rotate pages every 20s").uncheck();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/monitor-tv/);
});

test("mobile expansion has no horizontal overflow and keeps unavailable values explicit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1&hosts=2&scenario=offline");
  await expect(
    page.getByRole("button", { name: "Collapse GB10-01" }),
  ).toBeVisible();
  await expect(page.locator(".monitor-device").first()).toContainText(
    "No fresh telemetry",
  );
  await expect(page.locator(".monitor-mini-empty").first()).toContainText(
    "No samples yet",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("alarm and healthy cards keep equal collapsed heights and metric baselines", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.goto("/?demo=1&hosts=10");
  await expect(page.locator(".monitor-device")).toHaveCount(10);
  const boxes = await page.locator(".monitor-device").evaluateAll((cards) =>
    cards.slice(0, 3).map((card) => ({
      height: card.getBoundingClientRect().height,
      values: [...card.querySelectorAll(".monitor-hero-metrics strong")].map(
        (e) => e.getBoundingClientRect().top - card.getBoundingClientRect().top,
      ),
    })),
  );
  expect(
    Math.max(...boxes.map((b) => b.height)) -
      Math.min(...boxes.map((b) => b.height)),
  ).toBeLessThan(1);
  expect(
    new Set(boxes.flatMap((b) => b.values).map((y) => Math.round(y))).size,
  ).toBe(1);
});

test("mixed Linux fleet keeps CPU-only, dedicated memory and multiple GPUs distinct", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=4&hardware=mixed");
  await page
    .getByRole("button", { name: "Expand CPU-server-3", exact: true })
    .click();
  const cpu = page.locator(".monitor-device").nth(2);
  await expect(cpu).toContainText("System memory");
  await expect(
    cpu.getByRole("slider", { name: "Inspect CPU samples", exact: true }),
  ).toBeVisible();
  await expect(
    cpu.getByRole("slider", { name: "Inspect GPU samples", exact: true }),
  ).toHaveCount(0);
  await expect(cpu.locator(".monitor-hero-metrics")).toContainText(
    "Root disk used",
  );
  await page
    .getByRole("button", { name: "Expand Multi-GPU-4", exact: true })
    .click();
  const multi = page.locator(".monitor-device").nth(3);
  await expect(
    multi.getByRole("slider", {
      name: "Inspect GPU 0 utilization samples",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    multi.getByRole("slider", {
      name: "Inspect GPU 1 utilization samples",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".monitor-device")
    .nth(1)
    .getByRole("button", { name: "History & details" })
    .click();
  await expect(page.locator(".stats")).toContainText("NVIDIA RTX 4090");
  await expect(page.locator(".stats")).not.toContainText("unified memory");
});
