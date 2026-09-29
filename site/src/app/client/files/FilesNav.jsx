// Area -> category navigation with counts (sidebar on desktop, chip rail on phones).
import { Link } from "react-router-dom";
import { formatNumber } from "../../ui/index.js";
import { cx } from "../brand/lib.js";

export const AREAS = [
  { key: "identity", label: "Identidade visual" },
  { key: "content", label: "Conteúdo" },
  { key: "other", label: "Materiais" },
];

export const areaOf = (material) =>
  AREAS.some((a) => a.key === material.category?.area) ? material.category.area : "other";

// [{key, label, count, categories: [{slug, id, name, count}]}] for areas with files.
export function buildTree(items) {
  const areas = new Map(AREAS.map((a) => [a.key, { ...a, count: 0, categories: new Map() }]));
  for (const material of items) {
    const area = areas.get(areaOf(material));
    area.count += 1;
    const slug = material.category?.slug || "sem-categoria";
    if (!area.categories.has(slug))
      area.categories.set(slug, {
        slug,
        id: material.category?.id,
        name: material.category?.name || "Sem categoria",
        sortOrder: material.category?.sortOrder ?? 9999,
        count: 0,
      });
    area.categories.get(slug).count += 1;
  }
  return [...areas.values()]
    .filter((a) => a.count)
    .map((a) => ({
      ...a,
      categories: [...a.categories.values()].sort(
        (x, y) => x.sortOrder - y.sortOrder || x.name.localeCompare(y.name, "pt-BR"),
      ),
    }));
}

function NavLink({ to, active, children, count, className }) {
  return (
    <Link
      to={to}
      replace
      className={cx("mb-nav__link", active && "is-active", className)}
      aria-current={active ? "page" : undefined}
    >
      <span className="mb-nav__label">{children}</span>
      <span className="mb-nav__count">{formatNumber(count)}</span>
    </Link>
  );
}

export default function FilesNav({ tree, total, area, categoria, hrefFor }) {
  const allActive = !area && !categoria;
  return (
    <nav className="mb-nav" aria-label="Áreas e categorias">
      <NavLink to={hrefFor({ area: null, categoria: null })} active={allActive} count={total} className="is-all">
        Todos os arquivos
      </NavLink>
      {tree.map((group) => (
        <div key={group.key} className="mb-nav__group" role="group" aria-label={group.label}>
          <NavLink
            to={hrefFor({ area: group.key, categoria: null })}
            active={area === group.key && !categoria}
            count={group.count}
            className="is-area"
          >
            {group.label}
          </NavLink>
          <ul className="mb-nav__cats">
            {group.categories.map((category) => (
              <li key={category.slug}>
                <NavLink
                  to={hrefFor({ area: null, categoria: category.slug })}
                  active={categoria === category.slug}
                  count={category.count}
                >
                  {category.name}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
