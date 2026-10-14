import { DEFAULTS, parseConfig } from "./params.js";

/** Validate a remote patch atomically, without resetting unrelated parameters. */
export function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("参数更新必须是一个对象。");
  }
  const keys = Object.keys(patch);
  if (!keys.length || keys.length > Object.keys(DEFAULTS).length) {
    throw new Error("参数更新为空或字段过多。");
  }
  if (keys.some((key) => !Object.hasOwn(DEFAULTS, key))) {
    throw new Error("包含无法识别的观测参数。");
  }
  const parsed = parseConfig(JSON.stringify({ version: 1, parameters: patch }));
  return Object.fromEntries(keys.map((key) => [key, parsed[key]]));
}

export function commandSequence(message) {
  if (!Number.isSafeInteger(message?.sequence) || message.sequence < 0) {
    throw new Error("控制指令需要有效序号。");
  }
  return message.sequence;
}
