import { test } from "node:test";
import assert from "node:assert/strict";
import { clean } from "../src/runner.ts";

test("terminal sanitization handles first OSC terminators, incomplete sequences, CSI and ordinary text", () => {
  for (const terminator of ["\x07", "\x1b\\", "\x9c"]) {
    assert.equal(clean(`before\x1b]title${terminator}middle\x1b]other${terminator}after`), "beforemiddleafter");
  }
  assert.equal(clean("before\x1b]unterminated\x1b]payload"), "before");
  assert.equal(clean("a\x9dhidden\x9cb"), "ab");
  assert.equal(clean("\x1b[31mred\x1b[0m\x9b2J"), "red");
  assert.equal(clean("text\x1b[31"), "text");
  assert.equal(clean("a\x00\r\x7f\x85b\tline\n🙂"), "ab\tline\n🙂");
  assert.equal(clean("\x1b".repeat(128 * 1024)), "");
});
test("unterminated OSC prefixes stay bounded at the lifecycle output limit", () => {
  assert.equal(clean("prefix" + "\x1b]".repeat(64 * 1024)), "prefix");
});
