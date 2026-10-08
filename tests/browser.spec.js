import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#gpu-badge")).toContainText("WEBGL2");
  await expect(page.locator("#error-state")).toBeHidden();
  await expect
    .poll(async () => page.locator("#resolution").textContent())
    .toMatch(/\d+ × \d+/);
}
async function freeze(page) {
  if ((await page.locator("#pause").getAttribute("aria-label")) === "暂停动画")
    await page.locator("#pause").click();
  await expect(page.locator("#fps")).toHaveText("PAUSED");
  await page.waitForTimeout(150);
}
async function frame(page) {
  return page.locator("canvas").evaluate((canvas) => {
    const data = canvas.toDataURL();
    let hash = 2166136261;
    for (let i = 0; i < data.length; i++)
      hash = Math.imul(hash ^ data.charCodeAt(i), 16777619);
    return hash >>> 0;
  });
}
async function slider(page, selector, value) {
  await page.locator(selector).evaluate((node, next) => {
    node.value = String(next);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

test("GPU compiles, renders luminous pixels, and parameter changes reach the shader", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await freeze(page);
  const stats = await page.locator("canvas").evaluate((canvas) => {
    const gl = canvas.getContext("webgl2");
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(
      0,
      0,
      canvas.width,
      canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    let bright = 0,
      dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 140) bright++;
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 20) dark++;
    }
    return {
      bright,
      dark,
      total: canvas.width * canvas.height,
      error: gl.getError(),
    };
  });
  expect(stats.error).toBe(0);
  expect(stats.bright / stats.total).toBeGreaterThan(0.005);
  expect(stats.dark / stats.total).toBeGreaterThan(0.01);
  const original = await frame(page);
  await slider(page, "#temperature", 18000);
  await expect.poll(() => frame(page)).not.toBe(original);
  const blue = await frame(page);
  await page.locator("#lensing").uncheck();
  await expect.poll(() => frame(page)).not.toBe(blue);
  expect(errors).toEqual([]);
});

test("pause holds simulation, view controls and preset reset work", async ({
  page,
}) => {
  await ready(page);
  await freeze(page);
  const frozen = await frame(page);
  await page.waitForTimeout(250);
  expect(await frame(page)).toBe(frozen);
  await page.locator('[data-preset="faceOn"]').click();
  await expect(page.locator("#inclination")).toHaveValue("12");
  await expect.poll(() => frame(page)).not.toBe(frozen);
  const box = await page.locator("canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.6);
  await page.mouse.up();
  expect(
    Number(await page.locator("#inclination").inputValue()),
  ).toBeGreaterThan(12);
  await page.mouse.wheel(0, 300);
  await expect
    .poll(async () => Number(await page.locator("#distance").inputValue()))
    .toBeGreaterThan(21);
  await page.locator("#reset-all").click();
  await expect(page.locator("#inclination")).toHaveValue("82");
  await expect(page.locator("#temperature")).toHaveValue("7000");
  await page.locator("#quality").selectOption("performance");
  await expect
    .poll(async () => page.locator("canvas").evaluate((c) => c.width))
    .toBeLessThan(1100);
});

test("PNG and JSON downloads are valid; configurations import atomically", async ({
  page,
}) => {
  await ready(page);
  await freeze(page);
  const pngPromise = page.waitForEvent("download");
  await page.locator("#export-image").click();
  const png = await pngPromise;
  const data = await readFile(await png.path());
  expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(data.length).toBeGreaterThan(10000);
  await page.locator("#export-config").scrollIntoViewIfNeeded();
  const jsonPromise = page.waitForEvent("download");
  await page.locator("#export-config").click();
  const json = await jsonPromise;
  const config = JSON.parse(await readFile(await json.path(), "utf8"));
  expect(config.version).toBe(1);
  expect(config.parameters.spin).toBe(0.65);
  config.parameters.temperature = 12000;
  config.parameters.inclination = 32;
  await page
    .locator("#config-file")
    .setInputFiles({
      name: "observation.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(config)),
    });
  await expect(page.locator("#temperature")).toHaveValue("12000");
  await page
    .locator("#config-file")
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        '{"version":1,"parameters":{"temperature":9000,"spin":99}}',
      ),
    });
  await expect(page.locator("#toast")).toContainText("载入失败");
  await expect(page.locator("#temperature")).toHaveValue("12000");
});

test("keyboard panel controls and narrow screen remain usable", async ({
  page,
}) => {
  await ready(page);
  await page.locator("canvas").focus();
  await page.keyboard.press("h");
  await expect(page.locator("#control-panel")).toBeHidden();
  await page.keyboard.press("h");
  await expect(page.locator("#control-panel")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.locator("#temperature").scrollIntoViewIfNeeded();
  await expect(page.locator("#temperature")).toBeVisible();
  await expect(page.locator("#error-state")).toBeHidden();
});

test("reduced motion starts paused and still supports interactive rendering", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await expect(page.locator("#fps")).toHaveText("PAUSED");
  await page.locator('[data-preset="blue"]').click();
  await expect(page.locator("#temperature")).toHaveValue("18000");
  await expect(page.locator("#error-state")).toBeHidden();
});
test("GPU context can recover and fullscreen can resize without breaking rendering", async ({
  page,
}) => {
  await ready(page);
  await freeze(page);
  const supported = await page.locator("canvas").evaluate((canvas) => {
    const extension = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    setTimeout(() => extension.restoreContext(), 600);
    return true;
  });
  if (supported) {
    await expect(page.locator("#error-state")).toBeVisible();
    await expect(page.locator("#error-state")).toBeHidden({ timeout: 10000 });
    await expect(page.locator("#gpu-badge")).toContainText("WEBGL2");
    const frozen = await frame(page);
    await slider(page, "#exposure", 2);
    await expect.poll(() => frame(page)).not.toBe(frozen);
  }
  await page.locator("#fullscreen").click();
  await expect
    .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
    .toBe(true);
  await expect(page.locator("#error-state")).toBeHidden();
  await page.locator("#fullscreen").click();
  await expect
    .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
    .toBe(false);
});
