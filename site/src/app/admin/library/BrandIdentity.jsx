import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { BookOpen, CloudUpload, Download, Eye, FileStack, Image as ImageIcon, Package, Palette, Send, Star, Type } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  SkeletonCards,
  StatusBadge,
  Tabs,
  Thumb,
  formatDate,
  plural,
  useApi,
  useToast,
  variantLabel,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useDownloads } from "../../api/downloads.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import ReleaseDialog from "./ReleaseDialog.jsx";
import { MaterialCard } from "./MaterialCard.jsx";
import { Formats, MaterialBadges, SectionHead, VersionTag } from "./parts.jsx";
import { ColorsSection, FontsSection, GuidelineText, GuidelinesSection, IdentityReleaseDialog, inkOn } from "./identity.jsx";
import { LOGO_VARIANTS } from "./data.js";
import "./library.css";

const TABS = [
  { value: "logos", label: "Logos", icon: ImageIcon },
  { value: "cores", label: "Cores", icon: Palette },
  { value: "tipografia", label: "Tipografia", icon: Type },
  { value: "orientacoes", label: "Orientações", icon: BookOpen },
  { value: "arquivos", label: "Manual e arquivos", icon: FileStack },
  { value: "cliente", label: "Como o cliente vê", icon: Eye },
];

const isReleased = (m) => m.visibility === "released" && !m.archivedAt;
const needsRelease = (m) =>
  !m.archivedAt && (m.visibility !== "released" || (m.currentVersionId && m.releasedVersionId && m.currentVersionId !== m.releasedVersionId));

