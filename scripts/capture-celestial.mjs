import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "./server.mjs";

// Capture actual GPU output for every mode, using an isolated ephemeral server.
const screenshots = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
const evidence = fileURLToPath(new URL("../qa-output/", import.meta.url));
const server = await createStaticServer();
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await expect(page.locator("#gpu-badge")).toContainText("WEBGL2");
  await expect(page.locator("#error-state")).toBeHidden();
  await page.locator("#quality").selectOption("ultra");
  await mkdir(screenshots, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const captures = [];
  for (const mode of ["blackHole", "nebula", "galaxy", "planet", "star"]) {
    await page.locator("#scene").selectOption(mode);
    await expect(page.locator("#scene")).toHaveValue(mode);
    await page.locator("#quality").selectOption("ultra");
    await page.waitForTimeout(400);
    await expect(page.locator("#error-state")).toBeHidden();
    await page.locator("#control-panel .panel-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    const filename = `celestial-${mode}.png`;
    await page.screenshot({ path: `${screenshots}${filename}`, fullPage: true });
    const canvas = await page.locator("#universe").evaluate((element) => ({
      width: element.width,
      height: element.height,
      data: element.toDataURL("image/png").split(",")[1],
      glError: element.getContext("webgl2").getError(),
    }));
    await writeFile(`${screenshots}celestial-${mode}-render.png`, Buffer.from(canvas.data, "base64"));
    captures.push({ mode, filename, width: canvas.width, height: canvas.height, glError: canvas.glError });
    console.log(`Captured ${mode}: ${canvas.width} × ${canvas.height}`);
  }
  // Read the app's rendered-frame counter after two complete sampling windows.
  // These are device-specific snapshots, independent of WebRTC decode FPS.
  await page.locator("#pause").click();
  const renderingSamples = [];
  for (const mode of ["blackHole", "nebula", "galaxy", "planet", "star"]) {
    await page.locator("#scene").selectOption(mode);
    await page.waitForTimeout(1800);
    const fps = await page.locator("#fps").textContent();
    renderingSamples.push({ mode, quality: "balanced", fps });
    console.log(`Live GPU sample ${mode}: ${fps}`);
  }
  const report = {
    capturedAt: new Date().toISOString(),
    gpu: await page.locator("#renderer-label").getAttribute("title"),
    captures,
    renderingSamples,
    errors,
  };
  await writeFile(`${evidence}celestial-captures.json`, JSON.stringify(report, null, 2));
  if (errors.length || captures.some((capture) => capture.glError !== 0)) {
    throw new Error(`Celestial rendering failed: ${JSON.stringify(report)}`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
