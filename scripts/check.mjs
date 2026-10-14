import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildProject } from "./build.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: project,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`检查失败：node ${args.join(" ")}`);
}
try {
  const sources = [];
  for (const directory of ["src", "scripts"]) {
    for (const name of await readdir(
      new URL(`../${directory}/`, import.meta.url),
    )) {
      if (/\.(m?js)$/.test(name)) sources.push(`${directory}/${name}`);
    }
  }
  for (const source of sources) run(["--check", source]);
  const tests = (await readdir(new URL("../tests/", import.meta.url)))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `tests/${name}`);
  run(["--test", ...tests]);
  console.log(`Static app built to ${await buildProject()}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
