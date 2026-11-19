// The public mirror's server, on Lakebed. It answers the same /api/state and /api/feed as the
// real site, from a snapshot that `exosphere mirror` pushes to /api/mirror. It never talks to X,
// and visitors can't write anything: following is off, and each read position stays in its browser.
import { capsule, endpoint, json, number, string, table, text } from "lakebed/server";

const DAY = 86400;
const PAGE = 30;
const NEW_LIMIT = 500;
const STALE = 4 * 3600; // the pusher resends at least every 3 hours
const CHUNK = 60000; // a field holds 64 KiB, and the snapshot is ASCII, so one character is one byte
const MAX_BODY = 900 * 1024; // the whole deploy stores 1 MiB

type Person = { id: string; handle: string; name: string; avatar: string; protected: boolean; polled_at: number; error: string | null };
type Post = {
  id: string;
  at: number;
  fetched_at: number;
  backfill: boolean;
  cid: string;
  kind: string;
  reply_to?: { handle?: string };
  [key: string]: unknown;
};
type Snapshot = { pushed_at: number; creators: Person[]; posts: Post[] };

const now = () => Math.floor(Date.now() / 1000);

async function load(db: any): Promise<Snapshot> {
  const rows = await db.chunks.withIndex("by_part").collect();
  if (!rows.length) return { pushed_at: 0, creators: [], posts: [] };
  return JSON.parse(rows.map((row: { body: string }) => row.body).join(""));
}

// New is what was fetched since this browser last checked. A first visit gets the last day.
function newTest(query: URLSearchParams) {
  const given = Number(query.get("seen"));
  const seen = Number.isFinite(given) && given > 0 ? given : now() - DAY;
  const recent = Math.max(seen, now() - DAY);
  return (post: Post) => post.fetched_at > seen && (!post.backfill || post.at > recent);
}

// What someone put out themselves: posts, quotes and their own threads (db.py's OWN_POSTS).
function ownTest(query: URLSearchParams, people: Map<string, Person>) {
  if (query.get("only") !== "posts") return () => true;
  return (post: Post) =>
    post.kind === "post" || (post.reply_to?.handle ?? "").toLowerCase() === (people.get(post.cid)?.handle ?? "").toLowerCase();
}

// Post ids are decimal strings longer than a float can hold exactly.
const compareIds = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

function shown(post: Post, people: Map<string, Person>) {
  const { backfill, cid, ...rest } = post;
  const person = people.get(cid)!;
  return { ...rest, creator: { id: person.id, handle: person.handle, name: person.name, avatar: person.avatar } };
}

function people(snapshot: Snapshot) {
  return new Map(snapshot.creators.map((person) => [person.id, person]));
}

export default capsule({
  name: "exosphere",
  auth: { requireSignIn: false },

  schema: {
    chunks: table({ part: number(), body: string() }).index("by_part", ["part"])
  },

  endpoints: {
    state: endpoint({ method: "GET", path: "/api/state", readOnly: true }, async (ctx, req) => {
      const snapshot = await load(ctx.db);
      const byId = people(snapshot);
      const isNew = newTest(req.query), isOwn = ownTest(req.query, byId);
      const counts = new Map(snapshot.creators.map((person) => [person.id, { posts: 0, latest: null as number | null, new: 0 }]));
      for (const post of snapshot.posts) {
        const count = counts.get(post.cid);
        if (!count) continue;
        count.posts++;
        count.latest = Math.max(count.latest ?? 0, post.at);
        if (isNew(post) && isOwn(post)) count.new++;
      }
      return json({
        status: now() - snapshot.pushed_at > STALE ? "stale" : "ok",
        last_ok: snapshot.pushed_at,
        creators: snapshot.creators.map((person) => ({ ...person, ...counts.get(person.id) })),
        seen: 0
      });
    }),

    feed: endpoint({ method: "GET", path: "/api/feed", readOnly: true }, async (ctx, req) => {
      const snapshot = await load(ctx.db);
      const byId = people(snapshot);
      const isOwn = ownTest(req.query, byId);
      const mine = snapshot.posts.filter((post) => byId.has(post.cid) && isOwn(post));
      const creator = req.query.get("creator"), before = req.query.get("before");
      if (creator === null && before === null) {
        const isNew = newTest(req.query);
        const posts = mine.filter(isNew).slice(0, NEW_LIMIT);
        return json({ posts: posts.map((post) => shown(post, byId)), more: mine.length > 0 });
      }
      let older = (_post: Post) => true;
      if (before) {
        const [at, id] = before.split(":");
        if (!/^\d+$/.test(at ?? "") || !/^\d+$/.test(id ?? "")) return json({ error: "Bad cursor" }, { status: 400 });
        const time = Number(at);
        older = (post) => post.at < time || (post.at === time && compareIds(post.id, id) < 0);
      }
      const page = mine.filter((post) => (!creator || post.cid === creator) && older(post)).slice(0, PAGE + 1);
      return json({ posts: page.slice(0, PAGE).map((post) => shown(post, byId)), more: page.length > PAGE });
    }),

    // Following and read positions live on the real site only.
    seen: endpoint({ method: "POST", path: "/api/seen", readOnly: true }, () => json({ error: "Read only" }, { status: 403 })),
    creators: endpoint({ method: "POST", path: "/api/creators", readOnly: true }, () => json({ error: "Read only" }, { status: 403 })),

    mirror: endpoint({ method: "POST", path: "/api/mirror", readOnly: false }, async (ctx, req) => {
      const secret = ctx.env.MIRROR_SECRET;
      if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return text("unauthorized", { status: 401 });
      const body = await req.text();
      if (body.length > MAX_BODY) return text("too big", { status: 413 });
      if (!/^[\x20-\x7e]*$/.test(body)) return text("not ASCII", { status: 400 });
      let snapshot: Snapshot;
      try {
        snapshot = JSON.parse(body);
      } catch {
        return text("not JSON", { status: 400 });
      }
      if (typeof snapshot?.pushed_at !== "number" || !Array.isArray(snapshot.creators) || !Array.isArray(snapshot.posts)) {
        return text("not a snapshot", { status: 400 });
      }
      // Old rows go first, in the same transaction, so the two copies never count against the limit together.
      for (const row of await ctx.db.chunks.withIndex("by_part").collect()) await ctx.db.chunks.delete(row.id);
      for (let part = 0; part * CHUNK < body.length; part++) {
        await ctx.db.chunks.insert({ part, body: body.slice(part * CHUNK, (part + 1) * CHUNK) });
      }
      return json({ ok: true, bytes: body.length, creators: snapshot.creators.length, posts: snapshot.posts.length });
    })
  }
});
