import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseWatchArgs } from "../src/watch.js";
import { serviceFiles, watchId, type WatchEntry } from "../src/watch-service.js";

const entry: WatchEntry = {
  id: "abcd1234", url: "https://www.figma.com/design/AbC123/My-File?node-id=1-2&t=x", agent: "claude", cwd: "/Users/me/My Project",
  tag: "#plsfix", interval: 60, anyone: false, from: ["ana@example.com"], log: "/Users/me/.config/figma-mcp-v2/watch/abcd1234.log", service: "", installedAt: ""
};
const cmd = { cmd: "/usr/local/bin/node", args: ["/opt/figma mcp/dist/index.js"], env: {} };

test("watch options parse with sensible defaults", () => {
  const o = parseWatchArgs(["https://www.figma.com/design/AbC123/x", "--from", "a,b", "--interval", "5"]);
  assert.equal(o.agent, "auto");
  assert.deepEqual(o.from, ["a", "b"]);
  assert.equal(o.interval, 15); // floor
  assert.throws(() => parseWatchArgs(["--agent", "x", "https://www.figma.com/design/AbC123/x"]), /--agent must be/);
});

test("watch ids are stable per file and project folder", () => {
  assert.equal(watchId(entry.url, "/a"), watchId("https://www.figma.com/design/AbC123/Other-name", "/a"));
  assert.notEqual(watchId(entry.url, "/a"), watchId(entry.url, "/b"));
});

test("launchd plist escapes the link and keeps the agent running", () => {
  const { file, content } = serviceFiles(entry, cmd, "darwin");
  assert.match(file, /Library\/LaunchAgents\/com\.figma-mcp-v2\.watch\.abcd1234\.plist$/);
  assert.match(content, /<string>https:\/\/www\.figma\.com\/design\/AbC123\/My-File\?node-id=1-2&amp;t=x<\/string>/);
  assert.match(content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(content, /<string>\/opt\/figma mcp\/dist\/index\.js<\/string>/);
  assert.match(content, /<key>WorkingDirectory<\/key><string>\/Users\/me\/My Project<\/string>/);
  assert.match(content, /<string>--from<\/string>\s*<string>ana@example\.com<\/string>/);
});

test("systemd unit quotes arguments with spaces", () => {
  const { content, unit } = serviceFiles(entry, cmd, "linux");
  assert.equal(unit, "figma-mcp-v2-watch-abcd1234.service");
  assert.match(content, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/figma mcp\/dist\/index\.js" "watch"/);
  assert.match(content, /Restart=always/);
});

test("Windows startup script runs hidden and logs to a file", () => {
  const { file, content } = serviceFiles({ ...entry, cwd: "C:\\\\Users\\\\Me\\\\proj", log: "C:\\\\logs\\\\w.log" }, { cmd: "C:\\\\node\\\\node.exe", args: ["C:\\\\x\\\\index.js"], env: {} }, "win32");
  assert.match(file, /Startup[\\/]figma-mcp-v2-watch-abcd1234\.vbs$/);
  assert.match(content, /sh\.Run "cmd \/c ""/);
  assert.match(content, /, 0, False/);
  assert.match(content, />> ""C:\\\\logs\\\\w\.log"" 2>&1/);
});
