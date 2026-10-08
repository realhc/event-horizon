import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "./server.mjs";
const server = await createStaticServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() =>
    document.querySelector("#gpu-badge").textContent.includes("WEBGL2"),
  );
  await page.waitForTimeout(1800);
  if (await page.locator("#error-state").isVisible())
    throw new Error(await page.locator("#error-message").textContent());
  const directory = fileURLToPath(
    new URL("../docs/screenshots/", import.meta.url),
  );
  await mkdir(directory, { recursive: true });
  console.log(
    "Renderer:",
    await page.locator("#renderer-label").getAttribute("title"),
  );
  console.log(
    "Live:",
    await page.locator("#fps").textContent(),
    await page.locator("#resolution").textContent(),
  );
  await page.screenshot({
    path: `${directory}observatory.png`,
    fullPage: true,
  });
  await page.locator("#pause").click();
  await page.locator("#quality").selectOption("ultra");
  await page.waitForTimeout(300);
  const snapshot = async (name) => {
    const data = await page
      .locator("canvas")
      .evaluate((canvas) => canvas.toDataURL("image/png").split(",")[1]);
    await writeFile(`${directory}${name}.png`, Buffer.from(data, "base64"));
  };
  await snapshot("cinematic");
  await page.locator('[data-preset="faceOn"]').click();
  await page.locator("#quality").selectOption("ultra");
  await page.waitForTimeout(300);
  await snapshot("polar");
  await page.locator('[data-preset="blue"]').click();
  await page.locator("#quality").selectOption("ultra");
  await page.waitForTimeout(300);
  await snapshot("high-energy");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Screenshots written to ${directory}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
