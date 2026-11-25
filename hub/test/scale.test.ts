// Regression tests for bugs found by the performance run (scripts/perf.ts, docs/PERF-RESULTS.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, memoryStore } from "../src/hub.ts";
import { keyFromSeed, signPolicy } from "../../packages/sdk-js/src/index.ts";
import { POLICY, T0, buildGroup, cardUrl, entryFor, feedUrl, publish, seed, type Group } from "../../scripts/synthetic.ts";

const memStore = memoryStore;
function setup(g: Group) {
  const store = memStore();
  let t = T0 + 86_400_000;
  const hub = new Hub({ store, fetch: g.web.fetcher, now: () => t, adminToken: "x", baseUrl: "https://hub.test" });
  return { hub, store, tick: (ms: number) => { t += ms; } };
}

test("a post signed with a rotated key is accepted once the hub refetches the card (15-minute TTL)", async () => {
  const g = await buildGroup(3, 2);
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const k2 = await keyFromSeed(seed(5000));
  const card = JSON.parse(g.web.docs.get(cardUrl(0))!);
  card.capabilities.extensions[0].params.keys = { keys: [k2.publicJwk] };
  g.web.docs.set(cardUrl(0), JSON.stringify(card));
  const post = await entryFor(0, 700, 0, k2); // before the hub clock (T0 + 24h): future-dated posts are held
  g.entries[0].push(post);
  publish(g.web, 0, g.entries[0]);
  tick(5 * 60_000);
  assert.deepEqual(await hub.refresh(id), [], "held while the hub still has the old key");
  tick(5 * 60_000);
  assert.deepEqual(await hub.refresh(id), [], "still held, and not re-checked against the same keys");
  tick(6 * 60_000);
  assert.deepEqual(await hub.refresh(id), [post.id], "accepted after the card TTL expires");
  const status = await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json() as any;
  assert.equal(status.rejected.filter((r: any) => r.id === post.id).length, 1, "logged once, not on every refresh");
});

test("a group holding more than maxEntries does not re-accept evicted entries on later refreshes", async () => {
  const g = await buildGroup(30, 20, { etags: false }); // 600 entries, maxEntries 500
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  const first = await hub.refresh(id);
  assert.ok(first.length <= 500, `first refresh reports only retained entries (got ${first.length})`);
  await hub.websub(new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": "https://sub.example/cb", "hub.topic": hub.groupFeedUrl(id) }));
  // Count signature verifications: evicted entries must not be re-verified on every refresh.
  const subtle = crypto.subtle as any;
  const verify = subtle.verify.bind(subtle);
  let verifies = 0;
  Object.defineProperty(subtle, "verify", { value: (...a: unknown[]) => { verifies++; return verify(...a); }, configurable: true });
  try {
    for (let k = 0; k < 3; k++) {
      g.web.resetCount();
      verifies = 0;
      tick(300_000);
      assert.deepEqual(await hub.refresh(id), [], `refresh ${k + 1}: nothing new`);
      assert.equal(g.web.posted.length, 0, `refresh ${k + 1}: no WebSub push without new entries`);
      assert.ok(verifies <= 1, `refresh ${k + 1}: ${verifies} signature verifications (only the policy's expected)`);
    }
  } finally {
    Object.defineProperty(subtle, "verify", { value: verify, configurable: true });
  }
  // A genuinely new post still gets through.
  tick(60_000);
  const e = await entryFor(0, 700, 0, g.keys[0]); // before the hub clock: future-dated posts are held
  g.entries[0].push(e);
  publish(g.web, 0, g.entries[0]);
  assert.deepEqual(await hub.refresh(id), [e.id]);
});

test("no stored row comes near the 2 MB SQLite row limit, even with large entries", async () => {
  // Was "under KV's 25 MiB value limit" (#12). Group state is now rows in a Durable Object, where the
  // limit is 2 MB per row: entries are one row each and the merged feed is stored in chunks.
  const g = await buildGroup(50, 10, { contentBytes: 60_000 }); // every entry and feed is within the hub's limits
  const { hub, store } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const rows = [...store.m.entries()].filter(([k]) => k.startsWith(`r:${id}:`));
  const largest = Math.max(...rows.map(([, v]) => v.length));
  assert.ok(largest < 1_000_000, `largest row is ${largest} bytes`);
  const xml = rows.filter(([k]) => k.startsWith(`r:${id}:xml:`));
  assert.ok(xml.length > 1, "the ~10 MiB merged feed is chunked");
  const r = await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`));
  assert.equal((await r.text()).length, xml.reduce((n, [, v]) => n + v.length, 0), "chunks reassemble to the served feed");
});

test("HEAD on the group feed answers like GET, without a body", async () => {
  const g = await buildGroup(3, 2);
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const r = await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`, { method: "HEAD" }));
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("etag"));
  assert.equal(await r.text(), "");
});

test("member feeds are fetched concurrently", async () => {
  const g = await buildGroup(12, 1, { latencyMs: 50 });
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id); // warms the card cache
  const t0 = performance.now();
  await hub.refresh(id);
  const ms = performance.now() - t0;
  // Policy + owner keys (2 sequential) + 12 feeds: sequential ≈ 700 ms, with a pool of 6 ≈ 200 ms.
  assert.ok(ms < 450, `refresh took ${ms.toFixed(0)} ms`);
  void feedUrl;
});

