// /painel/marca — the client's brand library ("Minha marca").
import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Package, Shapes } from "lucide-react";
import { useDownloads } from "../../api/downloads.js";
import { useBrand, usePageTitle } from "../../shell/index.js";
import {
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  formatNumber,
  useApi,
  useReducedMotion,
} from "../../ui/index.js";
import { cx, editableFiles, filesOf, scrollToId, useMaterialDetails } from "./lib.js";
import { FormatList, RichText, SectionHead, ZipButton } from "./parts.jsx";
import { LogoGallery, LogoLightbox, PrincipalLogo } from "./LogoShowcase.jsx";
import Palette, { PaletteCopy } from "./Palette.jsx";
import Typography from "./Typography.jsx";
import { DownloadsArea, ManualCard } from "./BrandSections.jsx";
import "./brand.css";

// Variant groups in display order; each card carries its group as eyebrow.
const LOGO_GROUPS = [
  { key: "secundaria", eyebrow: "Versão secundária" },
  { key: "simbolo", eyebrow: "Símbolo ou ícone" },
  { key: "clara", eyebrow: "Versão clara" },
  { key: "escura", eyebrow: "Versão escura" },
  { key: "monocromatica", eyebrow: "Monocromática" },
  { key: "outros", eyebrow: "Outra versão" },
];

const FONT_FORMATS = new Set(["TTF", "OTF", "WOFF", "WOFF2", "EOT"]);

const arr = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

// Library payload -> what the page renders, without repeating a material.
function shape(data, fallbackBrand) {
  const logos = data?.logos || {};
  const principalList = arr(logos.principal);
  const principal = principalList.find((m) => m.isPrimary) || principalList[0] || null;
  const seen = new Set(principal ? [principal.id] : []);
  const take = (list) =>
    list.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

  const groups = {};
  for (const group of LOGO_GROUPS) {
    const source =
      group.key === "outros"
        ? [...principalList.filter((m) => m !== principal), ...arr(logos.outros)]
        : arr(logos[group.key]);
    groups[group.key] = take(source);
  }
  const manual = take(arr(data?.manual));
  const colors = arr(data?.colors);
  const fonts = arr(data?.fonts);

  const paletteMaterials = [];
  const typeMaterials = [];
  const elements = [];
  for (const section of arr(data?.sections)) {
    const slug = section.category?.slug;
    if (slug === "logotipo" || slug === "manual-da-marca") {
      take(arr(section.materials));
      continue;
    }
    // Font files already live in the typography cards (with their licence
    // rule); other typography material (specimens, PDFs) stays visible.
    if (slug === "tipografia" && fonts.length) {
      const linked = new Set(fonts.map((f) => f.materialId || f.material?.id).filter(Boolean));
      const onlyFonts = (m) =>
        linked.has(m.id) ||
        (m.formats?.length > 0 && m.formats.every((f) => FONT_FORMATS.has(String(f).toUpperCase())));
      const items = take(arr(section.materials).filter((m) => !onlyFonts(m)));
      take(arr(section.materials));
      if (items.length) typeMaterials.push(...items);
      continue;
    }
    const items = take(arr(section.materials));
    if (!items.length) continue;
    if (slug === "paleta-de-cores" && colors.length) paletteMaterials.push(...items);
    else elements.push({ category: section.category, materials: items });
  }
  const loose = take(arr(data?.identity));
  if (loose.length)
    elements.push({ category: { slug: "outros", name: elements.length ? "Outros elementos" : "Elementos" }, materials: loose });

  const brand = { ...(fallbackBrand || {}), ...(data?.brand || {}) };
  return {
    brand,
    principal,
    groups,
    manual,
    colors,
    fonts,
    paletteMaterials,
    typeMaterials,
    elements,
    kits: arr(data?.kits),
    counts: data?.counts || {},
    editableCount: data?.editables?.count ?? null,
  };
}

// Highlights the section in view in the in-page navigation.
function useActiveSection(ids) {
  const [active, setActive] = useState(ids[0]);
  const key = ids.join(",");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !ids.length) return undefined;
    const visible = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const first = ids.find((id) => visible.get(id));
        if (first) setActive(first);
      },
      { rootMargin: "-20% 0px -65% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
}

