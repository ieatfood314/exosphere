const $ = (id) => document.getElementById(id);
const hero = $("hero"), feed = $("feed"), edge = $("edge"), orbit = $("orbit");
const BASE_KM = 700, TOP_KM = 10000; // where the exosphere starts and thins into space
const STATUS = { none: "No X account", blocked: "X blocked us", waiting: "Waiting on X", offline: "Offline" };

let state = { creators: [], status: "ok" };
let view = { name: "new" };
let shown = [];           // posts on the page, oldest last
let more = false;
let peopleSort = localStorage.getItem("sort") || "recent";
let seenSent = 0;
let edgeWatch = null;

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "on") for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  node.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  return node;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Failed");
  return body;
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* time */
const ago = (at) => {
  const seconds = Date.now() / 1000 - at;
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return new Date(at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const dayKey = (at) => new Date(at * 1000).toDateString();
function dayName(at) {
  const today = new Date(), yesterday = new Date(Date.now() - 864e5);
  if (dayKey(at) === today.toDateString()) return "Today";
  if (dayKey(at) === yesterday.toDateString()) return "Yesterday";
  return new Date(at * 1000).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/* posts. Everything from X goes in as text nodes, never as markup. */
const TOKEN = /(https?:\/\/[^\s]+)|(?<![\w@])@(\w{1,15})|(?<![\w#])#(\w+)/g;
function richText(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    out.push(text.slice(last, match.index));
    const [whole, url, handle, tag] = match;
    const href = url || (handle ? `https://x.com/${handle}` : `https://x.com/hashtag/${encodeURIComponent(tag)}`);
    const label = url ? url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : whole;
    out.push(el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label.length > 42 ? label.slice(0, 41) + "…" : label));
    last = match.index + whole.length;
  }
  out.push(text.slice(last));
  return out;
}

function mediaBlock(items) {
  if (!items?.length) return null;
  const nodes = items.map((item) =>
    item.type === "photo"
      ? el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, el("img", { src: item.url, loading: "lazy", alt: "", referrerpolicy: "no-referrer" }))
      : el("video", { src: item.url, poster: item.poster, controls: "", playsinline: "", preload: "none", loop: item.type === "gif" ? "" : null }));
  return el("div", { class: `media${items.length > 1 ? " two" : ""}` }, nodes);
}

function nested(kind, item) {
  return el("div", { class: kind },
    el("div", { class: "head" }, el("span", { class: "who" }, item.author.name),
      el("a", { class: "when", href: item.url, target: "_blank", rel: "noopener noreferrer" }, ago(item.at))),
    item.text && el("p", { class: "text" }, richText(item.text)),
    mediaBlock(item.media));
}

function postNode(item) {
  const body = item.repost || item;
  return el("article", { class: "post" },
    el("div", { class: "head" },
      el("a", { class: "who", href: `#/p/${item.creator.id}` }, item.creator.name),
      el("a", { class: "when", href: item.url, target: "_blank", rel: "noopener noreferrer", title: new Date(item.at * 1000).toLocaleString() }, ago(item.at))),
    item.repost && el("div", { class: "label" }, `Reposted ${item.repost.author.name}`),
    item.reply_to && !item.reply_to.post && el("div", { class: "label" }, `Reply to @${item.reply_to.handle}`),
    item.reply_to?.post && nested("parent", item.reply_to.post),
    body.text && el("p", { class: "text" }, richText(body.text)),
    mediaBlock(body.media),
    item.quote && nested("quote", item.quote));
}

function addPosts(posts) {
  let previous = shown.at(-1);
  for (const item of posts) {
    if (!previous || dayKey(previous.at) !== dayKey(item.at)) feed.append(el("div", { class: "day mono" }, dayName(item.at)));
    feed.append(postNode(item));
    shown.push(item);
    previous = item;
  }
}

/* satellites */
function avatar(person) {
  const node = el("span", { class: "sat" });
  const initial = () => node.replaceChildren((person.name || "?").trim()[0].toUpperCase());
  if (person.avatar) {
    node.append(el("img", { src: person.avatar, alt: "", loading: "lazy", referrerpolicy: "no-referrer", on: { error: initial } }));
  } else initial();
  return node;
}

function drawOrbit() {
  const people = [...state.creators].sort((a, b) => b.new - a.new || (b.latest || 0) - (a.latest || 0));
  orbit.replaceChildren(
    ...people.map((person) => {
      const node = avatar(person);
      const link = el("a", { href: `#/p/${person.id}`, class: `sat${person.new ? " new" : ""}`, title: person.name, "aria-label": person.name, "aria-current": view.id === person.id ? "true" : null });
      link.append(...node.childNodes);
      return link;
    }),
    el("a", { class: "sat add", href: "#/add", title: "Add someone", "aria-label": "Add someone" }, "+"));
  bendOrbit();
}

const planetRadius = () => Math.max(640, innerWidth * 0.78);

/* each satellite rides the curve of the limb, whatever the scroll position */
function bendOrbit() {
  const radius = planetRadius(), middle = innerWidth / 2;
  for (const sat of orbit.children) {
    const dx = sat.offsetLeft - orbit.scrollLeft + 22 - middle;
    const lift = radius - Math.sqrt(Math.max(radius * radius - dx * dx, 0));
    sat.style.transform = `translateY(${-Math.min(lift, 150).toFixed(1)}px)`;
  }
}

/* views */
function reset() {
  feed.replaceChildren();
  edge.replaceChildren();
  shown = [];
  more = false;
  edgeWatch?.disconnect();
  edgeWatch = null;
  document.querySelector(".toplink").toggleAttribute("aria-current", view.name === "people");
}

function showEdge(text, ...extra) {
  edge.replaceChildren(...[el("div", { class: "line" }), text && el("p", {}, text), ...extra].filter(Boolean));
}

function earlierButton() {
  return more ? el("button", { class: "plain", on: { click: loadEarlier } }, "Earlier") : null;
}

async function loadEarlier(event) {
  const button = event.currentTarget;
  button.disabled = true;
  const last = shown.at(-1);
  const params = new URLSearchParams();
  if (view.id) params.set("creator", view.id);
  params.set("before", last ? `${last.at}:${last.id}` : `${2 ** 40}:9`);
  try {
    const page = await api(`/api/feed?${params}`);
    addPosts(page.posts);
    more = page.more;
    finish();
  } catch {
    button.disabled = false;
  }
}

function finish() {
  const unfollow = view.name === "person" ? unfollowButton() : null;
  showEdge(more ? null : "That's everything.", earlierButton(), unfollow);
}

function unfollowButton() {
  const button = el("button", { class: "plain", on: { click: async () => {
    if (button.dataset.armed) {
      await api(`/api/creators/${view.id}`, { method: "DELETE" });
      location.hash = "#/";
    } else {
      button.dataset.armed = "1";
      button.classList.add("warn");
      button.textContent = "Tap again to unfollow";
    }
  } } }, "Unfollow");
  return el("div", {}, button);
}

function watchEdgeForSeen() {
  const newest = Math.max(0, ...shown.map((item) => item.fetched_at));
  if (!newest) return;
  edgeWatch = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && newest > seenSent) {
      seenSent = newest;
      post("/api/seen", { until: newest }).catch(() => { seenSent = 0; });
    }
  });
  edgeWatch.observe(edge);
}

