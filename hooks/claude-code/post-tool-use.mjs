#!/usr/bin/env node
import { captureHookEvent } from "../lib/memory-hook.mjs";

await captureHookEvent("Claude Code", "post-tool-use");
