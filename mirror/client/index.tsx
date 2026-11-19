// The public mirror's page: the real site's markup, style and script, run as they are.
// app.ts and site.ts are generated from exosphere/static by mirror/publish.py.
import { useLayoutEffect } from "preact/hooks";
import { start } from "./app";
import { BODY, CSS } from "./site";

function meta(name: string, content: string) {
  const tag = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`) ?? document.head.appendChild(document.createElement("meta"));
  tag.name = name;
  tag.content = content;
}

export function App() {
  useLayoutEffect(() => {
    // Lakebed adds Tailwind to every page. Its reset fights the site's own CSS.
    for (const tag of document.querySelectorAll("style")) {
      if (tag.textContent?.includes("tailwindcss")) tag.remove();
    }
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    document.title = "exosphere";
    meta("viewport", "width=device-width, initial-scale=1, viewport-fit=cover");
    meta("theme-color", "#000000");
    meta("referrer", "no-referrer");
    meta("description", "A quiet feed of a few X accounts. A read-only copy.");
    document.documentElement.setAttribute("data-mirror", "");
    // The site's markup sits straight in <body>, where its CSS expects it, beside Lakebed's empty root.
    const app = document.getElementById("app");
    if (app) app.style.display = "none";
    const page = document.createElement("template");
    page.innerHTML = BODY; // the site's own fixed markup; posts still go in as text nodes
    document.body.append(page.content);
    start();
  }, []);

  return null;
}