function SectionNav({ sections }) {
  const reduced = useReducedMotion();
  const active = useActiveSection(sections.map((s) => s.anchor));
  if (sections.length < 3) return null;
  return (
    <nav className="mb-secnav" aria-label="Seções da marca">
      <ol>
        {sections.map((section) => (
          <li key={section.anchor}>
            <a
              href={`#${section.anchor}`}
              className={cx(active === section.anchor && "is-active")}
              aria-current={active === section.anchor ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                scrollToId(section.headingId, reduced);
              }}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function LibrarySkeleton() {
  return (
    <div className="mb-page" aria-busy="true">
      <span className="ui-sr-only" role="status">
        Carregando a biblioteca da marca
      </span>
      <div className="mb-hero" aria-hidden="true">
        <div className="mb-hero__text">
          <Skeleton width={90} height={10} />
          <Skeleton width="min(420px, 80%)" height={40} style={{ marginTop: 18 }} />
          <Skeleton width="min(520px, 95%)" height={13} style={{ marginTop: 18 }} />
          <Skeleton width="min(380px, 70%)" height={13} style={{ marginTop: 8 }} />
        </div>
        <div className="mb-hero__actions">
          <Skeleton width={220} height={42} radius={999} />
          <Skeleton width={180} height={42} radius={999} />
        </div>
      </div>
      <div className="mb-sec" aria-hidden="true">
        <Skeleton width={160} height={10} />
        <Skeleton width={260} height={26} style={{ margin: "14px 0 28px" }} />
        <div className="mb-principal">
          <div className="mb-principal__stage">
            <span className="mb-skelblock" style={{ aspectRatio: "16 / 10" }} />
          </div>
          <div className="mb-principal__info">
            <Skeleton width="60%" height={22} />
            <Skeleton width="80%" height={12} />
            <Skeleton width="50%" height={12} />
            <div className="mb-chips">
              <Skeleton width={96} height={34} radius={999} />
              <Skeleton width={96} height={34} radius={999} />
              <Skeleton width={96} height={34} radius={999} />
            </div>
          </div>
        </div>
      </div>
      <div className="mb-logogrid" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="mb-logo">
            <span className="mb-skelblock" style={{ aspectRatio: "4 / 3" }} />
            <div className="mb-logo__body">
              <Skeleton width="55%" height={14} />
              <Skeleton width="35%" height={11} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BrandLibrary() {
  usePageTitle("Minha marca");
  const { brand: currentBrand } = useBrand();
  const brandId = currentBrand?.id;
  const { data, error, loading, reload } = useApi(
    brandId ? `/brands/${encodeURIComponent(brandId)}/library` : null,
  );
  const { startZip } = useDownloads();
  const [lightbox, setLightbox] = useState(null);

  const lib = useMemo(() => shape(data, currentBrand), [data, currentBrand]);
  const logoGroups = LOGO_GROUPS.filter((g) => lib.groups[g.key]?.length);
  const visual = useMemo(
    () => [
      ...(lib.principal ? [lib.principal] : []),
      ...LOGO_GROUPS.flatMap((g) => lib.groups[g.key] || []),
      ...lib.paletteMaterials,
      ...lib.typeMaterials,
      ...lib.elements.flatMap((e) => e.materials),
    ],
    [lib],
  );
  const allMaterials = useMemo(() => [...visual, ...lib.manual], [visual, lib]);
  const details = useMaterialDetails(allMaterials);

  const editables = useMemo(() => {
    const out = [];
    for (const material of allMaterials) {
      if (!material.editableIncluded) continue;
      for (const file of editableFiles(filesOf(details.map[material.id])))
        out.push({ file, material });
    }
    return out;
  }, [allMaterials, details]);
  const editablesLoading = allMaterials.some(
    (m) => m.editableIncluded && !details.map[m.id] && !details.errors[m.id],
  );
  const editableCount = lib.editableCount ?? editables.length;

  if (!currentBrand)
    return (
      <div className="mb-page">
        <EmptyState
          icon={Shapes}
          title="Nenhuma marca vinculada à sua conta"
          description="Assim que a Metta cadastrar sua marca, a identidade visual aparecerá aqui."
        />
      </div>
    );
  if (loading && !data) return <LibrarySkeleton />;
  if (error && !data)
    return (
      <div className="mb-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );

  const brand = lib.brand;
  // Returns the tray job so the button can follow its progress.
  const brandKit = () =>
    startZip({ type: "brand_kit", brandId }, { label: `Kit completo — ${brand.name || "marca"}` });
  const openLightbox = (material, bg) => {
    const index = visual.findIndex((m) => m.id === material.id);
    if (index >= 0) setLightbox({ index, bg });
  };

  const hasLogos = Boolean(lib.principal || logoGroups.length);
  const hasColors = lib.colors.length > 0;
  const hasType = lib.fonts.length > 0 || Boolean(brand.typographyGuidelines);
  const hasUsage = Boolean(brand.usageGuidelines);
  const hasManual = lib.manual.length > 0;
  const hasElements = lib.elements.length > 0;
  const hasFiles = (lib.counts.files || 0) > 0 || allMaterials.length > 0;
  const nothing =
    !hasLogos && !hasColors && !hasType && !hasUsage && !hasManual && !hasElements && !hasFiles;

  const sections = [
    hasLogos && { anchor: "mb-logos", label: "Logotipo", eyebrow: "Logotipo" },
    hasColors && { anchor: "mb-cores", label: "Cores", eyebrow: "Paleta de cores" },
    hasType && { anchor: "mb-tipografia", label: "Tipografia", eyebrow: "Tipografia" },
    hasUsage && { anchor: "mb-orientacoes", label: "Orientações", eyebrow: "Aplicação" },
    hasManual && { anchor: "mb-manual", label: "Manual", eyebrow: "Documento" },
    hasElements && { anchor: "mb-elementos", label: "Elementos", eyebrow: "Identidade visual" },
    hasFiles && { anchor: "mb-arquivos", label: "Arquivos", eyebrow: "Downloads" },
  ]
    .filter(Boolean)
    .map((section, i) => ({ ...section, index: i + 1, headingId: `${section.anchor}-title` }));
  const sec = Object.fromEntries(sections.map((s) => [s.anchor, s]));
  const head = (anchor, props) => (
    <SectionHead id={sec[anchor].headingId} index={sec[anchor].index} eyebrow={sec[anchor].eyebrow} {...props} />
  );

  const formats = lib.counts.formats || [];
  const fileCount = lib.counts.files || 0;

  return (
    <div className="mb-page">
      <header className="mb-hero ui-page-enter">
        <div className="mb-hero__text">
          <p className="ui-eyebrow">Minha marca</p>
          <h1 className="mb-hero__title">{brand.name}</h1>
          {brand.description && <p className="mb-hero__desc">{brand.description}</p>}
          {fileCount > 0 && (
            <p className="mb-hero__meta">
              <span>
                <strong>{formatNumber(fileCount)}</strong> {fileCount === 1 ? "arquivo" : "arquivos"}
              </span>
              {formats.length > 0 && <FormatList formats={formats} className="mb-hero__formats" />}
            </p>
          )}
        </div>
        {!nothing && (
          <div className="mb-hero__actions">
            {fileCount > 0 && (
              <ZipButton variant="primary" icon={Package} start={brandKit}>
                Baixar kit completo (ZIP)
              </ZipButton>
            )}
            <Button to="/painel/arquivos" icon={FolderOpen}>
              Ver todos os arquivos
            </Button>
          </div>
        )}
      </header>

      {nothing ? (
        <EmptyState
          icon={Shapes}
          title="Sua identidade visual ainda não foi liberada"
          description="Sua identidade visual aparecerá aqui assim que a Metta liberar os arquivos."
          action={
            <Button to="/painel/projetos" variant="secondary">
              Acompanhar projetos
            </Button>
          }
        />
      ) : (
        <>
          <SectionNav sections={sections} />

          {hasLogos && (
            <section className="mb-sec" id="mb-logos" aria-labelledby={sec["mb-logos"].headingId}>
              {head("mb-logos", {
                title: lib.principal ? "Logo principal e variações" : "Variações do logo",
                description:
                  "Versões claras aparecem sobre fundo escuro; escuras, sobre claro; monocromáticas, sobre transparência. Troque o fundo de qualquer prévia e toque nela para ampliar.",
              })}
              {lib.principal && (
                <PrincipalLogo
                  key={lib.principal.id}
                  material={lib.principal}
                  details={details}
                  onOpen={openLightbox}
                />
              )}
              <LogoGallery
                title={lib.principal ? "Variações" : undefined}
                items={logoGroups.flatMap((group) =>
                  lib.groups[group.key].map((material) => ({ material, eyebrow: group.eyebrow })),
                )}
                details={details}
                onOpen={openLightbox}
              />
            </section>
          )}

          {hasColors && (
            <section className="mb-sec" id="mb-cores" aria-labelledby={sec["mb-cores"].headingId}>
              {head("mb-cores", {
                title: "Cores da marca",
                description: "Toque em uma cor para copiar o HEX. Cada código também pode ser copiado.",
                actions: <PaletteCopy colors={lib.colors} />,
              })}
              <Palette colors={lib.colors} />
              {lib.paletteMaterials.length > 0 && (
                <LogoGallery
                  title="Arquivos da paleta"
                  items={lib.paletteMaterials.map((material) => ({ material }))}
                  details={details}
                  onOpen={openLightbox}
                  switcher={false}
                  padded={false}
                />
              )}
            </section>
          )}

          {hasType && (
            <section className="mb-sec" id="mb-tipografia" aria-labelledby={sec["mb-tipografia"].headingId}>
              {head("mb-tipografia", {
                title: "Famílias tipográficas",
                description: "As famílias tipográficas da marca, seus papéis e como usá-las.",
              })}
              <Typography fonts={lib.fonts} guidelines={brand.typographyGuidelines} />
              {lib.typeMaterials.length > 0 && (
                <LogoGallery
                  title="Materiais de tipografia"
                  items={lib.typeMaterials.map((material) => ({ material }))}
                  details={details}
                  onOpen={openLightbox}
                  switcher={false}
                  padded={false}
                />
              )}
            </section>
          )}

          {hasUsage && (
            <section className="mb-sec" id="mb-orientacoes" aria-labelledby={sec["mb-orientacoes"].headingId}>
              {head("mb-orientacoes", { title: "Orientações de uso" })}
              <div className="mb-guide">
                <RichText text={brand.usageGuidelines} />
              </div>
            </section>
          )}

          {hasManual && (
            <section className="mb-sec" id="mb-manual" aria-labelledby={sec["mb-manual"].headingId}>
              {head("mb-manual", {
                title: "Manual da marca",
                description: "O guia completo de aplicação da identidade visual.",
              })}
              <div className="mb-manuals">
                {lib.manual.map((material, i) => (
                  <ManualCard key={material.id} material={material} details={details} index={i} />
                ))}
              </div>
            </section>
          )}

          {hasElements && (
            <section className="mb-sec" id="mb-elementos" aria-labelledby={sec["mb-elementos"].headingId}>
              {head("mb-elementos", {
                title: "Elementos da identidade",
                description: "Padrões, grafismos e demais peças que completam a identidade visual.",
              })}
              {lib.elements.map((element, i) => (
                <LogoGallery
                  key={element.category?.slug || i}
                  title={lib.elements.length > 1 ? element.category?.name || "Elementos" : undefined}
                  items={element.materials.map((material) => ({ material }))}
                  details={details}
                  onOpen={openLightbox}
                  switcher={false}
                  padded={false}
                />
              ))}
            </section>
          )}

          {hasFiles && (
            <section className="mb-sec" id="mb-arquivos" aria-labelledby={sec["mb-arquivos"].headingId}>
              {head("mb-arquivos", {
                title: "Arquivos da marca",
                description: "Baixe tudo de uma vez ou só o que precisar.",
              })}
              <DownloadsArea
                brand={brand}
                counts={lib.counts}
                editables={editables}
                editablesLoading={editablesLoading}
                editableCount={editableCount}
                kits={lib.kits}
                onBrandKit={brandKit}
              />
            </section>
          )}
        </>
      )}

      <LogoLightbox
        items={visual}
        open={lightbox}
        onClose={() => setLightbox(null)}
        details={details}
      />
    </div>
  );
}
