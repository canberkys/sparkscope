import { test, expect } from "@playwright/test";

test("hardware rules keep empty profiles, explicit GPU overrides and inherited sources", async ({
  page,
}) => {
  let policy: any = { profiles: {}, devices: {} };
  const writes: any[] = [];
  const device = {
    id: "hpe",
    name: "HPE H200",
    address: "10.0.0.2",
    port: 22,
    username: "observer",
    group: "Compute",
    tags: [],
    status: "online",
    paused: false,
    archived: false,
    last_seen: Date.now() / 1000,
    stale: false,
    metrics: {},
    info: {
      gpus: [
        {
          id: "GPU-12345678-1234-1234-1234-123456789012",
          uuid: "GPU-12345678-1234-1234-1234-123456789012",
          index: 0,
          name: "H200",
        },
      ],
    },
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/settings/hardware") {
      if (route.request().method() === "PUT") {
        policy = route.request().postDataJSON();
        writes.push(structuredClone(policy));
      }
      await route.fulfill({ json: policy });
      return;
    }
    const data: Record<string, unknown> = {
      "/auth/status": { setup_required: false },
      "/auth/me": {
        user: { id: "admin", username: "admin", role: "admin", active: true },
        csrf: "test",
      },
      "/devices": [device],
      "/alerts": [],
      "/services": [],
      "/users": [],
      "/audit": [],
      "/notification-channels": [],
      "/maintenance-windows": [],
      "/notification-deliveries": [],
      "/views": [],
      "/diagnostics": { ready: true },
      "/settings": {
        database: "SQLite",
        poll_seconds: 5,
        collector: { polls: 0 },
        thresholds: {},
        retention: {},
      },
      "/devices/hpe/thresholds": {
        "gpu.GPU-12345678-1234-1234-1234-123456789012.temp_c": {
          thresholds: [80, 90],
          source: "global",
          component_id: "GPU-12345678-1234-1234-1234-123456789012",
        },
      },
    };
    await route.fulfill({ json: data[path] ?? {} });
  });
  await page.goto("/#/settings");
  // The extension tab is selected by its actual visible text when integrated.
  const panel = page.getByRole("heading", {
    name: "Hardware profiles and overrides",
  });
  if (!(await panel.isVisible())) {
    await page
      .getByRole("button", { name: "Operations & health" })
      .first()
      .click();
  }
  await expect(panel).toBeVisible();
  await page
    .getByLabel("New hardware profile name")
    .fill("H200 operating policy");
  await page.getByRole("button", { name: "Create empty profile" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].profiles["H200 operating policy"].metrics).toEqual({});
  await page.getByLabel("Hardware policy device").selectOption("hpe");
  await page
    .getByLabel("Assigned device profile")
    .selectOption("H200 operating policy");
  await expect.poll(() => writes.length).toBe(2);
  await page.getByLabel("Hardware rule scope").selectOption("gpu");
  await page
    .getByLabel("Hardware policy GPU")
    .selectOption("GPU-12345678-1234-1234-1234-123456789012");
  await page.getByLabel("Hardware rule behavior").selectOption("custom");
  await expect(page.getByLabel("Hardware warning threshold")).toHaveValue("");
  await page.getByLabel("Hardware warning threshold").fill("75");
  await page.getByLabel("Hardware critical threshold").fill("85");
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(
    writes[2].devices.hpe.gpus["GPU-12345678-1234-1234-1234-123456789012"][
      "gpu.temp_c"
    ],
  ).toEqual([75, 85]);
  await page.getByLabel("Hardware rule behavior").selectOption("disabled");
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect.poll(() => writes.length).toBe(4);
  expect(
    writes[3].devices.hpe.gpus["GPU-12345678-1234-1234-1234-123456789012"][
      "gpu.temp_c"
    ],
  ).toBeNull();
  await page.getByLabel("Hardware rule behavior").selectOption("inherit");
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect.poll(() => writes.length).toBe(5);
  expect(
    writes[4].devices.hpe.gpus["GPU-12345678-1234-1234-1234-123456789012"],
  ).toEqual({});
  await page
    .getByText("Effective rules from the latest device sample", { exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "global", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