async function showNew() {
  const page = await api("/api/feed");
  reset();
  more = page.more;
  const count = page.posts.length;
  if (!state.creators.length) {
    hero.replaceChildren(el("a", { class: "count none", href: "#/add" }, "Add someone"));
  } else if (count) {
    hero.replaceChildren(el("span", { class: "count" }, String(count)), el("span", { class: "sub" }, count === 1 ? "new post" : "new posts"));
  } else {
    hero.replaceChildren(el("span", { class: "count none" }, "Clear sky"), el("span", { class: "sub" }, "Nothing new"));
  }
  addPosts(page.posts);
  showEdge(count ? "That's everything." : null, earlierButton());
  watchEdgeForSeen();
}

let fetchTimer;
async function showPerson(id) {
  clearTimeout(fetchTimer);
  const person = state.creators.find((creator) => creator.id === id);
  if (!person) { location.hash = "#/"; return; }
  const page = await api(`/api/feed?creator=${id}`);
  reset();
  more = page.more;
  const waiting = !person.polled_at;
  const line = person.error ? "Fetch failed" : waiting ? "Fetching" : person.protected ? `@${person.handle} · private` : `@${person.handle}`;
  hero.replaceChildren(el("h1", { class: "title" }, person.name), el("span", { class: "sub" }, line));
  addPosts(page.posts);
  finish();
  if (waiting) {
    fetchTimer = setTimeout(async () => {
      await refreshState();
      if (view.id === id) showPerson(id);
    }, 8000);
  }
}