test("the validator verifies a hub's merged group feed entry by entry (atom:source), and still catches a forgery", async () => {
  const { validateFeedText } = await import("../../packages/sdk-js/src/index.ts");
  const g = await buildGroup(3, 2);
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const url = `https://hub.test/g/${id}/feed.atom`;
  const xml = await (await hub.handle(new Request(url))).text();
  const ok = await validateFeedText(xml, url, { fetcher: g.web.fetcher });
  assert.deepEqual(ok.filter((f) => f.level === "fail").map((f) => f.message), []);
  // Re-attribute one member's entry to another member: the other member's key must not verify it.
  const forged = xml.replace(feedUrl(1), feedUrl(2)).replace(cardUrl(1), cardUrl(2));
  const bad = await validateFeedText(forged, url, { fetcher: g.web.fetcher });
  assert.ok(bad.some((f) => f.level === "fail" && f.code.startsWith("sign-")), "forged attribution fails");
});

test("/validate can check the hub's own merged feed (answered in-process, not over the network)", async () => {
  const g = await buildGroup(3, 2);
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const target = encodeURIComponent(`https://hub.test/g/${id}/feed.atom`);
  const report = await (await hub.handle(new Request(`https://hub.test/validate?url=${target}`))).json() as any;
  assert.equal(report.ok, true, JSON.stringify(report.findings?.filter((f: any) => f.level === "fail")));
});

test("status.json reports retention, and two hubs on one group hold the same entries above the later floor (#5)", async () => {
  const small = await buildGroup(2, 3);
  const s = setup(small);
  const { id: sid } = await s.hub.register(POLICY);
  await s.hub.refresh(sid);
  const st = (await (await s.hub.handle(new Request(`https://hub.test/g/${sid}/status.json`))).json()) as any;
  assert.equal(st.retention.maxEntries, 500);
  assert.equal(st.retention.maxBytes, 10 * 1024 * 1024);
  assert.equal(st.retention.floor, null, "below capacity: no floor");
  assert.equal(st.retention.since, new Date(T0 + 86_400_000).toISOString(), "since = the first refresh");

  const g = await buildGroup(30, 20, { etags: false }); // 600 entries, over maxEntries
  const a = setup(g), b = setup(g);
  const { id } = await a.hub.register(POLICY);
  await b.hub.register(POLICY);
  b.tick(3_600_000); // the second hub starts an hour later
  await a.hub.refresh(id);
  await b.hub.refresh(id);
  const view = async (hub: Hub) => {
    const status = (await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json()) as any;
    const xml = await (await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`))).text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      id: /<id>(.*?)<\/id>/.exec(m[1])![1], updated: /<updated>(.*?)<\/updated>/.exec(m[1])![1], body: m[1],
    }));
    return { status, entries };
  };
  const va = await view(a.hub), vb = await view(b.hub);
  for (const v of [va, vb]) {
    assert.equal(v.status.entries, 500);
    const oldest = v.entries.map((e) => Date.parse(e.updated)).reduce((x, y) => Math.min(x, y));
    assert.equal(Date.parse(v.status.retention.floor), oldest, "floor = the oldest entry still held");
  }
  // Every member feed still serves every entry here, so `since` excuses nothing: compare above the later floor.
  const line = Math.max(Date.parse(va.status.retention.floor), Date.parse(vb.status.retention.floor));
  const above = (v: typeof va) => v.entries.filter((e) => Date.parse(e.updated) > line).map((e) => e.id + "\n" + e.body).sort();
  assert.ok(above(va).length > 0);
  assert.deepEqual(above(va), above(vb), "identical above the later floor");
});

test("a group that predates hub 0.8.4 gets `since` from its acceptance records, not the upgrade time (#5)", async () => {
  const g = await buildGroup(2, 3);
  const { hub, store } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id); // first refresh: T0 + 24h
  // Simulate a hub that ran before 0.8.4: no `since` stored, then a later upgrade stamped it with the upgrade time.
  const key = `r:${id}:meta:`;
  const meta = JSON.parse(store.m.get(key)!);
  meta.since = T0 + 86_400_000 + 30 * 86_400_000;
  delete meta.sinceChecked;
  store.m.set(key, JSON.stringify(meta));
  const t = T0 + 86_400_000 + 31 * 86_400_000;
  const upgraded = new Hub({ store, fetch: g.web.fetcher, now: () => t, adminToken: "x", baseUrl: "https://hub.test" });
  await upgraded.refresh(id);
  const st = (await (await upgraded.handle(new Request(`https://hub.test/g/${id}/status.json`))).json()) as any;
  assert.equal(st.retention.since, new Date(T0 + 86_400_000).toISOString(), "since = the first acceptance, not the upgrade");
});

test("status.json says when a standard policy has no hub, and still serves the group", async () => {
  const g = await buildGroup(2, 2);
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const ok = (await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json()) as any;
  assert.equal(ok.policyProblem, undefined, "a policy that names its hub has no problem");
  const p = JSON.parse(g.web.docs.get(POLICY)!);
  delete p.hub; delete p.sig; p.version = 2;
  g.web.docs.set(POLICY, JSON.stringify(await signPolicy(p, await keyFromSeed(seed(99_999)))));
  await hub.refresh(id);
  const st = (await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json()) as any;
  assert.match(st.policyProblem ?? "", /requires "hub"/);
  assert.equal(st.entries, 4, "the group is still served");
});
