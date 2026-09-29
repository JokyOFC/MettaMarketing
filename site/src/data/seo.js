// Single source for search and sharing metadata. Used at runtime by
// src/components/Seo.jsx and at build time by vite.config.js, which writes a
// static HTML file per route so crawlers and link previews see the right tags.
import { contactEmail } from "./brand.js";

// Change this if the site is published under another domain (e.g. www.).
export const SITE_URL = "https://mettamkt.com.br";
export const SITE_NAME = "Metta Marketing";
export const DEFAULT_IMAGE = "/og-image.jpg";
export const DEFAULT_IMAGE_ALT =
  "Metta Marketing — estratégia, conteúdo e gestão para marcas que avançam";

export const routes = {
  "/": {
    title: "Metta Marketing | Marketing para fintechs e bancos digitais",
    description:
      "Estratégia, conteúdo e presença digital para fintechs e bancos digitais com visão de futuro. Conheça os planos da Metta Marketing.",
  },
  "/sobre": {
    title: "Sobre a Metta | Marketing com estratégia e propósito",
    description:
      "Conheça a Metta Marketing: visão de negócio, sensibilidade criativa e gestão para transformar a presença digital em crescimento real.",
    crumb: "A Metta",
  },
  "/solucoes": {
    title: "Soluções em estratégia, conteúdo e gestão | Metta",
    description:
      "Posicionamento, planejamento de conteúdo, artes, textos, Reels e gestão de Instagram com acompanhamento de métricas. Conheça as soluções da Metta.",
    crumb: "Soluções",
  },
  "/metodo": {
    title: "Método de trabalho: da escuta à evolução | Metta",
    description:
      "Um processo claro que conecta escuta, planejamento, produção e acompanhamento para a comunicação da sua marca evoluir com consistência.",
    crumb: "Método",
  },
  "/planos": {
    title: "Planos de marketing digital a partir de R$ 1.500 | Metta",
    description:
      "Compare os planos Presença, Gestão e Estratégia: conteúdo, gestão de Instagram, Reels e estratégia mensal. Escolha o momento da sua marca.",
    crumb: "Planos",
  },
  "/contato": {
    title: "Contato | Fale com a Metta Marketing",
    description: `Conte o momento da sua marca e vamos encontrar a direção juntos. Fale com a Metta Marketing pelo e-mail ${contactEmail}.`,
    crumb: "Contato",
  },
  "/login": {
    title: "Entrar | Metta Marketing",
    description:
      "Acesso à área do cliente e ao painel da equipe Metta Marketing.",
    noindex: true,
  },
  "/cadastro": {
    title: "Criar conta | Metta Marketing",
    description:
      "Crie o acesso da sua empresa à área do cliente da Metta Marketing.",
    noindex: true,
  },
  "/confirmar-email": {
    title: "Confirmar e-mail | Metta Marketing",
    description: "Confirme o seu e-mail para ativar o acesso à Metta.",
    noindex: true,
    prefix: true,
  },
  "/painel": {
    title: "Área do cliente | Metta Marketing",
    description:
      "Marca, conteúdo, arquivos, aprovações e projetos da sua empresa com a Metta.",
    noindex: true,
  },
  "/admin": {
    title: "Painel Metta | Metta Marketing",
    description: "Painel interno da equipe Metta Marketing.",
    noindex: true,
  },
  "/convite": {
    title: "Convite | Metta Marketing",
    description: "Aceite o convite e defina a sua senha de acesso à Metta.",
    noindex: true,
    prefix: true,
  },
  "/recuperar-senha": {
    title: "Recuperar senha | Metta Marketing",
    description: "Receba um link para redefinir a senha de acesso à Metta.",
    noindex: true,
  },
  "/redefinir-senha": {
    title: "Redefinir senha | Metta Marketing",
    description: "Defina uma nova senha de acesso à Metta.",
    noindex: true,
    prefix: true,
  },
};

export const notFound = {
  title: "Página não encontrada | Metta Marketing",
  description: "Esta página não está por aqui. Volte para o início da Metta.",
  noindex: true,
};

// Product sub-routes (/painel/marca, /admin/clientes/:id, /convite/:token…)
// share their section's metadata; all of them are noindex.
const sections = ["/painel", "/admin", "/convite", "/redefinir-senha", "/confirmar-email"];
export const seoFor = (path) => {
  if (routes[path] && !routes[path].prefix) return routes[path];
  const section = sections.find((base) => path.startsWith(`${base}/`));
  return section ? routes[section] : notFound;
};
export const absolute = (path) => `${SITE_URL}${path === "/" ? "/" : path}`;
export const robotsFor = (page) =>
  page.noindex ? "noindex, nofollow" : "index, follow, max-image-preview:large";

const organization = {
  "@type": "ProfessionalService",
  "@id": `${SITE_URL}/#organization`,
  name: SITE_NAME,
  legalName: "METTA MARKETING LTDA",
  taxID: "68.562.250/0001-59",
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/brand/metta-logo.png`,
  image: `${SITE_URL}${DEFAULT_IMAGE}`,
  description: routes["/"].description,
  email: contactEmail,
  telephone: "+55 11 2062-0707",
  priceRange: "R$ 1.500 – R$ 4.500 / mês",
  areaServed: { "@type": "Country", name: "Brasil" },
  knowsAbout: [
    "Marketing digital",
    "Estratégia de conteúdo",
    "Gestão de Instagram",
    "Posicionamento de marca",
    "Marketing para fintechs",
    "Marketing para bancos digitais",
  ],
};

// JSON-LD graph for a route: the organization and site on the home page,
// breadcrumbs on the editorial pages.
export function structuredData(path) {
  const route = routes[path];
  if (!route || route.noindex) return null;
  if (path === "/")
    return {
      "@context": "https://schema.org",
      "@graph": [
        organization,
        {
          "@type": "WebSite",
          "@id": `${SITE_URL}/#website`,
          url: `${SITE_URL}/`,
          name: SITE_NAME,
          inLanguage: "pt-BR",
          publisher: { "@id": `${SITE_URL}/#organization` },
        },
      ],
    };
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Início",
        item: `${SITE_URL}/`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: route.crumb,
        item: absolute(path),
      },
    ],
  };
}

const escape = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Static <head> block for a route, written into each HTML file at build time.
// Keep the selectors in sync with src/components/Seo.jsx, which updates them
// on client-side navigation.
export function headTags(path, page = seoFor(path)) {
  const url = absolute(path);
  const image = `${SITE_URL}${DEFAULT_IMAGE}`;
  const data = structuredData(path);
  const tags = [
    `<title>${escape(page.title)}</title>`,
    `<meta name="description" content="${escape(page.description)}" />`,
    `<meta name="robots" content="${robotsFor(page)}" />`,
    page.noindex ? "" : `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:locale" content="pt_BR" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${escape(page.title)}" />`,
    `<meta property="og:description" content="${escape(page.description)}" />`,
    page.noindex ? "" : `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escape(DEFAULT_IMAGE_ALT)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(page.title)}" />`,
    `<meta name="twitter:description" content="${escape(page.description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    path === "/"
      ? `<link rel="preload" as="image" href="/images/hero.webp" imagesrcset="/images/hero.webp 1920w, /images/hero-4k.webp 3840w" imagesizes="100vw" fetchpriority="high" />`
      : "",
    data
      ? `<script type="application/ld+json" id="structured-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`
      : "",
  ];
  return `<!-- seo -->\n    ${tags.filter(Boolean).join("\n    ")}\n    <!-- /seo -->`;
}
