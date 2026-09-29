import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { ChevronRight, Menu } from "lucide-react";
import Logo from "../../Logo.jsx";
import { api } from "../api/client.js";
import { DownloadCenterProvider } from "../api/downloads.js";
import { useAuth } from "../auth/AuthProvider.jsx";
import { roleLabel } from "../auth/roles.js";
import { ToastProvider, useToast } from "../ui/index.js";
import { BrandProvider } from "./BrandContext.jsx";
import Notifications from "./Notifications.jsx";
import PageBoundary from "./PageBoundary.jsx";
import { ShellProvider, useShell } from "./ShellContext.jsx";
import { PageFallback } from "./ShellStates.jsx";
import Sidebar from "./Sidebar.jsx";
import { BrandSwitcher, UserMenu } from "./TopbarMenus.jsx";
import {
  ADMIN_HIDDEN,
  CLIENT_HIDDEN,
  activeItem,
  navFor,
} from "./nav.js";
import "./shell.css";

const MOBILE = "(max-width: 899px)";
// Tablets and small laptops: the sidebar folds into an icon rail so tables
// and forms get the width.
const RAIL = "(min-width: 900px) and (max-width: 1199.98px)";
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function useMatchMedia(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

// Badge numbers the team or the client can act on: requested changes for the
// team, versions waiting for the client's decision in the portal.
function countsLoader(area, can) {
  return async () => {
    if (area === "admin" && !can("approvals.view")) return null;
    const params = area === "admin" ? { status: "changes_requested" } : undefined;
    const data = await api.get("/approvals", { params });
    const total = Number.isFinite(data?.total) ? data.total : data?.items?.length || 0;
    return { approvals: total };
  };
}

function Crumbs({ active, page }) {
  const trail = page?.crumbs?.length
    ? page.crumbs
    : [
        active && { label: active.label, to: active.to },
        page?.title && page.title !== active?.label && { label: page.title },
      ].filter(Boolean);
  if (!trail.length) return <span className="sh-crumbs" />;
  return (
    <nav className="sh-crumbs" aria-label="Você está em">
      <ol>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={`${crumb.label}-${index}`}>
              {!last && crumb.to ? (
                <Link to={crumb.to}>{crumb.label}</Link>
              ) : (
                <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
              )}
              {!last && (
                <ChevronRight size={14} strokeWidth={1.4} aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ShellLayout({ area }) {
  const { user, can } = useAuth();
  const location = useLocation();
  const { counts, page } = useShell();
  const mobile = useMatchMedia(MOBILE);
  const rail = useMatchMedia(RAIL);
  const toast = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarId = useId();
  const menuButtonRef = useRef(null);
  const sidebarRef = useRef(null);
  const mainRef = useRef(null);
  const restoreFocus = useRef(true);
  const lastPath = useRef(location.pathname);

  const groups = useMemo(() => navFor(area, can), [area, can]);
  const active = activeItem(
    location.pathname,
    groups,
    area === "client" ? CLIENT_HIDDEN : ADMIN_HIDDEN,
  );
  const home = area === "client" ? "/painel" : "/admin";
  const title = page?.title || active?.label || "Painel";

  useEffect(() => {
    document.title = `${title} | Metta`;
  }, [title, location.pathname]);

  // New route: close the drawer and move focus to the content for screen readers.
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    restoreFocus.current = false;
    setDrawerOpen(false);
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  useEffect(() => {
    if (!mobile) setDrawerOpen(false);
  }, [mobile]);

  const closeDrawer = useCallback(() => {
    restoreFocus.current = true;
    setDrawerOpen(false);
  }, []);

  // Phone drawer: picking a brand closes it, and the page behind confirms
  // which brand is now on screen.
  const onBrandPicked = useCallback(
    (brand) => {
      closeDrawer();
      toast.info(`Marca: ${brand.name}`);
    },
    [closeDrawer, toast],
  );

  // Layers outside the drawer's stacking (the bulk bar in the top layer) hide
  // while it is open.
  useEffect(() => {
    const root = document.documentElement;
    if (drawerOpen) root.setAttribute("data-sh-drawer", "open");
    else root.removeAttribute("data-sh-drawer");
    return () => root.removeAttribute("data-sh-drawer");
  }, [drawerOpen]);

  // Drawer: scroll lock, focus trap, Escape.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const panel = sidebarRef.current;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    restoreFocus.current = true;
    const frame = requestAnimationFrame(() =>
      (panel?.querySelector('a[aria-current="page"]') || panel?.querySelector(FOCUSABLE))?.focus(),
    );
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter(
        (el) => el.getClientRects().length,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      if (restoreFocus.current) menuButtonRef.current?.focus();
    };
  }, [drawerOpen, closeDrawer]);

  const skipToContent = (event) => {
    event.preventDefault();
    mainRef.current?.focus();
    mainRef.current?.scrollIntoView({ block: "start" });
  };

  const client = area === "client";
  return (
    <>
      <a href="#sh-main" className="sh-skip" onClick={skipToContent}>
        Ir para o conteúdo
      </a>
      <Sidebar
        id={sidebarId}
        panelRef={sidebarRef}
        groups={groups}
        active={active}
        counts={counts}
        home={home}
        areaLabel={client ? "Área do cliente" : "Painel Metta"}
        areaName={client ? user.client?.name : roleLabel(user.role)}
        extra={
          client && mobile ? <BrandSwitcher className="is-dark" onPicked={onBrandPicked} /> : null
        }
        mobile={mobile}
        rail={rail}
        open={drawerOpen}
        onClose={closeDrawer}
      />
      {mobile && (
        <div
          className={`sh-scrim ${drawerOpen ? "is-open" : ""}`}
          onClick={closeDrawer}
          aria-hidden="true"
        />
      )}
      <div className="sh-body">
        <header className="sh-topbar">
          {mobile && (
            <>
              <button
                ref={menuButtonRef}
                type="button"
                className="sh-icon-btn sh-menu-btn"
                aria-label="Abrir menu"
                aria-expanded={drawerOpen}
                aria-controls={sidebarId}
                onClick={() => setDrawerOpen(true)}
              >
                <Menu size={21} strokeWidth={1.4} aria-hidden="true" />
              </button>
              <Link to={home} className="sh-top-logo" aria-label="Metta, início do painel">
                <Logo />
              </Link>
            </>
          )}
          {!mobile && <Crumbs active={active} page={page} />}
          <div className="sh-topbar-actions">
            {client && !mobile && <BrandSwitcher />}
            <Notifications area={area} />
            <UserMenu area={area} />
          </div>
        </header>
        <main id="sh-main" ref={mainRef} tabIndex={-1} className="sh-main">
          <div className="sh-content">
            <div key={location.pathname} className="sh-route">
              <PageBoundary>
                <Suspense fallback={<PageFallback />}>
                  <Outlet />
                </Suspense>
              </PageBoundary>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}

// Product frame for /painel and /admin: sidebar, topbar, notifications, the
// download tray and toasts. Rendered inside <RequireAuth area=…>.
export default function AppShell({ area = "client" }) {
  const { user, can } = useAuth();
  const loadCounts = useMemo(() => countsLoader(area, can), [area, can]);
  return (
    <div className="app sh-root" data-area={area}>
      <ToastProvider>
        <BrandProvider user={user}>
          <ShellProvider loadCounts={loadCounts}>
            <DownloadCenterProvider enabled={can(["materials.view", "portal.access"])}>
              <ShellLayout area={area} />
            </DownloadCenterProvider>
          </ShellProvider>
        </BrandProvider>
      </ToastProvider>
    </div>
  );
}