function showPeople() {
  reset();
  hero.replaceChildren(el("h1", { class: "title" }, "People"));
  const sorts = { recent: "Recent", name: "A–Z", posts: "Most posts" };
  const order = {
    recent: (a, b) => (b.latest || 0) - (a.latest || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    posts: (a, b) => b.posts - a.posts,
  };
  const draw = () => {
    const rows = [...state.creators].sort(order[peopleSort]).map((person) =>
      el("a", { class: "person", href: `#/p/${person.id}` }, avatar(person),
        el("span", {}, el("b", {}, person.name), el("small", {}, `@${person.handle}${person.latest ? ` · ${ago(person.latest)}` : ""}`)),
        person.new ? el("span", { class: "fresh" }, String(person.new)) : null));
    const tabs = Object.entries(sorts).map(([key, label]) =>
      el("button", { "aria-pressed": String(key === peopleSort), on: { click: () => { peopleSort = key; localStorage.setItem("sort", key); draw(); } } }, label));
    feed.replaceChildren(el("div", { class: "sorts" }, tabs), ...rows);
  };
  draw();
}

function showAdd() {
  reset();
  const note = el("span", { class: "note", role: "alert" });
  const results = el("div", {});
  const input = el("input", { class: "ask", placeholder: "Name or @handle", autocomplete: "off", autocapitalize: "none", spellcheck: "false", enterkeyhint: "go", "aria-label": "Name or @handle" });
  const add = async (query, exact) => {
    note.textContent = "Looking";
    results.replaceChildren();
    try {
      const answer = await post("/api/creators", { query, exact });
      if (answer.matches) {
        note.textContent = "";
        results.replaceChildren(...answer.matches.map((match) =>
          el("button", { class: "match", on: { click: () => add(match.handle, true) } }, avatar(match),
            el("span", {}, match.name, el("small", {}, `@${match.handle}`)))));
        return;
      }
      await refreshState();
      location.hash = `#/p/${answer.added.id}`;
    } catch (failure) {
      note.textContent = failure.message;
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && input.value.trim()) add(input.value, false);
  });
  hero.replaceChildren(input, note, results);
  input.focus();
}

async function refreshState() {
  try {
    state = await api("/api/state");
  } catch {
    state = { ...state, status: "offline" };
  }
  $("status").textContent = STATUS[state.status] || "";
  drawOrbit();
}

