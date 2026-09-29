import { useEffect, useRef, useState } from "react";

// Cinematic loop generated on Higgsfield from the original hero still.
// The still stays as first paint and as the fallback for reduced motion,
// Save-Data, a paused scene and blocked autoplay. The loop starts and ends
// on that frame, so fading between the two is seamless.
const sources = {
  landscape: ["/video/hero-1080.webm", "/video/hero-1080.mp4"],
  wide: ["/video/hero-1440.webm", "/video/hero-1440.mp4"],
  portrait: ["/video/hero-portrait.webm", "/video/hero-portrait.mp4"],
};
// The vertical crop only matches the still's framing on phones held upright.
const PORTRAIT = "(max-width: 760px) and (max-aspect-ratio: 2/3)";
const PAUSED_KEY = "metta-hero-paused";

function pickVariant() {
  if (matchMedia(PORTRAIT).matches) return "portrait";
  return innerWidth * Math.min(devicePixelRatio || 1, 2) > 2200
    ? "wide"
    : "landscape";
}

export function useHeroMotion() {
  const [enabled, setEnabled] = useState(false);
  const [paused, setPausedState] = useState(() => {
    try {
      return localStorage.getItem(PAUSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () =>
      setEnabled(!reduced.matches && !navigator.connection?.saveData);
    update();
    reduced.addEventListener("change", update);
    return () => reduced.removeEventListener("change", update);
  }, []);
  const setPaused = (value) => {
    setPausedState(value);
    try {
      if (value) localStorage.setItem(PAUSED_KEY, "1");
      else localStorage.removeItem(PAUSED_KEY);
    } catch {
      // Private mode or blocked storage: the choice lasts for this visit.
    }
  };
  return { enabled, paused, setPaused };
}

export function HeroMotionToggle({ paused, onToggle }) {
  return (
    <button type="button" className="hero-motion" onClick={onToggle}>
      <svg viewBox="0 0 10 10" aria-hidden="true">
        {paused ? (
          <path d="M2 1v8l7-4z" fill="currentColor" />
        ) : (
          <path d="M2.5 1v8M7.5 1v8" stroke="currentColor" strokeWidth="1.3" />
        )}
      </svg>
      {paused ? "Retomar cena" : "Pausar cena"}
    </button>
  );
}

export default function HeroScene({ ready, enabled, paused }) {
  const video = useRef(null);
  const still = useRef(null);
  const [stillLoaded, setStillLoaded] = useState(false);
  const [variant, setVariant] = useState(null);
  const [playing, setPlaying] = useState(false);
  const active = enabled && !paused;

  useEffect(() => {
    if (still.current?.complete) setStillLoaded(true);
  }, []);

  // Follow rotation: a phone turned sideways needs the 16:9 file again.
  useEffect(() => {
    if (!active) return;
    const portrait = matchMedia(PORTRAIT);
    const update = () => setVariant(pickVariant());
    update();
    portrait.addEventListener("change", update);
    return () => portrait.removeEventListener("change", update);
  }, [active]);

  // Load only after the still, so the first paint keeps the bandwidth.
  // Tearing the source down aborts the download when leaving or pausing.
  useEffect(() => {
    const el = video.current;
    if (!el || !active || !stillLoaded || !variant) return;
    const [webm, mp4] = sources[variant];
    el.muted = true;
    el.src = el.canPlayType('video/webm; codecs="vp9"') ? webm : mp4;
    el.load();
    return () => {
      setPlaying(false);
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, [active, stillLoaded, variant]);

  useEffect(() => {
    const el = video.current;
    if (!el || !active || !ready || !variant) return;
    let visible = true;
    const sync = () => {
      if (visible && !document.hidden) el.play().catch(() => {});
      else el.pause();
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        sync();
      },
      { threshold: 0.01 },
    );
    observer.observe(el);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      el.pause();
    };
  }, [active, ready, variant]);

  return (
    <>
      <img
        ref={still}
        className="hero-image"
        src="/images/hero.webp"
        srcSet="/images/hero.webp 1920w, /images/hero-4k.webp 3840w"
        sizes="100vw"
        alt=""
        fetchPriority="high"
        onLoad={() => setStillLoaded(true)}
      />
      <video
        ref={video}
        className={`hero-image hero-video${variant === "portrait" ? " is-portrait" : ""}${playing && active ? " is-playing" : ""}`}
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        disableRemotePlayback
        tabIndex={-1}
        aria-hidden="true"
        onPlaying={() => setPlaying(true)}
      />
    </>
  );
}