export default function BrandIdentity() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { startZip } = useDownloads();
  const [params, setParams] = useSearchParams();
  const lib = useApi(`/brands/${id}/library`);
  const data = lib.data;
  const brand = data?.brand ?? null;
  usePageTitle(brand ? `${brand.name} · Identidade` : "Identidade da marca", {
    crumbs: [{ label: "Biblioteca", to: "/admin/biblioteca" }, { label: brand ? `Identidade · ${brand.name}` : "Identidade" }],
  });
  const tab = TABS.some((t) => t.value === params.get("aba")) ? params.get("aba") : "logos";
  const setTab = (value) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "logos") next.delete("aba");
        else next.set("aba", value);
        return next;
      },
      { replace: true },
    );
  const [identityOpen, setIdentityOpen] = useState(false);
  const [releaseIds, setReleaseIds] = useState(null);

  const canEdit = can(["brands.edit", "materials.edit"]);
  const canRelease = can("materials.release");
  const canUpload = can("materials.upload");
  const reload = (opts) => lib.reload().catch((error) => !opts?.silent && toast.error(error.message));

  const allMaterials = useMemo(() => {
    if (!data) return [];
    return [...Object.values(data.logos ?? {}).flat(), ...(data.manual ?? []), ...(data.identity ?? [])];
  }, [data]);
  const toRelease = allMaterials.filter(needsRelease);
  const draftCount =
    (data?.colors ?? []).filter((c) => c.visibility === "draft").length + (data?.fonts ?? []).filter((f) => f.visibility === "draft").length;
  // guideline drafts count as one item until the identity release (D3)
  const waiting = toRelease.length + draftCount + (brand?.hasUnreleasedGuidelines ? 1 : 0);

  if (lib.loading)
    return (
      <div className="lib-page" aria-busy="true">
        <Skeleton width={140} height={12} />
        <Skeleton width="38%" height={38} style={{ marginTop: 14 }} />
        <Skeleton width="100%" height={40} style={{ marginTop: 28 }} />
        <div style={{ marginTop: 24 }}>
          <SkeletonCards count={4} aspect={16 / 10} minWidth={260} label="Carregando identidade" />
        </div>
      </div>
    );
  if (lib.error && !data) return <ErrorState error={lib.error} onRetry={lib.reload} />;
  if (!data || !brand) return null;

  const setPrimary = async (material) => {
    try {
      await api.post(`/materials/${material.id}/primary`);
      toast.success(`“${material.title}” agora é a ${variantLabel(material.variant)?.toLowerCase() || "logo"} principal.`);
      reload();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const logoCount = Object.values(data.logos ?? {}).reduce((n, list) => n + list.length, 0);
  const fontMaterials = (data.identity ?? []).filter((m) => m.category?.slug === "tipografia");

  return (
    <div className="lib-page lib-identity">
      <PageHeader
        back={{ to: `/admin/biblioteca?brandId=${brand.id}`, label: "Biblioteca da marca" }}
        eyebrow={brand.client?.name ?? "Marca"}
        title="Identidade de"
        accent={brand.name}
        description="Logos, cores, tipografia e orientações que o cliente encontra em Minha marca, sempre depois da liberação."
        meta={
          <>
            <span>
              {data.counts?.materials ?? allMaterials.length} materiais · {data.counts?.files ?? 0} arquivos
            </span>
            <Formats formats={data.counts?.formats ?? []} max={6} />
            {waiting > 0 && (
              <StatusBadge kind="visibility" value="draft" label={`${plural(waiting, "item aguardando", "itens aguardando")} liberação`} />
            )}
          </>
        }
        actions={
          <>
            <Button icon={Package} to={`/admin/kits?brandId=${brand.id}&novo=brand_kit`}>
              Montar kit de marca
            </Button>
            {canRelease && (
              <Button variant="primary" icon={Send} onClick={() => setIdentityOpen(true)}>
                Liberar identidade
              </Button>
            )}
          </>
        }
      />

      <Tabs
        aria-label="Seções da identidade"
        value={tab}
        onChange={setTab}
        className="lib-identity__tabs"
        items={TABS.map((t) => ({
          ...t,
          count: t.value === "logos" ? logoCount : t.value === "cores" ? data.colors.length : t.value === "tipografia" ? data.fonts.length : undefined,
        }))}
      >
        <div className="lib-identity__panel ui-page-enter" key={tab}>
          {tab === "logos" && <LogosSection brandId={brand.id} logos={data.logos} canEdit={canEdit} canUpload={canUpload} onPrimary={setPrimary} />}
          {tab === "cores" && <ColorsSection brandId={brand.id} colors={data.colors} canEdit={canEdit} canRelease={canRelease} onChange={reload} />}
          {tab === "tipografia" && (
            <FontsSection brandId={brand.id} fonts={data.fonts} fontMaterials={fontMaterials} canEdit={canEdit} canRelease={canRelease} onChange={reload} />
          )}
          {tab === "orientacoes" && (
            <GuidelinesSection brand={brand} canEdit={canEdit} canRelease={canRelease} onSaved={reload} onRelease={() => setIdentityOpen(true)} />
          )}
          {tab === "arquivos" && (
            <FilesSection
              brand={brand}
              data={data}
              canUpload={canUpload}
              onZip={() => startZip({ type: "brand_kit", brandId: brand.id }, { label: `${brand.name} · Kit de marca` })}
            />
          )}
          {tab === "cliente" && <ClientPreview data={data} />}
        </div>
      </Tabs>

      <IdentityReleaseDialog
        open={identityOpen}
        brand={brand}
        colors={data.colors}
        fonts={data.fonts}
        materialsToRelease={toRelease}
        onClose={() => setIdentityOpen(false)}
        onReleased={() => reload()}
        onReviewMaterials={() => {
          setIdentityOpen(false);
          setReleaseIds(toRelease.map((m) => m.id));
        }}
      />
      <ReleaseDialog open={Boolean(releaseIds)} materialIds={releaseIds ?? []} onClose={() => setReleaseIds(null)} onReleased={() => reload()} />
    </div>
  );
}

// ---------------------------------------------------------------- logos

const BG_CHOICES = [
  { value: "light", label: "Fundo claro" },
  { value: "dark", label: "Fundo escuro" },
  { value: "checker", label: "Fundo transparente" },
];

// Sharper preview rendition for big tiles, falling back to the thumbnail.
function useSharpUrl(thumbUrl, enabled) {
  const candidate = enabled && thumbUrl && /\/preview\/thumb$/.test(thumbUrl) ? thumbUrl.replace(/thumb$/, "preview") : null;
  const [ready, setReady] = useState(null);
  useEffect(() => {
    if (!candidate) return undefined;
    let alive = true;
    const img = new window.Image();
    img.onload = () => alive && setReady(candidate);
    img.onerror = () => alive && setReady(null);
    img.src = candidate;
    return () => {
      alive = false;
    };
  }, [candidate]);
  return ready ?? thumbUrl ?? null;
}

function LogoTile({ material, size, label, canEdit, onPrimary }) {
  const large = Boolean(size);
  const initial = material.previewBg && material.previewBg !== "auto" ? material.previewBg : "checker";
  const [bg, setBg] = useState(initial);
  const src = useSharpUrl(material.thumb?.url, true);
  const to = `/admin/biblioteca/${material.id}`;
  return (
    <article className={`lib-logo ui-enter${size ? ` is-${size}` : ""}`}>
      {label && <p className="lib-logo__variant">{label}</p>}
      <div className="lib-logo__stage">
        <Link to={to} tabIndex={-1} aria-hidden="true" className="lib-logo__art">
          <Thumb src={src ?? undefined} thumb={material.thumb} aspect={size === "large" ? "6/5" : size === "solo" ? "2/1" : "4/3"} bg={bg} fit="contain" alt="" />
        </Link>
        <div className="lib-logo__bgs" role="group" aria-label={`Fundo da prévia de ${material.title}`}>
          {BG_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className={`lib-bgdot is-${choice.value}`}
              aria-pressed={bg === choice.value}
              aria-label={choice.label}
              title={choice.label}
              onClick={() => setBg(choice.value)}
            />
          ))}
        </div>
        {(canEdit || material.isPrimary) && (
          <button
            type="button"
            className={`lib-card__star${material.isPrimary ? " is-on" : ""}`}
            aria-pressed={material.isPrimary}
            aria-label={material.isPrimary ? `${material.title} é a principal desta variante` : `Definir ${material.title} como principal`}
            title={material.isPrimary ? "Principal" : "Definir como principal"}
            disabled={!canEdit || material.isPrimary || Boolean(material.archivedAt)}
            onClick={() => onPrimary(material)}
          >
            <Star size={16} strokeWidth={1.4} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="lib-logo__info">
        <div className="lib-card__row">
          <Link to={to} className="lib-card__title">
            {material.title}
          </Link>
          <VersionTag number={material.version?.number} />
        </div>
        <div className="lib-card__foot">
          <MaterialBadges material={material} />
          <Formats formats={material.formats} max={4} />
        </div>
      </div>
    </article>
  );
}

function LogosSection({ brandId, logos, canEdit, canUpload, onPrimary }) {
  const groups = [...LOGO_VARIANTS, "outros"];
  const principal = logos?.principal ?? [];
  const others = groups
    .filter((variant) => variant !== "principal")
    .flatMap((variant) => (logos?.[variant] ?? []).map((material) => ({ variant, material })));
  const missing = LOGO_VARIANTS.filter((variant) => !logos?.[variant]?.length);
  const total = groups.reduce((n, v) => n + (logos?.[v]?.length ?? 0), 0);
  const uploadTo = (variant) =>
    `/admin/biblioteca/enviar?brandId=${brandId}&category=logotipo${variant && variant !== "outros" ? `&variant=${variant}` : ""}`;
  return (
    <section aria-labelledby="lib-logos-title">
      <SectionHead
        id="lib-logos-title"
        eyebrow="Logotipo"
        title="Logos"
        accent="por variante"
        count={total || null}
        actions={
          canUpload && (
            <Button size="sm" icon={CloudUpload} to={uploadTo()}>
              Enviar logo
            </Button>
          )
        }
      />
      <p className="lib-hint">A estrela marca o arquivo principal de cada variante: é ele que abre Minha marca. Troque o fundo para conferir contraste e transparência.</p>
      <div className="lib-logos">
        {principal.length > 0 && (
          <section className="lib-logos__group is-main" aria-label={variantLabel("principal")}>
            <h3 className="lib-mini-title">
              {variantLabel("principal")}
              <span className="lib-logos__count">{principal.length}</span>
            </h3>
            <div className="lib-logos__row">
              {principal.map((material, i) => (
                <LogoTile
                  key={material.id}
                  material={material}
                  size={i === 0 ? (principal.length > 1 ? "large" : "solo") : null}
                  canEdit={canEdit}
                  onPrimary={onPrimary}
                />
              ))}
            </div>
          </section>
        )}
        {(others.length > 0 || missing.length > 0) && (
          <section className="lib-logos__group" aria-label="Outras variantes">
            <h3 className="lib-mini-title">{principal.length ? "Outras variantes" : "Variantes"}</h3>
            <div className="lib-logos__row">
              {others.map(({ variant, material }) => (
                <LogoTile
                  key={material.id}
                  material={material}
                  label={variant === "outros" ? "Outra versão" : variantLabel(variant)}
                  canEdit={canEdit}
                  onPrimary={onPrimary}
                />
              ))}
              {missing.map((variant, i) =>
                canUpload ? (
                  <Link key={variant} to={uploadTo(variant)} className="lib-logos__empty ui-enter" style={{ "--i": Math.min(i, 8) }}>
                    <CloudUpload size={18} strokeWidth={1.3} aria-hidden="true" />
                    <span>{variantLabel(variant)}</span>
                    <small>Enviar</small>
                  </Link>
                ) : (
                  <span key={variant} className="lib-logos__empty is-static">
                    <span>{variantLabel(variant)}</span>
                    <small>Não enviada</small>
                  </span>
                ),
              )}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- files

function FilesSection({ brand, data, canUpload, onZip }) {
  const sections = (data.sections ?? []).filter((section) => section.category.slug !== "logotipo");
  return (
    <div className="lib-stack-lg">
      <section aria-labelledby="lib-files-title">
        <SectionHead
          id="lib-files-title"
          eyebrow="Manual, elementos e editáveis"
          title="Arquivos"
          accent="de identidade"
          actions={
            <>
              <Button size="sm" variant="ghost" icon={Download} onClick={onZip}>
                Baixar kit de marca (ZIP)
              </Button>
              {canUpload && (
                <Button size="sm" icon={CloudUpload} to={`/admin/biblioteca/enviar?brandId=${brand.id}&category=manual-da-marca`}>
                  Enviar manual
                </Button>
              )}
            </>
          }
        />
        <div className="lib-facts">
          <div>
            <span className="lib-facts__n">{data.editables?.count ?? 0}</span>
            <span className="lib-facts__l">arquivos editáveis</span>
          </div>
          <div>
            <span className="lib-facts__n">{data.counts?.files ?? 0}</span>
            <span className="lib-facts__l">arquivos prontos para uso</span>
          </div>
          <div>
            <span className="lib-facts__n">{(data.counts?.formats ?? []).length}</span>
            <span className="lib-facts__l">formatos: {(data.counts?.formats ?? []).join(", ") || "—"}</span>
          </div>
        </div>
        {!sections.length ? (
          <EmptyState
            icon={BookOpen}
            title="Sem manual ou elementos ainda"
            description="Envie o manual da marca, grafismos e arquivos de tipografia para completar Minha marca."
            action={
              canUpload && (
                <Button variant="primary" icon={CloudUpload} to={`/admin/biblioteca/enviar?brandId=${brand.id}&category=manual-da-marca`}>
                  Enviar manual da marca
                </Button>
              )
            }
          />
        ) : (
          sections.map((section) => (
            <div key={section.category.id} className="lib-files__section">
              <h3 className="lib-mini-title">
                {section.category.name}
                <span className="lib-logos__count">{section.materials.length}</span>
              </h3>
              <div className="lib-grid">
                {section.materials.map((material, i) => (
                  <MaterialCard key={material.id} material={material} index={i} menuItems={[{ label: "Abrir", to: `/admin/biblioteca/${material.id}` }]} />
                ))}
              </div>
            </div>
          ))
        )}
      </section>
      <section aria-labelledby="lib-kits-title">
        <SectionHead
          id="lib-kits-title"
          eyebrow="Entregas organizadas"
          title="Kits"
          accent="e pacotes"
          actions={
            <Button size="sm" icon={Package} to={`/admin/kits?brandId=${brand.id}`}>
              Gerenciar kits
            </Button>
          }
        />
        {data.kits?.length ? (
          <ul className="lib-kitlist">
            {data.kits.map((kit) => (
              <li key={kit.id}>
                <Link to={`/admin/kits?brandId=${brand.id}&kit=${kit.id}`}>{kit.name}</Link>
                <span className="lib-kitlist__meta">
                  <StatusBadge kind="kitKind" value={kit.kind} size="sm" />
                  <StatusBadge kind="kit" value={kit.status} size="sm" />
                  <span>{kit.itemCount === 1 ? "1 item" : `${kit.itemCount ?? 0} itens`}</span>
                  {kit.releasedAt && <span>liberado em {formatDate(kit.releasedAt)}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lib-state__muted">Nenhum kit montado. Use “Montar kit de marca” para reunir logos, manual e arquivos em uma entrega.</p>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- client preview

function ClientPreview({ data }) {
  const brand = data.brand;
  const logos = LOGO_VARIANTS.map((variant) => ({ variant, material: (data.logos?.[variant] ?? []).filter(isReleased)[0] })).filter((x) => x.material);
  const colors = (data.colors ?? []).filter((c) => c.visibility === "released");
  const fonts = (data.fonts ?? []).filter((f) => f.visibility === "released");
  const manual = (data.manual ?? []).filter(isReleased);
  const others = (data.identity ?? []).filter(isReleased);
  const hidden =
    [...Object.values(data.logos ?? {}).flat(), ...(data.manual ?? []), ...(data.identity ?? [])].filter((m) => !isReleased(m)).length +
    (data.colors ?? []).length -
    colors.length +
    (data.fonts ?? []).length -
    fonts.length +
    (brand.hasUnreleasedGuidelines ? 1 : 0);
  const empty =
    !logos.length && !colors.length && !fonts.length && !manual.length && !others.length && !brand.usageGuidelines && !brand.typographyGuidelines;

  return (
    <section className="lib-preview" aria-labelledby="lib-preview-title">
      <p className="lib-preview__note">
        <Eye size={15} strokeWidth={1.4} aria-hidden="true" />
        Prévia somente leitura do que está liberado agora.{" "}
        {hidden > 0 ? `${hidden} ${hidden === 1 ? "item em rascunho não aparece" : "itens em rascunho não aparecem"} para o cliente.` : "Nada em rascunho."}
      </p>
      <div className="lib-preview__frame">
        <header className="lib-preview__head">
          <p className="ui-eyebrow">Minha marca</p>
          <h2 id="lib-preview-title" className="lib-preview__title">
            {brand.name}
          </h2>
        </header>
        {empty ? (
          <EmptyState
            compact
            title="O cliente ainda não vê nada aqui"
            description="Libere logos, cores e tipografias para montar Minha marca."
          />
        ) : (
          <div className="lib-preview__body">
            {logos.length > 0 && (
              <div className="lib-preview__logos">
                {logos.map(({ variant, material }, i) => (
                  <figure key={variant} className={i === 0 ? "is-main" : undefined}>
                    <Thumb thumb={material.thumb} aspect={i === 0 ? "16/9" : "4/3"} bg={material.previewBg && material.previewBg !== "auto" ? material.previewBg : variant === "clara" ? "dark" : "light"} fit="contain" alt={material.title} />
                    <figcaption>
                      {variantLabel(variant)}
                      <Formats formats={material.formats} max={4} />
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
            {colors.length > 0 && (
              <div className="lib-preview__colors">
                {colors.map((color) => (
                  <div key={color.id} className={`lib-preview__color is-${inkOn(color.hex)}`} style={{ background: color.hex }}>
                    <span>{color.name}</span>
                    <strong>{color.hex}</strong>
                  </div>
                ))}
              </div>
            )}
            {fonts.length > 0 && (
              <ul className="lib-preview__fonts">
                {fonts.map((font) => {
                  const downloadable = font.distribution === "allowed" && font.material?.visibility === "released" && font.files?.length;
                  return (
                    <li key={font.id}>
                      <span className="lib-preview__family">{font.family}</span>
                      <span className="lib-preview__fontmeta">
                        {font.role && <span>{font.role}</span>}
                        <span>{downloadable ? "Arquivos para download" : font.sourceUrl ? "Link oficial de aquisição" : "Somente referência"}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {(brand.usageGuidelines || brand.typographyGuidelines) && (
              <div className="lib-preview__guides">
                {brand.usageGuidelines && (
                  <div>
                    <h3 className="lib-mini-title">Uso da marca</h3>
                    <GuidelineText text={brand.usageGuidelines} />
                  </div>
                )}
                {brand.typographyGuidelines && (
                  <div>
                    <h3 className="lib-mini-title">Tipografia</h3>
                    <GuidelineText text={brand.typographyGuidelines} />
                  </div>
                )}
              </div>
            )}
            {manual.length + others.length > 0 && (
              <ul className="lib-preview__files">
                {[...manual, ...others].map((m) => (
                  <li key={m.id}>
                    <span>{m.title}</span>
                    <Formats formats={m.formats} max={3} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
