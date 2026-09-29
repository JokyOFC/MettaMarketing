// Copy into src/pages and adjust imports to ../components/SiteChrome.jsx.
// Register the route's title and description in src/data/seo.js.
import { Link } from "react-router-dom";
import {
  PageFrame,
  PageHeading,
  Arrow,
} from "../src/components/SiteChrome.jsx";

export default function PageTemplate() {
  return (
    <PageFrame>
      <section className="page-intro">
        <PageHeading
          label="Contexto da seção"
          title="Uma ideia clara."
          accent="Um próximo passo."
        >
          Conteúdo curto e verdadeiro, escrito para quem usa esta página.
        </PageHeading>
      </section>
      <section className="content-block">
        <h2>O conteúdo da página</h2>
        <p>Organize as informações com hierarquia e espaço.</p>
        <Link className="button solid" to="/contato">
          Vamos conversar <Arrow />
        </Link>
      </section>
    </PageFrame>
  );
}
