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
  const all = findFixRequests(comments, t, { tag: "#plsfix", botId: "9", separateBot: true });
  // Thread 1: the agent replied after the request, so it waits for the person.
  assert.deepEqual(all.map((r) => [r.commentId, r.status]), [["1", "answered"], ["3", "done"], ["4", "in_progress"], ["5", "open"]]);
  const first = all[0];
  assert.equal(first.request, "Header too tight");
  assert.equal(first.thread[1].agent, true);
  assert.equal(first.nodeId, "12:34");
  assert.match(first.link, /node-id=12-34/);
  assert.equal(first.thread.length, 2);
  // Only requests from allowed people.
  const mine = findFixRequests(comments, t, { tag: "#plsfix", botId: "9", separateBot: true, authors: ["lukas"] });
  assert.ok(!mine.some((r) => r.author === "client"));
});

test("a reply in a request thread reopens it as a follow-up, without the tag", () => {
  const comments = [
    c("1", me, "#plsfix header needs more padding", { client_meta: { node_id: "1:2" }, reactions: [{ user: bot, emoji: ":white_check_mark:" }] }),
    c("2", bot, "Done: padding 16 → 24.", { parent_id: "1" }),
    c("3", me, "still too tight, make it 32", { parent_id: "1" }),
    c("4", other, "I disagree", { parent_id: "1" })
  ];
  const [r] = findFixRequests(comments, t, { tag: "#plsfix", botId: "9", separateBot: true, authors: ["1"] });
  assert.equal(r.commentId, "3"); // latest message from an allowed person; the outsider's reply is context only
  assert.equal(r.status, "open");
  assert.equal(r.followUp, true);
  assert.equal(r.request, "still too tight, make it 32");
  assert.equal(r.thread.length, 4);
  // Resolving the thread closes the conversation.
  comments[0].resolved_at = "2026-11-26T11:00:00Z";
  assert.equal(findFixRequests(comments, t, { tag: "#plsfix", botId: "9", separateBot: true, authors: ["1"] })[0].status, "done");
});

test("threads without a tag from an allowed person are ignored", () => {
  const comments = [c("1", other, "#plsfix do something"), c("2", me, "agreed", { parent_id: "1" })];
  assert.equal(findFixRequests(comments, t, { tag: "#plsfix", botId: "9", separateBot: true, authors: ["1"] }).length, 0);
});

test("one shared account: the person's comments are requests, signed replies are the agent's", () => {
  // No bot account: replies are posted with the person's own account (botId === me).
  const comments = [
    c("1", me, "#plsfix header needs more padding", { client_meta: { node_id: "1:2" } }),
    c("2", me, "🤖 Done: padding 16 → 24.", { parent_id: "1" }),
    c("3", me, "still too tight, make it 32", { parent_id: "1" }),
    c("4", me, "#plsfix the logo is blurry")
  ];
  const r = findFixRequests(comments, t, { tag: "#plsfix", botId: "1", authors: ["1"] });
  assert.deepEqual(r.map((x) => [x.commentId, x.status, x.followUp]), [["3", "open", true], ["4", "open", false]]);
  assert.deepEqual(r[0].thread.map((m) => m.agent), [false, true, false]);
  // A reply remembered as posted by the agent counts as the agent's even without the signature.
  const old = [c("1", me, "#plsfix spacing"), c("2", me, "Done.", { parent_id: "1" })];
  assert.equal(findFixRequests(old, t, { tag: "#plsfix", botId: "1", authors: ["1"], agentIds: new Set(["2"]) })[0].status, "answered");
  // Without that memory, the unsigned reply is just the person talking.
  assert.equal(findFixRequests(old, t, { tag: "#plsfix", botId: "1", authors: ["1"] })[0].commentId, "2");
});
