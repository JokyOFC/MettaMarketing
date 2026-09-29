import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import Logo from "../../Logo.jsx";
import { Tooltip } from "../ui/Tooltip.jsx";

// Deep-olive navigation. One indicator slides to the active item (220 ms);
// on phones the same element becomes the drawer (AppShell handles the trap).
// Between 900 and 1200 px it is an icon rail (`rail`): labels stay in the
// accessible name and show as tooltips on hover and keyboard focus.
export default function Sidebar({
  id,
  groups,
  active,
  counts,
  home,
  areaLabel,
  areaName,
  extra,
  mobile,
  rail = false,
  open,
  onClose,
  panelRef,
}) {
  const navRef = useRef(null);
  const [indicator, setIndicator] = useState(null);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const place = () => {
      const link = nav.querySelector('a[aria-current="page"]');
      if (!link) {
        setIndicator(null);
        return;
      }
      setIndicator({ top: link.offsetTop, height: link.offsetHeight });
    };
    // Keep the current item visible when the list is taller than the window.
    const aside = nav.closest(".sh-sidebar");
    const link = nav.querySelector('a[aria-current="page"]');
    if (aside && link && aside.scrollHeight > aside.clientHeight) {
      const box = aside.getBoundingClientRect();
      const item = link.getBoundingClientRect();
      const margin = 24;
      if (item.bottom > box.bottom - margin) aside.scrollTop += item.bottom - box.bottom + margin;
      else if (item.top < box.top + margin) aside.scrollTop -= box.top + margin - item.top;
    }
    place();
    const frame = requestAnimationFrame(() => setAnimate(true));
    const observer = new ResizeObserver(place);
    observer.observe(nav);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, groups, rail]);

  const hidden = mobile && !open;
  return (
    <aside
      id={id}
      ref={panelRef}
      className={`sh-sidebar ${open ? "is-open" : ""} ${rail ? "is-rail" : ""}`}
      aria-label="Navegação do painel"
      inert={hidden || undefined}
      aria-hidden={hidden || undefined}
      {...(mobile ? { role: "dialog", "aria-modal": open || undefined } : {})}
    >
      <div className="sh-sidebar-top">
        <Link to={home} className="sh-logo" aria-label="Metta, início do painel">
          <Logo />
        </Link>
        {mobile && (
          <button
            type="button"
            className="sh-icon-btn sh-drawer-close"
            onClick={onClose}
            aria-label="Fechar menu"
          >
            <X size={20} strokeWidth={1.4} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="sh-area">
        <span className="sh-area-label">{areaLabel}</span>
        {areaName && <strong className="sh-area-name">{areaName}</strong>}
        {extra}
      </div>
      <nav className="sh-nav" ref={navRef} aria-label="Principal">
        {indicator && (
          <span
            className={`sh-nav-indicator ${animate ? "is-ready" : ""}`}
            style={{
              transform: `translateY(${indicator.top}px)`,
              height: `${indicator.height}px`,
            }}
            aria-hidden="true"
          />
        )}
        {groups.map((group) => (
          <div className="sh-nav-group" key={group.label}>
            <span className="sh-nav-heading">{group.label}</span>
            <ul>
              {group.items.map((item) => {
                const Icon = item.icon;
                const current = active?.to === item.to;
                const count = item.countKey ? counts[item.countKey] : 0;
                return (
                  <li key={item.to}>
                    <Tooltip content={item.label} placement="right" describe={false} disabled={!rail}>
                    <Link
                      to={item.to}
                      className={`sh-nav-link ${current ? "is-active" : ""}`}
                      aria-current={current ? "page" : undefined}
                    >
                      <Icon size={18} strokeWidth={1.4} aria-hidden="true" />
                      <span className="sh-nav-text">{item.label}</span>
                      {count > 0 && (
                        <span className="sh-nav-count">
                          <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
                          <span className="sh-sr">
                            , {count} {item.countLabel || "pendentes"}
                          </span>
                        </span>
                      )}
                    </Link>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="sh-sidebar-foot">
        <span>METTA · ESTRATÉGIA &amp; CONTEÚDO</span>
      </div>
    </aside>
  );
}
