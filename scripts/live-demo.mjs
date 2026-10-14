import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "./server.mjs";

const headless = process.argv.includes("--headless");
const verify = process.argv.includes("--verify");
const demoScene = process.env.LIVE_SCENE || "blackHole";
const port = Number(process.env.LIVE_PORT || 5180);
const reportDirectory = fileURLToPath(
  new URL("../qa-output/", import.meta.url),
);
const screenshotDirectory = fileURLToPath(
  new URL("../docs/screenshots/", import.meta.url),
);
const server = await createStaticServer();
let chrome;
let edge;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([chrome?.close(), edge?.close()]);
  await new Promise((resolve) => server.close(resolve));
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const sharedArgs = [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
  chrome = await chromium.launch({
    channel: "chrome",
    headless,
    args: [...sharedArgs, "--window-position=0,0", "--window-size=1120,980"],
  });
  edge = await chromium.launch({
    channel: "msedge",
    headless,
    args: [...sharedArgs, "--window-position=1120,0", "--window-size=1120,980"],
  });
  const host = await chrome.newPage({
    viewport: { width: 1120, height: 900 },
    acceptDownloads: true,
  });
  const viewer = await edge.newPage({
    viewport: { width: 1120, height: 900 },
    acceptDownloads: true,
  });
  const errors = [];
  host.on("pageerror", (error) => errors.push(`Chrome: ${error.message}`));
  viewer.on("pageerror", (error) => errors.push(`Edge: ${error.message}`));
  const checks = [];
  const checked = (message) => {
    checks.push(message);
    console.log(`PASS ${message}`);
  };

  await host.goto(`${url}/`);
  await expect(host.locator("#gpu-badge")).toContainText("WEBGL2");
  await expect(host.locator("#error-state")).toBeHidden();
  await host.locator("#start-live").click();
  await expect(host.locator("#host-room")).toHaveText(/^[A-Z0-9]{6}$/);
  const room = await host.locator("#host-room").textContent();
  await viewer.goto(`${url}/viewer.html?room=${room}&auto=1`);
  await expect(viewer.locator("#connection-state")).toContainText("已连接", {
    timeout: 20000,
  });
  await expect
    .poll(() =>
      viewer
        .locator("#remote-video")
        .evaluate((video) => video.readyState >= 2 && video.videoWidth > 0),
    )
    .toBe(true);
  checked("Chrome GPU host → Edge video receiver connected over WebRTC");
  await expect(viewer.locator("#viewer-temperature")).toBeDisabled();
  await expect(viewer.locator("#viewer-scene-mode")).toBeDisabled();
  await expect(viewer.locator("canvas")).toHaveCount(0);
  checked(
    "Viewer performs video playback, with no WebGL canvas and read-only controls",
  );

  await viewer.locator("#request-control").click();
  await expect(host.locator("#control-request")).toBeVisible();
  await host.locator("#grant-control").click();
  await expect(viewer.locator("#viewer-temperature")).toBeEnabled();
  await expect(viewer.locator("#viewer-scene-mode")).toBeEnabled();
  await viewer.locator("#viewer-temperature").evaluate((input) => {
    input.value = "12000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(host.locator("#temperature")).toHaveValue("12000");
  await expect(viewer.locator("#viewer-temperature")).toHaveValue("12000");
  checked(
    "Host authorization and remote temperature update reach the GPU host via data channel",
  );
  if (verify) {
    const observer = await edge.newPage({
      viewport: { width: 1120, height: 900 },
    });
    observer.on("pageerror", (error) =>
      errors.push(`Edge observer: ${error.message}`),
    );
    await observer.goto(`${url}/viewer.html?room=${room}&auto=1`);
    await expect(observer.locator("#connection-state")).toContainText(
      "已连接",
      { timeout: 15000 },
    );
    await expect(host.locator("#live-peer-count")).toHaveText("2");
    await expect(observer.locator("#viewer-temperature")).toBeDisabled();
    await expect(observer.locator("#viewer-scene-mode")).toBeDisabled();
    await expect(viewer.locator("#viewer-temperature")).toBeEnabled();
    await observer.locator("#request-control").click();
    await host.locator("#grant-control").click();
    await expect(observer.locator("#viewer-temperature")).toBeEnabled();
    await expect(viewer.locator("#viewer-temperature")).toBeDisabled();
    await expect(viewer.locator("#viewer-scene-mode")).toBeDisabled();
    await observer.locator("#release-control").click();
    await expect(observer.locator("#viewer-temperature")).toBeDisabled();
    await observer.close();
    await expect(host.locator("#live-peer-count")).toHaveText("1");
    await viewer.locator("#request-control").click();
    await host.locator("#grant-control").click();
    await expect(viewer.locator("#viewer-temperature")).toBeEnabled();
    checked(
      "Multiple viewers share video while control grants target exactly one viewer",
    );
  }
  await viewer.locator('[data-live-preset="faceOn"]').click();
  await expect(host.locator("#inclination")).toHaveValue("12");
  await expect(viewer.locator("#viewer-inclination")).toHaveValue("12");
  checked("Remote presets synchronize on both browsers");
  await viewer.locator("#viewer-pause").click();
  await expect(host.locator("#fps")).toHaveText("PAUSED");
  await viewer.locator("#viewer-pause").click();
  await expect(host.locator("#pause")).toHaveAttribute(
    "aria-label",
    "暂停动画",
  );
  checked("Remote pause and resume work");

  if (verify) {
    for (const [scene, key, value] of [
      ["nebula", "nebulaDensity", 2.1],
      ["galaxy", "galaxyArms", 5],
      ["planet", "ringTilt", 65],
      ["star", "starActivity", 1.6],
    ]) {
      const videoTime = await viewer.locator("#remote-video").evaluate((video) => video.currentTime);
      await viewer.locator("#viewer-scene-mode").selectOption(scene);
      await expect(host.locator("#scene")).toHaveValue(scene);
      await expect(viewer.locator("#viewer-scene-mode")).toHaveValue(scene);
      await expect(viewer.locator(`#viewer-${key}`)).toBeVisible();
      await expect(viewer.locator(`#viewer-${key}`)).toBeEnabled();
      await viewer.locator(`#viewer-${key}`).evaluate((input, next) => {
        input.value = String(next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await expect(host.locator(`#${key}`)).toHaveValue(String(value));
      await expect(viewer.locator(`#viewer-${key}`)).toHaveValue(String(value));
      await expect(host.locator(`#${key}-value`)).not.toBeEmpty();
      await expect(viewer.locator(`#viewer-${key}-value`)).not.toBeEmpty();
      await expect.poll(() => viewer.locator("#remote-video").evaluate((video) => video.currentTime), {
        timeout: 15000,
      }).toBeGreaterThan(videoTime + 0.1);
      await expect(viewer.locator("#connection-state")).toContainText("已连接");
    }
    checked("Authorized viewer switches all celestial modes and updates their parameters without interrupting video");

    await host.locator("#scene").selectOption("nebula");
    await expect(viewer.locator("#viewer-scene-mode")).toHaveValue("nebula");
    await host.locator("#nebulaHue").evaluate((input) => {
      input.value = "40";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(viewer.locator("#viewer-nebulaHue")).toHaveValue("40");
    await expect(viewer.locator("#viewer-nebulaHue-value")).not.toBeEmpty();
    checked("Host scene and mode-specific parameter state propagate to the viewer");

    await host.locator("#revoke-control").click();
    await expect(viewer.locator("#viewer-scene-mode")).toBeDisabled();
    await expect(viewer.locator("#viewer-nebulaHue")).toBeDisabled();
    const revokedTime = await viewer.locator("#remote-video").evaluate((video) => video.currentTime);
    await expect.poll(() => viewer.locator("#remote-video").evaluate((video) => video.currentTime)).toBeGreaterThan(revokedTime + 0.1);
    await viewer.locator("#request-control").click();
    await host.locator("#grant-control").click();
    await expect(viewer.locator("#viewer-scene-mode")).toBeEnabled();
    await viewer.locator("#viewer-scene-mode").selectOption("blackHole");
    await expect(host.locator("#scene")).toHaveValue("blackHole");
    await expect(viewer.locator("#viewer-temperature")).toBeVisible();
    checked("Mode controls follow grant and revoke permissions while viewing continues");

    await host.locator("#stream-size").selectOption("1920x1080");
    await host.locator("#stream-fps").selectOption("60");
    await host.locator("#stream-bitrate").selectOption("2");
    await expect
      .poll(
        () =>
          viewer
            .locator("#remote-video")
            .evaluate((video) => `${video.videoWidth}x${video.videoHeight}`),
        { timeout: 15000 },
      )
      .toBe("1920x1080");
    checked(
      "Live capture settings update the video track without reconnecting",
    );
    await host.locator("#revoke-control").click();
    await expect(viewer.locator("#viewer-temperature")).toBeDisabled();
    await expect(viewer.locator("#viewer-scene-mode")).toBeDisabled();
    await expect
      .poll(() =>
        viewer.locator("#remote-video").evaluate((video) => video.currentTime),
      )
      .toBeGreaterThan(0);
    checked("Host revokes control while video continues");
    await viewer.locator("#request-control").click();
    await host.locator("#deny-control").click();
    await expect(viewer.locator("#request-control")).toBeEnabled();
    await expect(viewer.locator("#viewer-temperature")).toBeDisabled();
    await expect(viewer.locator("#viewer-scene-mode")).toBeDisabled();
    checked("Control denial keeps the viewer read-only");
    await viewer.locator("#leave-room").click();
    await expect(host.locator("#live-peer-count")).toHaveText("0");
    await viewer.locator("#join-room").click();
    await expect(viewer.locator("#connection-state")).toContainText("已连接", {
      timeout: 15000,
    });
    checked(
      "Viewer leave and reconnect clean up and rebuild the peer connection",
    );
  }

  await host.locator("#stream-size").selectOption("1280x720");
  await host.locator("#stream-fps").selectOption("30");
  await host.locator("#stream-bitrate").selectOption("6");
  await host.locator('[data-preset="cinematic"]').click();
  await expect
    .poll(
      () =>
        viewer
          .locator("#remote-video")
          .evaluate((video) => `${video.videoWidth}x${video.videoHeight}`),
      { timeout: 15000 },
    )
    .toBe("1280x720");
  await expect
    .poll(() => viewer.locator('[data-stat="resolution"]').textContent(), {
      timeout: 15000,
    })
    .toBe("1280 × 720");
  await expect
    .poll(
      async () => {
        const text = await viewer
          .locator('[data-stat="bitrate"]')
          .textContent();
        return parseFloat(text);
      },
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        parseFloat(await viewer.locator('[data-stat="fps"]').textContent()),
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);
  checked("Actual received bitrate and decoded FPS are reported");

  if (!verify && demoScene !== "blackHole") {
    await host.locator("#scene").selectOption(demoScene);
    await expect(viewer.locator("#viewer-scene-mode")).toHaveValue(demoScene);
    await expect(host.locator("#error-state")).toBeHidden();
    checked(`Visible demo is ready in ${demoScene} mode on both browsers`);
  }

  const stats = {};
  for (const key of ["bitrate", "fps", "loss", "rtt", "resolution", "codec"]) {
    stats[key] = await viewer.locator(`[data-stat="${key}"]`).textContent();
  }
  const report = {
    room,
    url,
    capturedAt: new Date().toISOString(),
    headless,
    checks,
    stats,
    gpu: await host.locator("#renderer-label").getAttribute("title"),
    encoder: await host.locator("#encoder-info").textContent(),
    decoder: await viewer.locator("#decoder-info").textContent(),
    errors,
  };
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(screenshotDirectory, { recursive: true });
  await host.locator("#control-panel .panel-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await host.screenshot({
    path: `${screenshotDirectory}webrtc-host.png`,
    fullPage: true,
  });
  await viewer.locator("#room-code").scrollIntoViewIfNeeded();
  await viewer.screenshot({
    path: `${screenshotDirectory}webrtc-viewer.png`,
    fullPage: true,
  });
  await writeFile(
    `${reportDirectory}webrtc-${headless ? "headless" : "chrome-edge"}.json`,
    JSON.stringify(report, null, 2),
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify(report, null, 2));

  if (verify) {
    const downloadPromise = host.waitForEvent("download");
    await host.locator("#export-stats").click();
    const download = await downloadPromise;
    await download.saveAs(`${reportDirectory}webrtc-stats.csv`);
    const { readFile } = await import("node:fs/promises");
    const csv = await readFile(`${reportDirectory}webrtc-stats.csv`, "utf8");
    if (csv.split(/\r?\n/).length < 2)
      throw new Error("统计导出缺少实际样本。");
    checked("Experiment statistics export to CSV");
    await host.locator("#stop-live").click();
    await expect(viewer.locator("#connection-state")).not.toContainText(
      "已连接",
    );
    await expect(viewer.locator("#remote-video")).toHaveJSProperty(
      "srcObject",
      null,
    );
    checked("Ending the host session stops the viewer and releases resources");
    await writeFile(
      `${reportDirectory}webrtc-headless.json`,
      JSON.stringify({ ...report, checks }, null, 2),
    );
    await shutdown();
  } else {
    console.log(
      `\n两个浏览器窗口已就绪。Chrome 主机：${url}/；Edge 观众：${url}/viewer.html?room=${room}`,
    );
    console.log("关闭两个测试窗口或在终端按 Ctrl+C，会结束本次演示服务。");
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    let closed = 0;
    host.once("close", async () => {
      closed++;
      await chrome.close().catch(() => {});
      if (closed === 2) shutdown();
    });
    viewer.once("close", async () => {
      closed++;
      await edge.close().catch(() => {});
      if (closed === 2) shutdown();
    });
  }
} catch (error) {
  console.error(error.stack || error.message);
  await mkdir(reportDirectory, { recursive: true });
  for (const [browser, name] of [
    [chrome, "host"],
    [edge, "viewer"],
  ]) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page)
      await page
        .screenshot({
          path: `${reportDirectory}failed-${name}.png`,
          fullPage: true,
        })
        .catch(() => {});
  }
  await shutdown();
  process.exitCode = 1;
}
