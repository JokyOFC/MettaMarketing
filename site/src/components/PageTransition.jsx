import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import Logo from "../Logo.jsx";
import { useSeo } from "./Seo.jsx";

const TransitionContext = createContext(false);
export const usePageTransition = () => useContext(TransitionContext);
const isPublic = (path) =>
  !/^\/(login|cadastro|registro|painel|admin|convite|recuperar-senha|redefinir-senha)(\/|$)/.test(
    path,
  );

// Keep the outgoing route mounted until the curtain completely covers it.
// This also handles history navigation without intercepting links or browser shortcuts.
export default function PageTransition({ children }) {
  const location = useLocation();
  const [displayed, setDisplayed] = useState(location);
  const [phase, setPhase] = useState(() =>
    isPublic(location.pathname) &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "initial"
      : "idle",
  );
  const [loadProgress, setLoadProgress] = useState(0);
  const first = useRef(true);
  const shown = useRef(location);
  const content = useRef(null);
  useLayoutEffect(() => {
    let cancelled = false;
    const timers = [];
    const later = (fn, ms) => {
      const id = setTimeout(() => {
        if (!cancelled) fn();
      }, ms);
      timers.push(id);
    };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const initial = first.current;
    const changed = shown.current.pathname !== location.pathname;
    const commit = () => {
      shown.current = location;
      setDisplayed(location);
    };
    const reveal = () => {
      first.current = false;
      setPhase("reveal");
      later(() => {
        setPhase("idle");
      }, 760);
    };
    if (!isPublic(location.pathname) || reduced || (!initial && !changed)) {
      first.current = false;
      commit();
      setPhase("idle");
    } else if (initial) {
      setPhase("initial");
      const image = new Image();
      image.src =
        location.pathname === "/"
          ? "/images/hero.webp"
          : "/images/brand-original.webp";
      let settled = 0;
      const assetReady = () => {
        if (!cancelled) setLoadProgress(++settled / 2);
      };
      const ready = Promise.allSettled([
        document.fonts.ready.then(assetReady),
        image.decode().finally(assetReady),
      ]);
      const limit = new Promise((resolve) => later(resolve, 5000));
      const minimum = new Promise((resolve) => later(resolve, 1900));
      Promise.all([Promise.race([ready, limit]), minimum]).then(() => {
        if (!cancelled) {
          first.current = false;
          setPhase("initial-exit");
          later(() => setPhase("idle"), 1150);
        }
      });
    } else {
      setPhase("cover");
      later(() => {
        commit();
        setPhase("covered");
        later(reveal, 100);
      }, 480);
    }
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [location]);
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [displayed.pathname]);
  useSeo(displayed.pathname);
  const busy = phase !== "idle";
  useLayoutEffect(() => {
    document.documentElement.dataset.routeBusy = String(busy);
    return () => {
      delete document.documentElement.dataset.routeBusy;
    };
  }, [busy]);
  return (
    <TransitionContext.Provider value={busy}>
      <div
        ref={content}
        className="route-content"
        inert={busy || undefined}
        aria-busy={busy}
      >
        {children(displayed)}
      </div>
      {(phase === "initial" || phase === "initial-exit") && (
        <div
          className={`intro ${phase === "initial-exit" ? "finished" : ""}`}
          aria-hidden="true"
        >
          <span className="intro-edition">
            METTA — ESTRATÉGIA &amp; CONTEÚDO
          </span>
          <div className="intro-axis" />
          <div className="intro-mark">
            <Logo />
          </div>
          <span className="intro-caption">
            Toda marca tem um próximo passo.
          </span>
          <div className="intro-status">
            <span>UM NOVO OLHAR</span>
            <span>COMEÇA AQUI</span>
          </div>
          <div className="intro-line">
            <span style={{ transform: `scaleX(${loadProgress})` }} />
          </div>
        </div>
      )}
      <div
        className={`page-curtain curtain-${phase === "initial" || phase === "initial-exit" ? "idle" : phase}`}
        aria-hidden="true"
      >
        <div className="curtain-surface" />
        <div className="curtain-brand">
          <Logo />
          <span>Toda marca tem um próximo passo.</span>
        </div>
        <span className="curtain-edition">METTA — ESTRATÉGIA & CONTEÚDO</span>
      </div>
    </TransitionContext.Provider>
  );
}