async function route() {
  const path = location.hash.replace(/^#\/?/, "");
  const [section, id] = path.split("/");
  view = section === "p" ? { name: "person", id } : { name: section || "new" };
  if (!["new", "person", "people", "add"].includes(view.name)) view = { name: "new" };
  drawOrbit();
  scrollTo(0, 0);
  $("altitude").hidden = view.name === "people" || view.name === "add";
  try {
    if (view.name === "person") await showPerson(id);
    else if (view.name === "people") showPeople();
    else if (view.name === "add") showAdd();
    else await showNew();
  } catch {
    $("status").textContent = STATUS.offline;
  }
  onScroll();
}

/* altitude: how far through a feed that has an end */
const stars = $("stars"), rail = $("altitude-dot"), km = $("altitude-km");
function onScroll() {
  const room = document.documentElement.scrollHeight - innerHeight;
  const progress = room > 0 ? Math.min(scrollY / room, 1) : 1;
  const altitude = BASE_KM + (TOP_KM - BASE_KM) * progress;
  km.textContent = `${Math.round(altitude / 10) * 10 >= 1000 ? (Math.round(altitude / 10) * 10).toLocaleString("en-US") : Math.round(altitude / 10) * 10} km`;
  rail.style.top = `${progress * (innerHeight - 14)}px`;
  stars.style.opacity = (progress * progress).toFixed(3);
}

/* The limb, painted once. Blue where the sun reaches it, airglow on the night side, and
   the sun itself about to clear the edge where the two meet. */
const DAY = [[0, "#eef8ffff"], [2, "#b4dcffff"], [7, "#58a8ffe8"], [20, "#1f68e8c0"], [52, "#0f3fb080"], [120, "#0a267040"], [240, "#06143c14"], [340, "#06143c00"]];
const NIGHT = [[0, "#0d2a2a80"], [6, "#00000000"], [11, "#7dffb400"], [13.5, "#a6ffcdb8"], [17, "#7dffb450"], [34, "#2fd08a18"], [110, "#0a4a3500"]];

function drawPlanet() {
  const canvas = $("planet"), scale = Math.min(devicePixelRatio || 1, 2);
  const width = innerWidth * scale, height = canvas.clientHeight * scale;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const radius = planetRadius() * scale;
  const limbY = (orbit.offsetTop + 130) * scale;
  const x = width / 2, y = limbY - radius;

  const glow = (stops, from, to) => {
    const layer = new OffscreenCanvas(width, height), paint = layer.getContext("2d");
    const span = stops.at(-1)[0] * scale;
    const gradient = paint.createRadialGradient(x, y, radius, x, y, radius + span);
    for (const [distance, color] of stops) gradient.addColorStop((distance * scale) / span, color);
    paint.fillStyle = gradient;
    paint.fillRect(0, 0, width, height);
    const mask = paint.createLinearGradient(from * width, 0, to * width, 0);
    mask.addColorStop(0, "#000");
    mask.addColorStop(1, "#0000");
    paint.globalCompositeOperation = "destination-in";
    paint.fillStyle = mask;
    paint.fillRect(0, 0, width, height);
    context.drawImage(layer, 0, 0);
  };
  glow(NIGHT, 0.86, 0.42);
  glow(DAY, 0.2, 0.66);

  context.fillStyle = "#01030a";
  context.beginPath();
  context.arc(x, y, radius, 0, 7);
  context.fill();

  const sunX = width * 0.54, sunY = y + Math.sqrt(radius ** 2 - (sunX - x) ** 2);
  context.save();
  context.translate(sunX, sunY);
  context.scale(1, 0.05);
  const sun = context.createRadialGradient(0, 0, 0, 0, 0, 130 * scale);
  sun.addColorStop(0, "#fffffff0");
  sun.addColorStop(0.28, "#ffd9abd0");
  sun.addColorStop(1, "#ffc48a00");
  context.fillStyle = sun;
  context.beginPath();
  context.arc(0, 0, 130 * scale, 0, 7);
  context.fill();
  context.restore();

  // Dark gradients band on 8-bit screens. A little noise hides it.
  const image = context.getImageData(0, 0, width, height), pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const noise = (Math.random() - 0.5) * 3;
    pixels[i] += noise; pixels[i + 1] += noise; pixels[i + 2] += noise;
  }
  context.putImageData(image, 0, 0);
}

function drawStars() {
  const scale = Math.min(devicePixelRatio || 1, 2);
  stars.width = innerWidth * scale;
  stars.height = innerHeight * scale;
  const context = stars.getContext("2d");
  let seed = 557;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const total = Math.round((innerWidth * innerHeight) / 5200);
  for (let i = 0; i < total; i++) {
    const size = random() < 0.92 ? 0.7 : 1.3;
    context.globalAlpha = 0.25 + random() * 0.7;
    context.fillStyle = random() < 0.12 ? "#ffd9b8" : random() < 0.2 ? "#b8d8ff" : "#fff";
    context.beginPath();
    context.arc(random() * stars.width, random() * stars.height, size * scale, 0, 7);
    context.fill();
  }
}

let ticking = false;
addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { onScroll(); ticking = false; });
}, { passive: true });
orbit.addEventListener("scroll", () => requestAnimationFrame(bendOrbit), { passive: true });
let lastWidth = innerWidth;
addEventListener("resize", () => {
  if (innerWidth !== lastWidth) { // phones resize on every toolbar show and hide
    lastWidth = innerWidth;
    drawPlanet();
    bendOrbit();
  }
  drawStars();
  onScroll();
});
addEventListener("hashchange", route);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && view.name === "new" && scrollY < 120) {
    await refreshState();
    route();
  }
});

drawStars();
drawPlanet();
await refreshState();
route();
