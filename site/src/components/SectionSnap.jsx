import { useEffect } from "react";

export const sectionIds = [
  "inicio",
  "sobre",
  "servicos",
  "metodo",
  "planos",
  "contato",
];
const names = ["Início", "A Metta", "Soluções", "Método", "Planos", "Contato"];
export function useSectionSnap() {
  useEffect(() => {
    document.documentElement.classList.add("snap-home");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let lastWheel = 0,
      lockedUntil = 0,
      distance = 0,
      direction = 0;
    const panelIds = [...sectionIds, "rodape"];
    function current() {
      const footer = document.getElementById("rodape");
      if (
        footer &&
        window.scrollY > 0 &&
        window.scrollY + innerHeight >=
          document.documentElement.scrollHeight - 4
      )
        return footer;
      return panelIds
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .reduce((a, b) =>
          Math.abs(a.getBoundingClientRect().top) <
          Math.abs(b.getBoundingClientRect().top)
            ? a
            : b,
        );
    }
    function step(panel, dir, instant = false) {
      const index = panelIds.indexOf(panel.id);
      const next = Math.max(0, Math.min(panelIds.length - 1, index + dir));
      if (index === next) return;
      lockedUntil = performance.now() + (reduced.matches ? 180 : 950);
      const destination = document.getElementById(panelIds[next]);
      destination.scrollTop =
        dir < 0 && getComputedStyle(destination).overflowY === "auto"
          ? destination.scrollHeight - destination.clientHeight
          : 0;
      destination.scrollIntoView({
        behavior: reduced.matches || instant ? "instant" : "smooth",
        block: "start",
      });
    }
    function wheel(e) {
      if (
        e.ctrlKey ||
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ||
        document.body.style.overflow === "hidden" ||
        document.documentElement.dataset.routeBusy === "true"
      )
        return;
      const panel = current();
      if (!panel || !panel.contains(e.target)) return;
      const dir = Math.sign(e.deltaY),
        now = performance.now(),
        gap = now - lastWheel;
      lastWheel = now;
      if (now < lockedUntil || (lockedUntil && gap < 140)) {
        e.preventDefault();
        return;
      }
      lockedUntil = 0;
      const canReadMore =
        getComputedStyle(panel).overflowY === "auto" &&
        (dir > 0
          ? panel.scrollTop + panel.clientHeight < panel.scrollHeight - 3
          : panel.scrollTop > 3);
      if (canReadMore) {
        distance = 0;
        return;
      }
      e.preventDefault();
      if (dir !== direction || gap > 250) distance = 0;
      direction = dir;
      distance +=
        Math.abs(e.deltaY) *
        (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
      if (distance >= 28) {
        step(panel, dir);
        distance = 0;
      }
    }
    function key(e) {
      if (
        document.body.style.overflow === "hidden" ||
        document.documentElement.dataset.routeBusy === "true" ||
        e.target.closest("input,textarea,select,button,a,[contenteditable]") ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey
      )
        return;
      const dir = ["ArrowDown", "PageDown", " "].includes(e.key)
        ? e.shiftKey
          ? -1
          : 1
        : ["ArrowUp", "PageUp"].includes(e.key)
          ? -1
          : 0;
      if (!dir) return;
      e.preventDefault();
      const panel = current();
      if (performance.now() < lockedUntil) return;
      const canReadMore =
        getComputedStyle(panel).overflowY === "auto" &&
        (dir > 0
          ? panel.scrollTop + panel.clientHeight < panel.scrollHeight - 3
          : panel.scrollTop > 3);
      if (canReadMore)
        panel.scrollBy({
          top: dir * panel.clientHeight * 0.8,
          behavior: reduced.matches ? "instant" : "smooth",
        });
      else step(panel, dir);
    }
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    return () => {
      document.documentElement.classList.remove("snap-home");
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
    };
  }, []);
}
export function SectionNavigator({ active, busy }) {
  const index = Math.max(0, sectionIds.indexOf(active));
  return (
    <nav
      className={`section-navigator ${["inicio", "metodo", "contato"].includes(active) ? "on-dark" : ""}`}
      aria-label="Seções da página inicial"
      inert={busy || undefined}
    >
      {sectionIds.map((id, i) => (
        <button
          key={id}
          aria-label={`Ir para ${names[i]}`}
          aria-current={active === id ? "step" : undefined}
          onClick={() =>
            document.getElementById(id)?.scrollIntoView({
              behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "instant"
                : "smooth",
            })
          }
        >
          <span className="section-tip">{names[i]}</span>
          <i />
        </button>
      ))}
      <span className="section-count">0{index + 1} / 06</span>
    </nav>
  );
}
