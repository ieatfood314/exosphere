const $ = (id) => document.getElementById(id);
const hero = $("hero"), feed = $("feed"), edge = $("edge"), orbit = $("orbit");
const tabs = [...orbit.children];
const menu = $("menu"), HOLD_MS = 450;
const BASE_KM = 700, TOP_KM = 10000; // where the exosphere starts and thins into space
const AWAY_MS = 5 * 60 * 1000;     // a shorter absence is a glance elsewhere, so the page stays put
const READING_MS = 30 * 60 * 1000; // scrolled down, you may be off reading a link, so wait longer
const NEWEST = `${2 ** 40}:9`; // a cursor above every post
const STATUS = { none: "No X account", blocked: "X blocked us", waiting: "Waiting on X", offline: "Offline" };

let state = { creators: [], status: "ok" };
let view = { name: "new" };
let shown = [];           // posts on the page, oldest last
let more = false;
let peopleSort = localStorage.getItem("sort") || "recent";
let onlyPosts = localStorage.getItem("only") === "posts";
let checked = 0;          // newest fetched_at the feed has shown; sent when you leave
let seenSent = 0;
let saved = 0;            // when the last answer was saved, if it came from the app's offline copy
let holdTimer, holdFrom, held = false;
let hiddenAt = Date.now();

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
  if (!options) saved = Number(response.headers.get("x-exosphere-saved")) || 0;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Failed");
  return body;
}
const filtered = (path) => (onlyPosts ? `${path}${path.includes("?") ? "&" : "?"}only=posts` : path);
const post = (path, body, options) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...options });

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
      el("button", { class: "who", "data-person": item.creator.id }, item.creator.name),
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
  for (const tab of tabs) tab.toggleAttribute("aria-current", tab.dataset.view === view.name);
  for (const sat of orbit.querySelectorAll(".sat")) sat.remove(); // the tabs stay, so they keep focus
  orbit.append(
    ...people.map((person) => {
      const node = avatar(person);
      const link = el("button", { class: `sat${person.new ? " new" : ""}`, "data-person": person.id, title: person.name, "aria-label": person.name, "aria-current": view.id === person.id ? "true" : null });
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
    const dx = sat.offsetLeft - orbit.scrollLeft + sat.offsetWidth / 2 - middle;
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
}

function filterTabs() {
  const tabs = [[false, "Everything"], [true, "Posts"]].map(([value, label]) =>
    el("button", { "aria-pressed": String(value === onlyPosts), on: { click: async () => {
      onlyPosts = value;
      localStorage.setItem("only", value ? "posts" : "all");
      await refreshState();
      route();
    } } }, label));
  return el("div", { class: "sorts filter" }, tabs);
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
  params.set("before", last ? `${last.at}:${last.id}` : NEWEST);
  try {
    const page = await api(filtered(`/api/feed?${params}`)).catch((failure) => {
      if (view.name === "new" && last) return savedEarlier(last);
      throw failure;
    });
    addPosts(page.posts);
    more = page.more;
    finish();
  } catch {
    button.disabled = false;
  }
}

/* Offline, only the app's saved pages exist, and New can end anywhere inside one of them.
   So walk them from the top to the first post older than the one on screen. */
async function savedEarlier(last) {
  const older = (item) => item.at < last.at || (item.at === last.at && BigInt(item.id) < BigInt(last.id));
  for (let cursor = NEWEST; ;) {
    const page = await api(filtered(`/api/feed?before=${cursor}`));
    const posts = page.posts.filter(older);
    if (posts.length || !page.more) return { ...page, posts };
    const end = page.posts.at(-1);
    cursor = `${end.at}:${end.id}`;
  }
}

function finish() {
  showEdge(more ? null : "That's everything.", earlierButton());
}

async function unfollow(id) {
  await api(`/api/creators/${id}`, { method: "DELETE" });
  state.creators = state.creators.filter((creator) => creator.id !== id);
  await refreshState();
  if (view.id === id) location.hash = "#/";
  else await route();
}

function unfollowButton(id) {
  const button = el("button", { class: "plain", on: { click: async () => {
    if (!button.dataset.armed) {
      clearTimeout(fetchTimer); // redrawing the page would disarm the button
      button.dataset.armed = "1";
      button.classList.add("warn");
      button.textContent = "Tap again to unfollow";
      return;
    }
    button.disabled = true;
    try {
      await unfollow(id);
    } catch {
      button.disabled = false;
      button.textContent = "Failed. Tap to retry";
    }
  } } }, "Unfollow");
  return button;
}

/* Press and hold a name, or right-click it. Names are buttons and their avatars ignore the
   pointer because Firefox for Android opens its own menu on any link or image it's held on. */
function openMenu(id, x, y) {
  const person = state.creators.find((creator) => creator.id === id);
  if (!person || menu.open) return;
  const button = el("button", { class: "plain", on: { click: async () => {
    button.disabled = true;
    try {
      await unfollow(id);
      menu.close();
    } catch {
      button.disabled = false;
      button.textContent = "Failed. Tap to retry";
    }
  } } }, `Unfollow ${person.name}`);
  menu.replaceChildren(button);
  menu.showModal();
  menu.style.left = `${Math.max(16, Math.min(x, innerWidth - menu.offsetWidth - 16))}px`;
  menu.style.top = `${Math.max(16, Math.min(y, innerHeight - menu.offsetHeight - 16))}px`;
}

/* Leaving is what counts as having checked, so the feed holds still while you read it.
   It's written down first: the page may be closing, or offline, and the server only ever
   moves forward, so sending it again later is harmless. */
const unsentCheck = () => Number(localStorage.getItem("seen")) || 0;

async function sendSeen(options) {
  const until = unsentCheck();
  if (!until) return;
  try {
    await post("/api/seen", { until }, options);
    if (unsentCheck() === until) localStorage.removeItem("seen");
  } catch {
    // It stays written down until a later try gets through.
  }
}

function sendChecked() {
  if (checked <= seenSent) return;
  seenSent = checked;
  localStorage.setItem("seen", Math.max(checked, unsentCheck()));
  sendSeen({ keepalive: true });
}

/* Quick, because an unreachable server would otherwise hold up everything behind this. */
const catchUp = () => sendSeen({ signal: AbortSignal.timeout(2000) });

async function showNew() {
  const page = await api(filtered("/api/feed"));
  if (saved) page.posts = page.posts.filter((item) => item.fetched_at > unsentCheck()); // the copy can't know you read these
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
  if (state.creators.length) feed.append(filterTabs());
  addPosts(page.posts);
  showEdge(count ? "That's everything." : null, earlierButton());
  checked = Math.max(checked, ...shown.map((item) => item.fetched_at));
}

/* Everyone, seen or not. Reading here is not checking: only New moves the read position. */
async function showAll() {
  const page = await api(filtered(`/api/feed?before=${NEWEST}`));
  reset();
  more = page.more;
  hero.replaceChildren(el("h1", { class: "title" }, "All"));
  feed.append(filterTabs());
  addPosts(page.posts);
  finish();
}

let fetchTimer;
async function showPerson(id) {
  clearTimeout(fetchTimer);
  const person = state.creators.find((creator) => creator.id === id);
  if (!person) { location.hash = "#/"; return; }
  const page = await api(filtered(`/api/feed?creator=${id}`));
  reset();
  more = page.more;
  const waiting = !person.polled_at;
  const line = person.error ? "Fetch failed" : waiting ? "Fetching" : person.protected ? `@${person.handle} · private` : `@${person.handle}`;
  hero.replaceChildren(el("h1", { class: "title", "data-person": id }, person.name), el("span", { class: "sub" }, line), unfollowButton(id));
  feed.append(filterTabs());
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
      el("button", { class: "person", "data-person": person.id }, avatar(person),
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
  const add = async (query) => {
    note.textContent = "Looking";
    results.replaceChildren();
    try {
      const answer = await post("/api/creators", { query }).catch((failure) => {
        throw failure instanceof TypeError ? new Error(STATUS.offline) : failure; // fetch itself failed
      });
      if (answer.matches) {
        note.textContent = "";
        results.replaceChildren(...answer.matches.map((match) =>
          el("button", { class: "match", on: { click: () => add(`@${match.handle}`) } }, avatar(match),
            el("span", {}, match.name, el("small", {}, `@${match.handle}`), match.bio && el("small", { class: "bio" }, match.bio)))));
        return;
      }
      await refreshState();
      location.hash = `#/p/${answer.added.id}`;
    } catch (failure) {
      note.textContent = failure.message;
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && input.value.trim()) add(input.value);
  });
  hero.replaceChildren(input, note, results);
  input.focus();
}

function showStatus() {
  $("status").textContent = saved ? `${STATUS.offline} · saved ${ago(saved)}` : STATUS[state.status] || "";
}

async function refreshState() {
  try {
    state = await api(filtered("/api/state"));
    if (saved && unsentCheck()) for (const creator of state.creators) creator.new = 0;
  } catch {
    saved = 0;
    state = { ...state, status: "offline" };
  }
  showStatus();
  drawOrbit();
}

async function route() {
  const path = location.hash.replace(/^#\/?/, "");
  const [section, id] = path.split("/");
  view = section === "p" ? { name: "person", id } : { name: section || "new" };
  if (!["new", "all", "person", "people", "add"].includes(view.name)) view = { name: "new" };
  drawOrbit();
  scrollTo(0, 0);
  $("altitude").hidden = view.name === "people" || view.name === "add";
  try {
    if (view.name === "person") await showPerson(id);
    else if (view.name === "all") await showAll();
    else if (view.name === "people") showPeople();
    else if (view.name === "add") showAdd();
    else await showNew();
    showStatus();
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
document.addEventListener("touchstart", (event) => {
  clearTimeout(holdTimer);
  const [{ clientX: x, clientY: y }] = event.touches;
  holdFrom = { x, y };
  const who = event.target.closest("[data-person]");
  if (!who || event.touches.length > 1) return;
  holdTimer = setTimeout(() => {
    held = true;
    openMenu(who.dataset.person, x, y);
  }, HOLD_MS);
}, { passive: true });
document.addEventListener("touchmove", (event) => {
  const [{ clientX: x, clientY: y }] = event.touches;
  if (Math.hypot(x - holdFrom.x, y - holdFrom.y) > 10) clearTimeout(holdTimer);
}, { passive: true });
document.addEventListener("touchend", (event) => {
  clearTimeout(holdTimer);
  if (held) event.preventDefault(); // lifting the finger must not also tap what's under it
  held = false;
});
document.addEventListener("touchcancel", () => {
  clearTimeout(holdTimer);
  held = false;
});
document.addEventListener("contextmenu", (event) => {
  const who = event.target.closest("[data-person]");
  if (menu.open || held) event.preventDefault();
  else if (who) {
    event.preventDefault();
    openMenu(who.dataset.person, event.clientX, event.clientY);
  }
});
document.addEventListener("click", (event) => {
  const who = event.target.closest("[data-person]");
  if (who) location.hash = `#/p/${who.dataset.person}`;
});
menu.addEventListener("click", (event) => {
  if (event.target === menu) menu.close();
});
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    sendChecked();
  } else {
    const stale = Date.now() - hiddenAt > (scrollY < 120 ? AWAY_MS : READING_MS);
    await catchUp();
    await refreshState();
    if (view.name === "new" && stale) route();
  }
});

addEventListener("online", async () => {
  await catchUp();
  await refreshState();
});

drawStars();
drawPlanet();
await catchUp();
await refreshState();
route();
