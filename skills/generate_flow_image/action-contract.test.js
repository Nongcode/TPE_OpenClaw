import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const actionSource = fs.readFileSync(new URL("./action.js", import.meta.url), "utf8");

test("Flow image action rejects generated output that exactly matches an input reference", () => {
  assert.match(actionSource, /computeReadableFileHashes/);
  assert.match(actionSource, /Reference image hashes registered for QC/);
  assert.match(actionSource, /runPostGenerationQc\(downloadedImagePath, referenceImageHashes\)/);
  assert.match(actionSource, /generated image matches an input reference image byte-for-byte/);
});

test("Flow image action locks the browser profile before launching Playwright", () => {
  assert.match(actionSource, /withBrowserProfileLock/);
  assert.match(actionSource, /browserPath: parsed\.browser_path/);
  assert.match(actionSource, /userDataDir: parsed\.user_data_dir/);
  assert.match(actionSource, /profileName: parsed\.profile_name/);
});

test("Flow image action keeps the browser open on failed runs when auto close is disabled", () => {
  assert.match(actionSource, /let generationCompleted = false/);
  assert.match(actionSource, /parsed\.auto_close_browser \|\| generationCompleted/);
  assert.match(actionSource, /Auto close browser is disabled; disconnected Playwright and kept browser open/);
});

test("Flow image action rejects non-submit composer controls before clicking", () => {
  assert.match(actionSource, /isDangerousNonSubmit/);
  assert.match(actionSource, /text\.includes\("close"\)/);
  assert.match(actionSource, /text\.includes\("upload"\)/);
  assert.match(actionSource, /isModelSelector/);
  assert.match(actionSource, /blockedByDisabledButton/);
});

test("Flow image action fails fast when Flow does not accept submit", () => {
  assert.match(actionSource, /waitForPromptSubmitAccepted/);
  assert.match(actionSource, /FLOW_SUBMIT_FAILED: Flow composer did not accept the prompt/);
  assert.match(actionSource, /const errorCode = String\(error\.message \|\| ""\)\.startsWith\("FLOW_SUBMIT_FAILED"\)/);
});

test("Flow image action waits for the generation progress card before accepting output", () => {
  assert.match(actionSource, /collectGenerationProgressRegions/);
  assert.match(actionSource, /Flow generation still in progress percent=/);
  assert.match(actionSource, /imageRecordOverlapsRegion/);
  assert.match(actionSource, /trackedProgress=\$\{Boolean\(trackedProgressRegion\)\}/);
  assert.match(actionSource, /FALLBACK_FRESH_IMAGE_DELAY_MS/);
});

test("Flow image action dispatches input events after pasting into contenteditable composer", () => {
  assert.match(actionSource, /new InputEvent\("input"/);
  assert.match(actionSource, /element\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
  assert.match(actionSource, /Dispatched input\/change events for \$\{tagName\} composer/);
});
