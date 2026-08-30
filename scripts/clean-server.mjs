#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const output = fileURLToPath(new URL("../dist/", import.meta.url));
await rm(output, { recursive: true, force: true });
