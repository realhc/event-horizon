import { cp, mkdir, realpath, rm, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

/** Package the app as static files while retaining relative asset URLs. */
export async function buildProject(projectDir = projectDirectory) {
  const root = await realpath(projectDir);
  const output = path.resolve(root, "dist");
  if (path.dirname(output) !== root || path.basename(output) !== "dist") {
    throw new Error("Build output must be the project dist directory.");
  }
  for (const [name, shouldBeDirectory] of [
    ["index.html", false],
    ["src", true],
  ]) {
    const info = await stat(path.join(root, name));
    if (shouldBeDirectory ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`Invalid build input: ${name}`);
    }
  }
  try {
    if ((await lstat(output)).isSymbolicLink())
      throw new Error("Build output cannot be a symbolic link.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(path.join(root, "index.html"), path.join(output, "index.html"));
  await cp(path.join(root, "src"), path.join(output, "src"), {
    recursive: true,
  });
  try {
    const assets = path.join(root, "public");
    if ((await stat(assets)).isDirectory()) {
      await cp(assets, path.join(output, "public"), { recursive: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return output;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  buildProject()
    .then((output) => console.log(`Static app built to ${output}`))
    .catch((error) => {
      console.error(`Build failed: ${error.message}`);
      process.exitCode = 1;
    });
}
