import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const ShellContext = createContext(null);
const COUNTS_MS = 90_000;

// Page title/crumbs for the topbar and sidebar badge counts. `loadCounts`
// resolves to {key: number}; it runs on mount, on window focus and every 90 s.
export function ShellProvider({ children, loadCounts }) {
  const [page, setPage] = useState(null);
  const [counts, setCounts] = useState({});
  const loader = useRef(loadCounts);
  loader.current = loadCounts;

  const setNavCount = useCallback(
    (key, value) =>
      setCounts((current) =>
        current[key] === value ? current : { ...current, [key]: value },
      ),
    [],
  );

  const refreshCounts = useCallback(async (event) => {
    if (!loader.current) return;
    if (event === "tick" && document.visibilityState === "hidden") return;
    try {
      const next = await loader.current();
      if (next) setCounts((current) => ({ ...current, ...next }));
    } catch {
      /* badges are a hint; the pages hold the real lists */
    }
  }, []);

  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && refreshCounts();
    refreshCounts();
    const timer = setInterval(() => refreshCounts("tick"), COUNTS_MS);
    window.addEventListener("focus", refreshCounts);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshCounts);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshCounts]);

  const value = useMemo(
    () => ({ page, setPage, counts, setNavCount, refreshCounts }),
    [page, counts, setNavCount, refreshCounts],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

const detached = {
  page: null,
  setPage: () => {},
  counts: {},
  setNavCount: () => {},
  refreshCounts: () => {},
};

// { counts, setNavCount(key, n), refreshCounts() } for pages that change
// what a badge counts (e.g. after an approval).
export function useShell() {
  return useContext(ShellContext) || detached;
}

// usePageTitle("Clientes") -> document.title "Clientes | Metta" and the topbar
// crumb. crumbs: optional [{label, to}] to replace the derived trail.
export function usePageTitle(title, { crumbs } = {}) {
  const shell = useContext(ShellContext);
  const setPage = shell?.setPage;
  const crumbKey = crumbs ? JSON.stringify(crumbs) : "";
  useEffect(() => {
    if (!title) return undefined;
    if (!setPage) {
      document.title = `${title} | Metta`;
      return undefined;
    }
    setPage({ title, crumbs: crumbKey ? JSON.parse(crumbKey) : null });
    return () => setPage(null);
  }, [title, crumbKey, setPage]);
}
