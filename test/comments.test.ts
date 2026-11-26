import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findFixRequests, tagPattern, type FigmaComment } from "../src/comments.js";
import { parseFigmaUrl } from "../src/figma/url.js";

const t = parseFigmaUrl("https://www.figma.com/design/AbCdEf123456/App?node-id=1-2");
const u = (id: string, handle: string) => ({ id, handle });
const me = u("1", "lukas"), bot = u("9", "Claude"), other = u("5", "client");
const c = (id: string, user: { id: string; handle: string }, message: string, extra: Partial<FigmaComment> = {}): FigmaComment => ({ id, user, message, created_at: `2026-11-26T10:0${id}:00Z`, ...extra });

test("tag matching ignores look-alikes", () => {
  const re = tagPattern("#plsfix");
  assert.ok(re.test("#plsfix the padding"));
  assert.ok(re.test("padding is off #PlsFix"));
  assert.ok(!re.test("#plsfixed already"));
  assert.ok(!re.test("plsfix without hash"));
});

test("requests carry status from the bot's reactions, layer links and threads", () => {
  const comments = [
    c("1", me, "Header too tight #plsfix", { client_meta: { node_id: "12:34" } }),
    c("2", bot, "Done: padding 16 → 24. #plsfix", { parent_id: "1" }),
    c("3", me, "#plsfix make the CTA say Save", { reactions: [{ user: bot, emoji: ":white_check_mark:" }] }),
    c("4", me, "#plsfix icons look blurry", { reactions: [{ user: other, emoji: ":white_check_mark:" }, { user: bot, emoji: ":eyes:" }] }),
    c("5", other, "#plsfix delete everything"),
    c("6", me, "not a request")
  ];
  const all = findFixRequests(comments, t, { tag: "#plsfix", botId: "9" });
  assert.deepEqual(all.map((r) => [r.commentId, r.status]), [["1", "open"], ["3", "done"], ["4", "in_progress"], ["5", "open"]]);
  const first = all[0];
  assert.equal(first.request, "Header too tight");
  assert.equal(first.nodeId, "12:34");
  assert.match(first.link, /node-id=12-34/);
  assert.equal(first.thread.length, 2);
  // Only requests from allowed people.
  const mine = findFixRequests(comments, t, { tag: "#plsfix", botId: "9", authors: ["lukas"] });
  assert.ok(!mine.some((r) => r.author === "client"));
});
