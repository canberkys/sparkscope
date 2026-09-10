import { test, expect } from "@playwright/test";

test.use({ hasTouch: true });

const chart = (page: import("@playwright/test").Page) =>
  page.getByRole("slider", { name: "Inspect GPU utilization samples" });

test("history uses units, gaps and keyboard inspection with an optional range", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=2&history=gap#/devices/node-1");
  await expect(chart(page)).toBeVisible();
  await expect(page.locator(".history-line")).toHaveCount(2);
  await expect(page.locator(".history-chart h3")).toHaveText(
    "GPU utilization · %",
  );
  await expect(page.locator(".history-band")).toHaveCount(0);
  await page.getByLabel("Min/max band").check();
  await expect(page.locator(".history-band")).toHaveCount(2);
  await chart(page).focus();
  await page.keyboard.press("Home");
  await expect(chart(page)).toHaveAttribute("aria-valuenow", "1");
  await page.keyboard.press("ArrowRight");
  await expect(chart(page)).toHaveAttribute("aria-valuenow", "2");
  await expect(page.locator(".history-inspection")).toContainText("samples");
  await page.getByLabel("History range").selectOption("7776000");
  await expect(chart(page)).toBeVisible();
  await expect(page.locator(".history-method")).toContainText("Time zone:");
  await expect(page.locator(".history-plot text").last()).toContainText(
    /[A-Z][a-z]{2} \d/,
  );
});

test("Ollama metadata and endpoint capabilities do not invent history", async ({
  page,
}) => {
  await page.goto("/?demo=1&hosts=2#/devices/node-2");
  await page.getByLabel("History source").selectOption("service-node-2");
  await expect(
    page.getByRole("heading", { name: "Model metadata only" }),
  ).toBeVisible();
  await expect(page.getByLabel("History metric")).toHaveCount(0);
  await expect(page.locator(".history-plot")).toHaveCount(0);
  await expect(page.locator(".history-mode")).toHaveText("Synthetic data");
  await page.getByLabel("History source").selectOption("system");
  await expect(chart(page)).toBeVisible();
});

test("zero, single and empty data are distinct on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1&history=zero#/devices/node-1");
  await expect(chart(page)).toBeVisible();
  await expect(page.locator(".history-summary dd").first()).toHaveText("0 %");
  await page.goto("/?demo=1&history=single#/devices/node-1");
  await expect(chart(page)).toHaveAttribute("aria-valuemax", "1");
  await expect(page.locator(".history-dot")).toHaveCount(1);
  await expect(
    page.getByText("No recent samples.", { exact: false }),
  ).toBeVisible();
  await chart(page).tap();
  await expect(page.locator(".history-inspection")).toContainText("Bucket avg");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.goto("/?demo=1&history=empty#/devices/node-1");
  await expect(
    page.getByRole("heading", { name: "No samples in this range" }),
  ).toBeVisible();
  await expect(page.locator(".history-plot")).toHaveCount(0);
});

test("HTTP loading, real-time spacing and refresh failure preserve the last successful chart", async ({
  page,
}) => {
  const device = {
    id: "test-device",
    name: "Test GB10",
    address: "127.0.0.1",
    port: 22,
    username: "test",
    group: "Test",
    tags: [],
    status: "online",
    paused: false,
    archived: false,
    last_seen: Date.now() / 1000,
    stale: false,
    metrics: { "gpu.util_pct": 42 },
    error: null,
    host_key_verified: true,
    created_at: 0,
    revision: 1,
    services: [],
  };
  const user = {
    id: "test-user",
    username: "tester",
    role: "viewer",
    active: true,
  };
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failRefresh = false;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    if (path === "/history") {
      if (failRefresh) {
        await route.fulfill({
          status: 503,
          json: { detail: "Test history outage" },
        });
        return;
      }
      await pending;
      const start = Number(url.searchParams.get("from_ts"));
      const pts = [0, 60, 3000].map((offset, i) => ({
        ts: start + offset,
        value: [0, 20, 80][i],
        min: [0, 20, 80][i],
        max: [0, 20, 80][i],
        count: 1,
        bucket_seconds: 12,
        last_sample_ts: start + offset,
      }));
      await route.fulfill({ json: pts });
      return;
    }
    const responses: Record<string, unknown> = {
      "/auth/status": { setup_required: false },
      "/auth/me": { user, csrf: "test" },
      "/devices": [device],
      "/devices/test-device": device,
      "/events": [],
      "/alerts": [],
      "/services": [],
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto("/#/devices/test-device");
  await expect(
    page.getByRole("heading", { name: "Loading history…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No samples in this range" }),
  ).toHaveCount(0);
  release();
  await expect(chart(page)).toBeVisible();
  const xs = await page
    .locator(".history-dot")
    .evaluateAll((elements) =>
      elements.map((e) => Number(e.getAttribute("cx"))),
    );
  expect(xs).toHaveLength(3);
  expect((xs[1] - xs[0]) / (xs[2] - xs[0])).toBeCloseTo(60 / 3000, 3);
  failRefresh = true;
  // Exercise the actual 15-second refresh path. This suite uses a mocked HTTP API, not real device data.
  await expect(page.getByRole("alert")).toContainText("Refresh failed", {
    timeout: 20000,
  });
  await expect(chart(page)).toBeVisible();
  await expect(page.locator(".history-summary dd").first()).toHaveText("80 %");
});
