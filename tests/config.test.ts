import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PORT,
  GATEWAY_PROTOCOL_TOKEN,
  resolveApprovalMode,
  resolvePort,
} from "../src/cli/config.js";

test("the public protocol token is one fixed non-credential value", () => {
  assert.equal(GATEWAY_PROTOCOL_TOKEN, "gateway-for-premiere");
});

test("the broker has a stable loopback port", () => {
  assert.equal(resolvePort(undefined), DEFAULT_PORT);
  assert.equal(resolvePort("2966"), 2966);
});

test("invalid ports are rejected", () => {
  assert.throws(() => resolvePort("0"), /Invalid/);
  assert.throws(() => resolvePort("65536"), /Invalid/);
  assert.throws(() => resolvePort("not-a-port"), /Invalid/);
});

test("approval mode defaults to ask and validates explicit modes", () => {
  assert.equal(resolveApprovalMode(undefined), "ask");
  assert.equal(resolveApprovalMode("auto"), "auto");
  assert.equal(resolveApprovalMode("bypass"), "bypass");
  assert.throws(() => resolveApprovalMode("full-access"), /Invalid/);
});
