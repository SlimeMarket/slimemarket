#!/usr/bin/env node
/** disk-free.mjs — report free space on the volume hosting this project. */
import { statfsSync } from "node:fs";

const s = statfsSync("C:\\");
const bs = Number(s.bsize);
const totalGB = (bs * Number(s.blocks)) / 1e9;
const freeBytes = bs * Number(s.bavail);
const freeGB = freeBytes / 1e9;

console.log("=== C: volume ===");
console.log("total:", totalGB.toFixed(2), "GB");
console.log("free :", freeGB.toFixed(4), "GB", `(${(freeBytes / 1e6).toFixed(1)} MB)`);
console.log("used :", (totalGB - freeGB).toFixed(2), "GB");

const verdict =
  freeBytes < 1e9
    ? "CRITICAL — under 1 GB free; builds and tools WILL fail"
    : freeBytes < 5e9
    ? "WARNING — under 5 GB free; builds are risky"
    : "OK";
console.log("verdict:", verdict);
