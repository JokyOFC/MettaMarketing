import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import Logo from "../Logo.jsx";

export const navigation = [
  ["/", "Início"],
  ["/sobre", "A Metta"],
  ["/solucoes", "Soluções"],
  ["/metodo", "Método"],
  ["/planos", "Planos"],
  ["/contato", "Contato"],
];
export function Arrow({ diagonal = false }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={diagonal ? "M5 19 19 5M5 5h14v14" : "M3 12h17m-6-6 6 6-6 6"}
        stroke="currentColor"
        strokeWidth="1.15"
      />
    </svg>
  );
}
export function SiteHeader({
  tone = "light",
  busy = false,
  transparent = false,
  hidden = false,
}) {
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!menu) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const targets = [
      ...document.querySelectorAll("main, .section-navigator, footer"),
    ];
    targets.forEach((el) => el.setAttribute("inert", ""));
    const close = (e) => {
      if (e.key === "Escape") {
        setMenu(false);
        document.querySelector(".menu-button")?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previous;
      targets.forEach((el) => el.removeAttribute("inert"));
      window.removeEventListener("keydown", close);
    };
  }, [menu]);
  return (
    <header
      className={`header site-header tone-${tone} ${transparent ? "is-transparent" : ""} ${hidden && !menu ? "is-hidden" : ""} ${menu ? "menu-open" : ""}`}
      inert={busy || (hidden && !menu) || undefined}
    >
      <Link
        className="brand"
        to="/"
        aria-label="Metta Marketing, início"
        onClick={() => setMenu(false)}
      >
        <Logo />
      </Link>
      <nav className="desktop-nav" aria-label="Navegação principal">
        {navigation.map(([url, title]) => (
          <NavLink key={url} to={url} end>
            {title}
          </NavLink>
        ))}
      </nav>
      <Link className="button header-cta" to="/login">
        Área do cliente <Arrow />
      </Link>
      <button
        className="menu-button"
        aria-label={menu ? "Fechar menu" : "Abrir menu"}
        aria-expanded={menu}
        aria-controls="mobile-nav"
        onClick={() => setMenu(!menu)}
      >
        <span />
        <span />
      </button>
      {menu && (
        <nav
          id="mobile-nav"
          className="mobile-nav"
          aria-label="Navegação mobile"
        >
          {[...navigation, ["/login", "Área do cliente"]].map(
            ([url, title], i) => (
              <Link to={url} key={url} onClick={() => setMenu(false)}>
                <small>0{i + 1}</small>
                {title}
                <Arrow />
              </Link>
            ),
          )}
        </nav>
      )}
    </header>
  );
}
export function SiteFooter({ compact = false, home = false }) {
  return (
    <footer
      id={home ? "rodape" : undefined}
      className={home ? "home-footer" : compact ? "compact-footer" : ""}
    >
      {!compact && (
        <div className="footer-top">
          <Link to="/" aria-label="Metta, início">
            <Logo />
          </Link>
          <p>
            Estratégias que conectam
            <br />
            sua fintech aos clientes.
          </p>
          {home ? (
            <a href="#inicio" className="back-top">
              Voltar ao início <Arrow diagonal />
            </a>
          ) : (
            <Link to="/contato" className="text-link">
              Vamos conversar <Arrow />
            </Link>
          )}
        </div>
      )}
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Metta Marketing</span>
        <span>METTA MARKETING LTDA · CNPJ 68.562.250/0001-59</span>
        <Link to="/login">Área do cliente ↗</Link>
      </div>
    </footer>
  );
}
// Titles and meta tags come from src/data/seo.js via useSeo in PageTransition.
export function PageFrame({ children, dark = false }) {
  return (
    <div className={`inner-page ${dark ? "page-dark" : ""}`}>
      <a className="skip" href="#page-content">
        Ir para o conteúdo
      </a>
      <SiteHeader tone={dark ? "dark" : "light"} />
      <main id="page-content">{children}</main>
      <SiteFooter />
    </div>
  );
}
export function PageHeading({ label, title, accent, children }) {
  return (
    <div className="page-heading">
      <p className="eyebrow">
        <span className="dash" />
        {label}
      </p>
      <h1>
        {title}
        <br />
        <em>{accent}</em>
      </h1>
      {children && <p>{children}</p>}
    </div>
  );
}
