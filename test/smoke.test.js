"use strict";
const test = require("node:test");
const assert = require("node:assert");

test("node:sqlite is available", () => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  assert.strictEqual(db.prepare("SELECT 1 AS x").get().x, 1);
});
