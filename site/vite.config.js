import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  SITE_URL,
  absolute,
  headTags,
  notFound,
  routes,
} from "./src/data/seo.js";

// Writes one HTML file per top-level route (sobre.html, planos.html…) with its
// own <head>, plus 404.html, sitemap.xml and robots.txt, so crawlers and link
// previews never depend on JavaScript. public/.htaccess maps /sobre to
// sobre.html on Apache; Netlify, Vercel, Cloudflare Pages and GitHub Pages do
// it on their own.
function seoPages() {
  let outDir;
  const block = /<!-- seo -->[\s\S]*?<!-- \/seo -->/;
  return {
    name: "metta-seo-pages",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {})
          .filter((file) =>
            /(raleway-latin-[23]00-normal|manrope-latin-[45]00-normal|cormorant-garamond-latin-400-italic).*\.woff2$/.test(
              file,
            ),
          )
          .map(
            (file) =>
              `<link rel="preload" as="font" type="font/woff2" href="/${file}" crossorigin />`,
          );
        return html.replace(
          "<!--seo-->",
          [headTags("/"), ...fonts].join("\n    "),
        );
      },
    },
    closeBundle(error) {
      // A failed build never wrote index.html: let Rollup report the real error.
      const indexFile = resolve(outDir, "index.html");
      if (error || !existsSync(indexFile)) return;
      const html = readFileSync(indexFile, "utf8");
      if (!block.test(html)) throw new Error("SEO block missing in index.html");
      const write = (file, content) => {
        const path = resolve(outDir, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      };
      // Only top-level routes get a file (admin.html, painel.html,
      // convite.html…). The Node server answers product sub-routes and token
      // links (/convite/:token) with these shells; static hosts use 404.html.
      const pages = Object.keys(routes).filter(
        (path) => path !== "/" && path.split("/").length === 2,
      );
      for (const path of pages)
        write(
          `${path.slice(1)}.html`,
          html.replace(block, headTags(path, routes[path])),
        );
      write("404.html", html.replace(block, headTags("/404", notFound)));

      const today = new Date().toISOString().slice(0, 10);
      const urls = Object.entries(routes)
        .filter(([, page]) => !page.noindex)
        .map(
          ([path]) =>
            `  <url>\n    <loc>${absolute(path)}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`,
        );
      write(
        "sitemap.xml",
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
      );
      write(
        "robots.txt",
        `User-agent: *\nAllow: /\nDisallow: /painel\nDisallow: /admin\nDisallow: /convite/\nDisallow: /redefinir-senha/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
      );
    },
  };
}

// In development the API runs on its own port (npm run dev:api); the browser
// only talks to Vite, so cookies and the Origin check stay same-origin.
// METTA_API_URL points the proxy at another API (e.g. one on a spare port).
const api = {
  target: process.env.METTA_API_URL || "http://127.0.0.1:8787",
  xfwd: true,
};
const proxy = { "/api/": api, "/dl/": api };

export default defineConfig({
  plugins: [react(), seoPages()],
  server: { proxy },
  preview: { proxy },
});
