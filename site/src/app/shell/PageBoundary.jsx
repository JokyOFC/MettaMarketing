import { Component } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

const isChunkError = (error) =>
  /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(
    String(error?.message || ""),
  );

// Keeps one broken page (or a stale chunk after a deploy) from blanking the
// whole shell. Reset by remounting (the shell keys it by pathname).
export default class PageBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkError(error);
    return (
      <section className="sh-state" role="alert">
        <span className="sh-state-icon">
          <TriangleAlert size={22} strokeWidth={1.4} aria-hidden="true" />
        </span>
        <h1 className="sh-state-title">
          {chunk ? "Há uma versão nova do painel." : "Algo deu errado nesta página."}
        </h1>
        <div className="sh-state-text">
          <p>
            {chunk
              ? "Atualize a página para carregar a versão mais recente."
              : "Atualize a página para tentar de novo. Se o erro continuar, avise a equipe da Metta."}
          </p>
        </div>
        <div className="sh-state-actions">
          <button
            type="button"
            className="sh-btn primary"
            onClick={() => window.location.reload()}
          >
            <RotateCcw size={16} strokeWidth={1.4} aria-hidden="true" />
            Atualizar a página
          </button>
        </div>
      </section>
    );
  }
}
