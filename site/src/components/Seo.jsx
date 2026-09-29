import { useLayoutEffect } from "react";
import {
  absolute,
  robotsFor,
  seoFor,
  structuredData,
} from "../data/seo.js";

// Mirrors the static tags from headTags() (src/data/seo.js) on client-side
// navigation, so titles, canonicals and previews follow the visible route.
function setMeta(attribute, key, content) {
  let tag = document.head.querySelector(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function setOrRemove(selector, create, apply) {
  let tag = document.head.querySelector(selector);
  if (!apply) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = create();
    document.head.appendChild(tag);
  }
  apply(tag);
}

export function useSeo(pathname) {
  useLayoutEffect(() => {
    const page = seoFor(pathname);
    const url = absolute(pathname);
    const data = structuredData(pathname);
    document.title = page.title;
    setMeta("name", "description", page.description);
    setMeta("name", "robots", robotsFor(page));
    setMeta("property", "og:title", page.title);
    setMeta("property", "og:description", page.description);
    setMeta("name", "twitter:title", page.title);
    setMeta("name", "twitter:description", page.description);
    setOrRemove(
      'link[rel="canonical"]',
      () => Object.assign(document.createElement("link"), { rel: "canonical" }),
      !page.noindex && ((tag) => (tag.href = url)),
    );
    setOrRemove(
      'meta[property="og:url"]',
      () => {
        const tag = document.createElement("meta");
        tag.setAttribute("property", "og:url");
        return tag;
      },
      !page.noindex && ((tag) => tag.setAttribute("content", url)),
    );
    setOrRemove(
      "#structured-data",
      () =>
        Object.assign(document.createElement("script"), {
          type: "application/ld+json",
          id: "structured-data",
        }),
      data && ((tag) => (tag.textContent = JSON.stringify(data))),
    );
  }, [pathname]);
}
