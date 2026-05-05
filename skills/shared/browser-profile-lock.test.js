import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBrowserProfileLockIdentity,
  buildBrowserProfileLockPath,
  withBrowserProfileLock,
} from "./browser-profile-lock.js";

test("browser profile lock identity is stable for the same browser profile", () => {
  const first = buildBrowserProfileLockPath({
    browserPath: "C:/Browser/browser.exe",
    userDataDir: "C:/Users/Admin/AppData/Local/CocCoc/Browser/User Data",
    profileName: "Default",
  });
  const second = buildBrowserProfileLockPath({
    browserPath: "c:/browser/browser.exe",
    userDataDir: "C:/Users/Admin/AppData/Local/CocCoc/Browser/User Data".replaceAll("/", "\\"),
    profileName: "Default",
  });
  const third = buildBrowserProfileLockPath({
    browserPath: "C:/Browser/browser.exe",
    userDataDir: "C:/Users/Admin/AppData/Local/CocCoc/Browser/User Data",
    profileName: "Profile 2",
  });

  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.match(
    buildBrowserProfileLockIdentity({ browserPath: "C:/Browser/browser.exe", profileName: "Default" }),
    /default\|$/,
  );
});

test("browser profile lock serializes jobs sharing one profile", async () => {
  const logs = [];
  const events = [];
  const options = {
    browserPath: `test-browser-${process.pid}`,
    userDataDir: `test-user-data-${process.pid}`,
    profileName: "Default",
    timeoutMs: 1000,
    pollMs: 5,
    logs,
  };

  await Promise.all([
    withBrowserProfileLock(options, async () => {
      events.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push("a:end");
    }),
    withBrowserProfileLock(options, async () => {
      events.push("b:start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push("b:end");
    }),
  ]);

  const aStart = events.indexOf("a:start");
  const aEnd = events.indexOf("a:end");
  const bStart = events.indexOf("b:start");
  const bEnd = events.indexOf("b:end");
  const nonOverlapping =
    (aStart < aEnd && aEnd < bStart && bStart < bEnd) ||
    (bStart < bEnd && bEnd < aStart && aStart < aEnd);

  assert.equal(nonOverlapping, true);
  assert.match(logs.join("\n"), /Acquired browser profile lock/);
  assert.match(logs.join("\n"), /Released browser profile lock/);
});
