import test from "node:test";
import assert from "node:assert/strict";
import { pickBestPromptCandidate } from "./prompt-input.js";

test("pickBestPromptCandidate prefers the bottom composer over top search fields", () => {
  const result = pickBestPromptCandidate([
    {
      selector: 'input[type="text"]',
      y: 26,
      text: "",
      placeholder: "",
      ariaLabel: "Tìm kiếm",
    },
    {
      selector: 'input[type="text"]',
      y: 19,
      text: "",
      placeholder: "",
      ariaLabel: "Search",
    },
    {
      selector: 'div[role="textbox"][contenteditable="true"]',
      y: 798,
      text: "Bạn muốn tạo gì?",
      placeholder: "",
      ariaLabel: "",
    },
  ]);

  assert.equal(result?.selector, 'div[role="textbox"][contenteditable="true"]');
  assert.equal(result?.y, 798);
});
