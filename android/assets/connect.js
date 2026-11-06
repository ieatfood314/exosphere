/* The one screen the app adds: where's your server? It talks to the app by navigating to
   exosphere://connect, so no JS bridge is exposed to the live site. */
const params = new URLSearchParams(location.search);
const address = document.getElementById("address"), note = document.getElementById("note");

window.showNote = (text) => { note.textContent = text; };
showNote(params.get("note") || "");
address.value = params.get("address") || "";

function connect() {
  if (!address.value.trim()) return showNote("Enter the address");
  showNote("Connecting");
  location.href = `exosphere://connect?address=${encodeURIComponent(address.value)}`;
}
document.getElementById("go").addEventListener("click", connect);
address.addEventListener("keydown", (event) => { if (event.key === "Enter") connect(); });

/* The limb, a plainer cut of the one in the site's app.js. */
function paint() {
  const canvas = document.getElementById("planet"), scale = Math.min(devicePixelRatio || 1, 2);
  const width = (canvas.width = innerWidth * scale), height = (canvas.height = canvas.clientHeight * scale);
  const context = canvas.getContext("2d");
  const radius = Math.max(640, innerWidth * 0.78) * scale;
  const x = width / 2, y = 92 * scale - radius;
  const glow = context.createRadialGradient(x, y, radius, x, y, radius + 120 * scale);
  [[0, "#b4dcff"], [0.02, "#58a8ffe0"], [0.16, "#1f68e870"], [0.5, "#0a267030"], [1, "#06143c00"]]
    .forEach(([at, color]) => glow.addColorStop(at, color));
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#01030a";
  context.beginPath();
  context.arc(x, y, radius, 0, 7);
  context.fill();
}
paint();
addEventListener("resize", paint); // a WebView can run this before it has a size
