import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test.skip(
  !process.env.SPARKSCOPE_REAL_E2E,
  "Use playwright.real.config.ts and a disposable backend",
);

async function signIn(page: Page, username: string) {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
}

test("real API journey: setup, SSH trust/replacement, saved views, disabled channels, CSRF, roles and logout", async ({
  page,
}) => {
  const fixture = JSON.parse(
    readFileSync(resolve("../.runtime/real-e2e.json"), "utf8"),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Create your workspace" }),
  ).toBeVisible();
  await page.getByLabel("Local setup code").fill(fixture.setup_code);
  await page.getByLabel("Username", { exact: true }).fill("browser-admin");
  await page
    .getByLabel("Password (at least 12 characters)")
    .fill("browser-test-password");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add device", exact: true }).click();
  await page.getByLabel("IP address or hostname").fill("127.0.0.1");
  await page
    .getByLabel("SSH port", { exact: true })
    .fill(String(fixture.ssh_port));
  await page.getByLabel("SSH username").fill("fixture");
  await page.getByLabel("SSH password").fill("fixture-password-one");
  const discoveryResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/discoveries") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Test connection" }).click();
  const discovery = await (await discoveryResponse).json();
  await expect(
    page.getByText(fixture.fingerprint, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save device", exact: true }),
  ).toHaveCount(0);
  const trustRejections = await page.evaluate(async (id: string) => {
    const session = await (await fetch("/api/v1/auth/me")).json();
    const headers = {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrf,
    };
    const save = await fetch("/api/v1/devices", {
      method: "POST",
      headers,
      body: JSON.stringify({ discovery_id: id, name: "Unverified fixture" }),
    });
    const wrongKey = await fetch(`/api/v1/discoveries/${id}/trust`, {
      method: "POST",
      headers,
      body: JSON.stringify({ fingerprint: "SHA256:wrong-fixture-key" }),
    });
    return [save.status, wrongKey.status];
  }, discovery.id);
  expect(trustRejections).toEqual([409, 409]);
  await page.getByRole("button", { name: "Trust this host & connect" }).click();
  await expect(page.getByText("Connected successfully")).toBeVisible();
  await page
    .getByLabel("Device name", { exact: true })
    .fill("Protocol fixture");
  await page.getByRole("button", { name: "Save device", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Protocol fixture/ }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Update connection", exact: true })
    .click();
  await page.getByLabel("SSH password").fill("fixture-password-two");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(
    page.getByText(fixture.fingerprint, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Trust this host & connect" }).click();
  await expect(page.getByText("Connected successfully")).toBeVisible();
  await page
    .getByRole("button", {
      name: /Save connection|Save device|Update connection/,
    })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const devices = await page.request.get("/api/v1/devices");
  expect(devices.status()).toBe(200);
  expect(await devices.text()).not.toContain("fixture-password");

  // Browser fetch includes the actual cookie but deliberately lacks CSRF.
  const csrfRejected = await page.evaluate(
    async () =>
      (
        await fetch("/api/v1/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "blocked",
            password: "browser-test-password",
            role: "viewer",
          }),
        })
      ).status,
  );
  expect(csrfRejected).toBe(403);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Monitoring views", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Configure monitoring views", exact: true })
    .click();
  await page
    .getByLabel("View name", { exact: true })
    .fill("Protocol monitoring");
  await page
    .getByRole("checkbox", { name: "Active incidents", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Configured clusters", exact: true })
    .uncheck();
  await page
    .getByLabel("Live chart window", { exact: true })
    .selectOption("60");
  await page
    .getByRole("button", { name: "Save new view", exact: true })
    .click();
  await expect(
    page.getByText("Protocol monitoring · Personal", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Monitoring views", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Configure monitoring views", exact: true })
    .click();
  await expect(
    page.getByText("Protocol monitoring · Personal", { exact: true }),
  ).toBeVisible();
  const savedViews = await (await page.request.get("/api/v1/views")).json();
  expect(savedViews).toHaveLength(1);
  expect(savedViews[0].config).toEqual({
    search: "",
    group: "",
    cluster: "",
    view: "devices",
    tv: false,
    page_size: 6,
    rotation_seconds: 20,
    device_ids: [],
    metric_keys: [],
    colors: {},
    summary_widgets: ["reporting", "power"],
    live_window_seconds: 60,
  });
  await page.keyboard.press("Escape");

  // Disabled test fixture: neither delivery enablement nor Send test is used.
  await page
    .getByRole("button", { name: "Operations & health", exact: true })
    .click();
  await page
    .getByLabel("Channel name", { exact: true })
    .fill("Disabled fixture");
  await page
    .getByLabel("HTTPS webhook URL", { exact: true })
    .fill("https://example.invalid/sparkscope-fixture");
  await expect(
    page.getByRole("checkbox", { name: "Enable alert delivery", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  await expect(
    page.getByText("Disabled fixture · webhook · Disabled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send test", exact: true }),
  ).toBeDisabled();
  const channels = await (
    await page.request.get("/api/v1/notification-channels")
  ).json();
  expect(channels).toHaveLength(1);
  expect(channels[0].enabled).toBe(false);
  expect(
    await (await page.request.get("/api/v1/notification-deliveries")).json(),
  ).toEqual([]);

  for (const role of ["viewer", "operator"]) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Users", exact: true }).click();
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill(`browser-${role}`);
    await page
      .getByLabel("Password (at least 12 characters)")
      .fill("browser-test-password");
    await page.getByRole("dialog").getByRole("combobox").selectOption(role);
    await page
      .getByRole("button", { name: "Create user", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await signIn(page, `browser-${role}`);
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get("/api/v1/users")).status()).toBe(403);
    expect(await (await page.request.get("/api/v1/views")).json()).toEqual([]);
    const forbiddenDiscovery = await page.evaluate(async () => {
      const session = await (await fetch("/api/v1/auth/me")).json();
      return (
        await fetch("/api/v1/discoveries", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
          },
          body: JSON.stringify({
            address: "127.0.0.1",
            username: "fixture",
            password: "fixture-password-one",
          }),
        })
      ).status;
    });
    expect(forbiddenDiscovery).toBe(403);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    expect((await page.request.get("/api/v1/devices")).status()).toBe(401);
    await signIn(page, "browser-admin");
  }
  expect((await (await page.request.get("/api/v1/views")).json())[0].id).toBe(
    savedViews[0].id,
  );
  expect(
    await (await page.request.get("/api/v1/notification-deliveries")).json(),
  ).toEqual([]);
  expect(errors).toEqual([]);
});
