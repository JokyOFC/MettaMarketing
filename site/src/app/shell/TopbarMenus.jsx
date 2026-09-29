import { useId } from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  Check,
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  UserRound,
} from "lucide-react";
import { useAuth } from "../auth/AuthProvider.jsx";
import { roleLabel } from "../auth/roles.js";
import { initials } from "../ui/format.js";
import { useBrand } from "./BrandContext.jsx";
import { useDropdown } from "./useDropdown.js";

const ICON = { size: 16, strokeWidth: 1.4, "aria-hidden": true };

// Brand picker for clients with more than one brand; a quiet label otherwise.
// `onPicked(brand)` runs after a choice (the phone drawer closes itself).
export function BrandSwitcher({ className = "", onPicked }) {
  const { brands, brand, setBrandId } = useBrand();
  const dropdown = useDropdown();
  const menuId = useId();
  if (!brand) return null;
  if (brands.length < 2)
    return (
      <span className={`sh-brand-static ${className}`}>
        <span className="sh-brand-kicker">Marca</span>
        <span className="sh-brand-name">{brand.name}</span>
      </span>
    );
  return (
    <div className={`sh-dd sh-brand ${className}`} ref={dropdown.rootRef}>
      <button
        ref={dropdown.buttonRef}
        type="button"
        className="sh-brand-btn"
        aria-haspopup="menu"
        aria-expanded={dropdown.open}
        aria-controls={dropdown.open ? menuId : undefined}
        onClick={dropdown.toggle}
        onKeyDown={dropdown.onButtonKeyDown}
      >
        <span className="sh-brand-kicker">Marca</span>
        <span className="sh-brand-name">{brand.name}</span>
        <ChevronsUpDown {...ICON} />
      </button>
      {dropdown.open && (
        <div
          ref={dropdown.panelRef}
          id={menuId}
          className="sh-panel sh-menu"
          role="menu"
          aria-label="Escolher marca"
          onKeyDown={dropdown.onPanelKeyDown}
        >
          <span className="sh-menu-label" role="presentation">
            Suas marcas
          </span>
          {brands.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === brand.id}
              className="sh-menu-item"
              tabIndex={-1}
              onClick={() => {
                setBrandId(item.id);
                dropdown.close(!onPicked);
                onPicked?.(item);
              }}
            >
              <span>{item.name}</span>
              {item.id === brand.id && <Check {...ICON} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function UserMenu({ area }) {
  const { user, logout } = useAuth();
  const dropdown = useDropdown();
  const menuId = useId();
  if (!user) return null;
  const base = area === "client" ? "/painel" : "/admin";
  const role = roleLabel(user.role);
  return (
    <div className="sh-dd sh-user" ref={dropdown.rootRef}>
      <button
        ref={dropdown.buttonRef}
        type="button"
        className="sh-user-btn"
        aria-haspopup="menu"
        aria-expanded={dropdown.open}
        aria-controls={dropdown.open ? menuId : undefined}
        aria-label={`Menu da conta de ${user.name}`}
        onClick={dropdown.toggle}
        onKeyDown={dropdown.onButtonKeyDown}
      >
        <span className="sh-avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <span className="sh-user-text" aria-hidden="true">
          <strong>{user.name}</strong>
          <span>{area === "client" ? user.client?.name || role : role}</span>
        </span>
      </button>
      {dropdown.open && (
        <div
          ref={dropdown.panelRef}
          id={menuId}
          className="sh-panel sh-menu sh-user-panel"
          role="menu"
          aria-label="Conta"
          onKeyDown={dropdown.onPanelKeyDown}
        >
          <div className="sh-user-card" role="presentation">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            <span className="sh-role">{role}</span>
          </div>
          <Link
            role="menuitem"
            tabIndex={-1}
            className="sh-menu-item"
            to={`${base}/conta`}
            onClick={() => dropdown.close(false)}
          >
            <UserRound {...ICON} />
            <span>Conta</span>
          </Link>
          {area === "client" && (
            <Link
              role="menuitem"
              tabIndex={-1}
              className="sh-menu-item"
              to="/painel/notificacoes"
              onClick={() => dropdown.close(false)}
            >
              <Bell {...ICON} />
              <span>Notificações</span>
            </Link>
          )}
          <a
            role="menuitem"
            tabIndex={-1}
            className="sh-menu-item"
            href="/"
            target="_blank"
            rel="noopener"
            onClick={() => dropdown.close(false)}
          >
            <ExternalLink {...ICON} />
            <span>Ver o site da Metta</span>
          </a>
          <span className="sh-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="sh-menu-item"
            onClick={() => {
              dropdown.close(false);
              logout();
            }}
          >
            <LogOut {...ICON} />
            <span>Sair</span>
          </button>
        </div>
      )}
    </div>
  );
}
