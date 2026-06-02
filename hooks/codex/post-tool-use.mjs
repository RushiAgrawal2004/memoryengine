#!/usr/bin/env node
import { captureHookEvent } from "../lib/memory-hook.mjs";

await captureHookEvent("Codex", "post-tool-use");
