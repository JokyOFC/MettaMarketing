import { usePageTitle } from "./shell/ShellContext.jsx";
import "./shell/shell.css";

// Temporary body for a route whose slice has not landed yet. Each owning slice
// replaces its stub file, keeping the path and the default export.
export default function PagePlaceholder({ title, description }) {
  usePageTitle(title);
  return (
    <section className="sh-placeholder">
      <span className="sh-state-eyebrow">Em preparação</span>
      <h1 className="sh-placeholder-title">{title}</h1>
      {description && <p className="sh-placeholder-text">{description}</p>}
    </section>
  );
}
