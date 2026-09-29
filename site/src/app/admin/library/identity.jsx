// Brand identity editors: palette, typography, guidelines and the identity
// release (routes/brandlib.js). Used by BrandIdentity.jsx.
// Everything here starts as a draft for the team; the client sees colours,
// fonts and guidelines only after "Liberar identidade" (materials.release).
// Released items: only release-capable staff change what the client reads.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CloudUpload, ExternalLink, FileType, Lock, Palette, Pencil, Plus, Send, Trash2, Type } from "lucide-react";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Field,
  FileMeta,
  IconButton,
  Input,
  Modal,
  Segmented,
  Select,
  StatusBadge,
  TagInput,
  Textarea,
  formatDate,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { CheckDraw, Handle, Live, MoveButtons, SectionHead } from "./parts.jsx";
import { useDragSort } from "./useDragSort.js";
import "./identity.css";

// Released colour/font the viewer cannot change (designers): says why instead
// of offering an action the server refuses.
function LockedNote({ what, compact = false }) {
  const full = `${what} já liberada ao cliente: só gestores alteram.`;
  return (
    <span className="lib-lock" title={compact ? full : undefined}>
      <Lock size={13} strokeWidth={1.4} aria-hidden="true" />
      {compact ? "Só gestores alteram" : full}
    </span>
  );
}

const HEX = /^#?[0-9a-fA-F]{6}$/;

export function hexToRgb(hex) {
  if (!HEX.test(String(hex ?? "").trim())) return null;
  const n = parseInt(String(hex).trim().replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
// Readable ink over a swatch.
export const inkOn = (hex) => {
  const rgb = hexToRgb(hex);
  return rgb && luminance(rgb) > 0.34 ? "dark" : "light";
};
const normHex = (hex) => `#${String(hex ?? "").trim().replace("#", "").toUpperCase()}`;

// ================================================================ colours

const COLOR_ROLES = ["Primária", "Secundária", "Apoio", "Neutra", "Destaque", "Fundo"];

export function ColorsSection({ brandId, colors, canEdit, canRelease, onChange }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null); // color | {} for new
  const [removing, setRemoving] = useState(null);
  const [list, setList] = useState(colors);
  const seq = useRef(0);
  const key = colors.map((c) => `${c.id}:${c.updatedAt}:${c.sortOrder}:${c.visibility}`).join("|");
  useEffect(() => setList(colors), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(list.map((c) => [c.id, c])), [list]);

  const reorder = async (ids) => {
    const before = list;
    setList(ids.map((id) => byId.get(id)).filter(Boolean));
    const mine = ++seq.current;
    try {
      await api.post(`/brands/${brandId}/colors/reorder`, { ids });
      if (mine === seq.current) onChange?.({ silent: true });
    } catch (error) {
      if (mine === seq.current) {
        setList(before);
        toast.error(error.message);
      }
    }
  };
  const sort = useDragSort({ ids: list.map((c) => c.id), disabled: !canEdit, labelOf: (id) => byId.get(id)?.name ?? "Cor", onReorder: reorder });
  const ordered = sort.order.map((id) => byId.get(id)).filter(Boolean);

  return (
    <section aria-labelledby="lib-colors-title">
      <SectionHead
        id="lib-colors-title"
        eyebrow="Paleta de cores"
        title="Cores"
        accent="da marca"
        count={list.length || null}
        actions={
          canEdit && (
            <Button size="sm" icon={Plus} onClick={() => setEditing({})}>
              Adicionar cor
            </Button>
          )
        }
      />
      {!list.length ? (
        <EmptyState
          icon={Palette}
          title="Nenhuma cor na paleta ainda"
          description="Cadastre as cores com HEX, RGB, CMYK e Pantone. O cliente copia os códigos em Minha marca depois da liberação."
          action={
            canEdit && (
              <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
                Adicionar a primeira cor
              </Button>
            )
          }
        />
      ) : (
        <ul className="lib-swatches" aria-label="Cores da paleta">
          {ordered.map((color, index) => (
            <li key={color.id} className="lib-swatch ui-enter" style={{ "--i": Math.min(index, 8) }} {...sort.itemProps(color.id)}>
              <div className={`lib-swatch__chip is-${inkOn(color.hex)}`} style={{ background: color.hex }}>
                <span className="lib-swatch__hex">{color.hex}</span>
                {color.role && <span className="lib-swatch__role">{color.role}</span>}
              </div>
              <div className="lib-swatch__body">
                <div className="lib-swatch__head">
                  <strong>{color.name}</strong>
                  <StatusBadge kind="identity" value={color.visibility} size="sm" />
                </div>
                <dl className="lib-swatch__codes">
                  {[
                    ["HEX", color.hex],
                    ["RGB", color.rgb],
                    ["CMYK", color.cmyk],
                    ["Pantone", color.pantone],
                  ]
                    .filter(([, value]) => value)
                    .map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          <span>{value}</span>
                          <CopyButton text={value} iconOnly label={`Copiar ${label} de ${color.name}`} copiedLabel={`${label} copiado`} />
                        </dd>
                      </div>
                    ))}
                </dl>
                {color.usage && <p className="lib-swatch__usage">{color.usage}</p>}
                {canEdit && (
                  <div className="lib-swatch__actions">
                    <Handle {...sort.handleProps(color.id)} />
                    <MoveButtons axis="x" index={index} count={ordered.length} label={color.name} onMove={(delta) => sort.move(color.id, delta)} />
                    {color.visibility === "released" && !canRelease ? (
                      <LockedNote what="Cor" compact />
                    ) : (
                      <>
                        <IconButton size="sm" variant="ghost" icon={Pencil} label={`Editar ${color.name}`} onClick={() => setEditing(color)} />
                        <IconButton size="sm" variant="ghost" icon={Trash2} label={`Remover ${color.name}`} onClick={() => setRemoving(color)} />
                      </>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Live text={sort.announcement} />
      <ColorDialog
        open={Boolean(editing)}
        color={editing?.id ? editing : null}
        brandId={brandId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          onChange?.();
        }}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        tone="danger"
        title={`Remover a cor “${removing?.name ?? ""}”?`}
        description={
          removing?.visibility === "released"
            ? "Ela já está visível ao cliente e deixa de aparecer em Minha marca. A remoção fica registrada no histórico."
            : "Ela ainda é um rascunho e só a equipe a vê."
        }
        confirmLabel="Remover cor"
        icon={Trash2}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          await api.del(`/colors/${removing.id}`);
          toast.success("Cor removida da paleta.");
          onChange?.();
        }}
      />
    </section>
  );
}

function emptyColor() {
  return { name: "", hex: "#", rgb: "", cmyk: "", pantone: "", role: "", usage: "" };
}

function ColorDialog({ open, color, brandId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(emptyColor);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      color
        ? { name: color.name ?? "", hex: color.hex ?? "#", rgb: color.rgb ?? "", cmyk: color.cmyk ?? "", pantone: color.pantone ?? "", role: color.role ?? "", usage: color.usage ?? "" }
        : emptyColor(),
    );
  }, [open, color]);
  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      return next;
    });
  };
  const validHex = HEX.test(form.hex.trim());
  const rgb = hexToRgb(form.hex);

  const save = async (event) => {
    event.preventDefault();
    const e = {};
    if (!form.name.trim()) e.name = "Dê um nome à cor.";
    if (!validHex) e.hex = "Use o formato #RRGGBB, por exemplo #202619.";
    if (Object.keys(e).length) {
      setErrors(e);
      return;
    }
    setSaving(true);
    const body = {
      name: form.name.trim(),
      hex: normHex(form.hex),
      rgb: form.rgb.trim() || null,
      cmyk: form.cmyk.trim() || null,
      pantone: form.pantone.trim() || null,
      role: form.role.trim() || null,
      usage: form.usage.trim() || null,
    };
    try {
      if (color) await api.patch(`/colors/${color.id}`, body);
      else await api.post(`/brands/${brandId}/colors`, body);
      toast.success(color ? "Cor atualizada." : "Cor adicionada à paleta como rascunho.");
      onSaved?.();
    } catch (error) {
      if (error.code === "validation" && error.fields) setErrors(error.fields);
      else toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      size="md"
      eyebrow="Paleta de cores"
      title={color ? `Editar ${color.name}` : "Nova cor"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="lib-color-form" loading={saving}>
            {color ? "Salvar cor" : "Adicionar cor"}
          </Button>
        </>
      }
    >
      <form id="lib-color-form" className="lib-form lib-colorform" onSubmit={save} noValidate>
        <div className="lib-colorform__top">
          <label className={`lib-colorform__chip is-${validHex ? inkOn(form.hex) : "dark"}`} style={{ background: validHex ? normHex(form.hex) : undefined }}>
            <input
              type="color"
              value={validHex ? normHex(form.hex).toLowerCase() : "#000000"}
              onChange={(event) => set({ hex: event.target.value.toUpperCase() })}
              aria-label="Escolher a cor no seletor"
            />
            <span>{validHex ? normHex(form.hex) : "Escolher"}</span>
          </label>
          <div className="lib-colorform__main">
            <Field label="Nome" required error={errors.name}>
              <Input value={form.name} maxLength={80} placeholder="Ex.: Oliva profundo" onValueChange={(name) => set({ name })} data-autofocus />
            </Field>
            <Field label="HEX" required error={errors.hex} hint="#RRGGBB">
              <Input
                value={form.hex}
                maxLength={7}
                spellCheck={false}
                autoCapitalize="characters"
                onValueChange={(hex) => set({ hex: hex.startsWith("#") ? hex.toUpperCase() : `#${hex.toUpperCase()}` })}
              />
            </Field>
          </div>
        </div>
        <div className="lib-form__two">
          <Field
            label="RGB"
            optional
            error={errors.rgb}
            labelAside={
              rgb && (
                <button type="button" className="lib-linkbtn" onClick={() => set({ rgb: rgb.join(", ") })}>
                  Calcular do HEX
                </button>
              )
            }
          >
            <Input value={form.rgb} maxLength={60} placeholder="32, 38, 25" onValueChange={(v) => set({ rgb: v })} />
          </Field>
          <Field label="CMYK" optional error={errors.cmyk} hint="Informe o valor do manual; não é calculado.">
            <Input value={form.cmyk} maxLength={60} placeholder="16, 0, 34, 85" onValueChange={(v) => set({ cmyk: v })} />
          </Field>
        </div>
        <div className="lib-form__two">
          <Field label="Pantone" optional error={errors.pantone}>
            <Input value={form.pantone} maxLength={60} placeholder="Pantone 5463 C" onValueChange={(v) => set({ pantone: v })} />
          </Field>
          <Field label="Papel na paleta" optional error={errors.role}>
            <Input value={form.role} maxLength={60} list="lib-color-roles" placeholder="Primária, apoio…" onValueChange={(v) => set({ role: v })} />
            <datalist id="lib-color-roles">
              {COLOR_ROLES.map((role) => (
                <option key={role} value={role} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="Como usar" optional error={errors.usage}>
          <Textarea rows={3} autoGrow maxLength={1000} value={form.usage} placeholder="Ex.: fundos institucionais e títulos." onValueChange={(v) => set({ usage: v })} />
        </Field>
        {color?.visibility === "released" && (
          <p className="lib-form__note">Esta cor já está liberada: o cliente vê as alterações em Minha marca assim que você salvar.</p>
        )}
      </form>
    </Modal>
  );
}

// ================================================================ fonts

export function FontsSection({ brandId, fonts, fontMaterials, canEdit, canRelease, onChange }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [pending, setPending] = useState(null);

  const setDistribution = async (font, distribution) => {
    setPending(font.id);
    try {
      await api.patch(`/fonts/${font.id}`, { distribution });
      toast.success(distribution === "allowed" ? `“${font.family}”: distribuição permitida.` : `“${font.family}”: somente referência.`);
      onChange?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby="lib-fonts-title">
      <SectionHead
        id="lib-fonts-title"
        eyebrow="Tipografia"
        title="Famílias"
        accent="tipográficas"
        count={fonts.length || null}
        actions={
          canEdit && (
            <Button size="sm" icon={Plus} onClick={() => setEditing({})}>
              Adicionar tipografia
            </Button>
          )
        }
      />
      {!fonts.length ? (
        <EmptyState
          icon={Type}
          title="Nenhuma tipografia cadastrada"
          description="Registre família, pesos e uso. Arquivos de fonte só vão para o cliente quando a licença permitir; senão, ele recebe o link oficial."
          action={
            canEdit && (
              <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
                Adicionar tipografia
              </Button>
            )
          }
        />
      ) : (
        <ul className="lib-fonts">
          {fonts.map((font, index) => {
            const weights = String(font.weights ?? "")
              .split(",")
              .map((w) => w.trim())
              .filter(Boolean);
            const locked = font.visibility === "released" && !canRelease;
            return (
              <li key={font.id} className="lib-font ui-enter" style={{ "--i": Math.min(index, 8) }}>
                <div className="lib-font__head">
                  <div>
                    <p className="lib-font__role">{font.role || "Tipografia"}</p>
                    <h3 className="lib-font__family">{font.family}</h3>
                  </div>
                  <div className="lib-font__badges">
                    <StatusBadge kind="identity" value={font.visibility} size="sm" />
                    <StatusBadge kind="fontDistribution" value={font.distribution} size="sm" />
                  </div>
                </div>
                {weights.length > 0 && (
                  <p className="lib-font__weights">
                    {weights.map((w) => (
                      <span key={w}>{w}</span>
                    ))}
                  </p>
                )}
                {font.usage && <p className="lib-font__usage">{font.usage}</p>}
                <div className="lib-font__dist">
                  <Segmented
                    aria-label={`Distribuição de ${font.family}`}
                    size="sm"
                    value={font.distribution}
                    onChange={(value) => value !== font.distribution && canEdit && !locked && setDistribution(font, value)}
                    options={[
                      { value: "allowed", label: "Distribuição permitida", disabled: !canEdit || locked || pending === font.id },
                      { value: "reference_only", label: "Somente referência", disabled: !canEdit || locked || pending === font.id },
                    ]}
                  />
                  <p className="lib-font__dist-note">
                    {font.distribution === "allowed"
                      ? font.files?.length
                        ? "O cliente pode baixar os arquivos anexados."
                        : "Anexe os arquivos da fonte para o cliente baixar."
                      : font.sourceUrl
                        ? "O cliente vê apenas o link oficial de aquisição."
                        : "Informe o link oficial: sem ele, o cliente não tem como obter a fonte."}
                  </p>
                </div>
                {font.sourceUrl && (
                  <a className="lib-font__link" href={font.sourceUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink size={14} strokeWidth={1.4} aria-hidden="true" />
                    Link oficial
                  </a>
                )}
                {font.license && (
                  <details className="lib-font__license">
                    <summary>Licença</summary>
                    <p>{font.license}</p>
                  </details>
                )}
                <div className="lib-font__files">
                  <p className="lib-mini-title">
                    <FileType size={13} strokeWidth={1.4} aria-hidden="true" />
                    Arquivos {font.material ? <Link to={`/admin/biblioteca/${font.material.id}`}>· {font.material.title}</Link> : null}
                  </p>
                  {font.files?.length ? (
                    <ul>
                      {font.files.map((file) => (
                        <li key={file.id}>
                          <FileMeta file={file} layout="inline" />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="lib-font__nofiles">
                      Nenhum arquivo anexado.{" "}
                      {canEdit && (
                        <Link to={`/admin/biblioteca/enviar?brandId=${brandId}&category=tipografia`}>Enviar arquivos da fonte</Link>
                      )}
                    </p>
                  )}
                </div>
                {canEdit && (
                  <div className="lib-font__actions">
                    {locked ? (
                      <LockedNote what="Tipografia" />
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(font)}>
                          Editar
                        </Button>
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setRemoving(font)}>
                          Remover
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <FontDialog
        open={Boolean(editing)}
        font={editing?.id ? editing : null}
        brandId={brandId}
        fontMaterials={fontMaterials}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          onChange?.();
        }}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        tone="danger"
        title={`Remover “${removing?.family ?? ""}”?`}
        description="Os arquivos anexados continuam na biblioteca; só a ficha da tipografia é removida."
        confirmLabel="Remover tipografia"
        icon={Trash2}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          await api.del(`/fonts/${removing.id}`);
          toast.success("Tipografia removida.");
          onChange?.();
        }}
      />
    </section>
  );
}

function FontDialog({ open, font, brandId, fontMaterials, onClose, onSaved }) {
  const toast = useToast();
  const blank = { family: "", role: "", weights: [], usage: "", sourceUrl: "", license: "", distribution: "reference_only", materialId: "" };
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      font
        ? {
            family: font.family ?? "",
            role: font.role ?? "",
            weights: String(font.weights ?? "")
              .split(",")
              .map((w) => w.trim())
              .filter(Boolean),
            usage: font.usage ?? "",
            sourceUrl: font.sourceUrl ?? "",
            license: font.license ?? "",
            distribution: font.distribution ?? "reference_only",
            materialId: font.materialId ?? "",
          }
        : blank,
    );
  }, [open, font]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      return next;
    });
  };

  const save = async (event) => {
    event.preventDefault();
    const e = {};
    if (!form.family.trim()) e.family = "Informe a família tipográfica.";
    if (form.sourceUrl.trim() && !/^https?:\/\/\S+\.\S+/.test(form.sourceUrl.trim())) e.sourceUrl = "Informe um link válido, começando com https://.";
    if (Object.keys(e).length) {
      setErrors(e);
      return;
    }
    setSaving(true);
    const body = {
      family: form.family.trim(),
      role: form.role.trim() || null,
      weights: form.weights,
      usage: form.usage.trim() || null,
      sourceUrl: form.sourceUrl.trim() || null,
      license: form.license.trim() || null,
      distribution: form.distribution,
      materialId: form.materialId || null,
    };
    try {
      if (font) await api.patch(`/fonts/${font.id}`, body);
      else await api.post(`/brands/${brandId}/fonts`, body);
      toast.success(font ? "Tipografia atualizada." : "Tipografia adicionada como rascunho.");
      onSaved?.();
    } catch (error) {
      if (error.code === "validation" && error.fields) setErrors(error.fields);
      else toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const options = fontMaterials.map((m) => ({ value: m.id, label: m.title }));
  if (form.materialId && !options.some((o) => o.value === form.materialId) && font?.material)
    options.push({ value: font.material.id, label: font.material.title });

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      size="md"
      eyebrow="Tipografia"
      title={font ? `Editar ${font.family}` : "Nova tipografia"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="lib-font-form" loading={saving}>
            {font ? "Salvar" : "Adicionar"}
          </Button>
        </>
      }
    >
      <form id="lib-font-form" className="lib-form" onSubmit={save} noValidate>
        <div className="lib-form__two">
          <Field label="Família" required error={errors.family}>
            <Input value={form.family} maxLength={120} placeholder="Ex.: Manrope" onValueChange={(family) => set({ family })} data-autofocus />
          </Field>
          <Field label="Papel" optional error={errors.role}>
            <Input value={form.role} maxLength={80} placeholder="Títulos, textos…" onValueChange={(role) => set({ role })} />
          </Field>
        </div>
        <Field label="Pesos" optional hint="Ex.: Light 300, Regular 400. Enter para adicionar." error={errors.weights}>
          <TagInput value={form.weights} max={20} placeholder="Adicionar peso" onChange={(weights) => set({ weights })} />
        </Field>
        <Field label="Como usar" optional error={errors.usage}>
          <Textarea rows={2} autoGrow maxLength={1000} value={form.usage} onValueChange={(usage) => set({ usage })} />
        </Field>
        <Field label="Distribuição">
          <Segmented
            aria-label="Distribuição"
            value={form.distribution}
            onChange={(distribution) => set({ distribution })}
            options={[
              { value: "reference_only", label: "Somente referência" },
              { value: "allowed", label: "Distribuição permitida" },
            ]}
          />
        </Field>
        <p className="lib-form__note">
          {form.distribution === "allowed"
            ? "Confirme na licença que os arquivos podem ser repassados ao cliente."
            : "O cliente vê o nome, o uso e o link oficial de aquisição; os arquivos ficam com a equipe."}
        </p>
        <Field label="Link oficial" optional error={errors.sourceUrl} hint="Onde o cliente obtém ou licencia a fonte.">
          <Input type="url" value={form.sourceUrl} maxLength={2000} placeholder="https://" onValueChange={(sourceUrl) => set({ sourceUrl })} />
        </Field>
        <Field label="Licença" optional error={errors.license}>
          <Textarea rows={2} autoGrow maxLength={4000} value={form.license} placeholder="Ex.: SIL Open Font License 1.1" onValueChange={(license) => set({ license })} />
        </Field>
        <Field
          label="Arquivos da fonte"
          optional
          error={errors.materialId}
          hint={fontMaterials.length ? "Material da categoria Tipografia com os arquivos .ttf/.otf/.woff." : "Envie os arquivos na categoria Tipografia para vinculá-los aqui."}
        >
          <Select placeholder="Sem arquivos vinculados" value={form.materialId} options={options} onValueChange={(materialId) => set({ materialId })} />
        </Field>
        <Link className="lib-form__link" to={`/admin/biblioteca/enviar?brandId=${brandId}&category=tipografia`}>
          <CloudUpload size={14} strokeWidth={1.4} aria-hidden="true" /> Enviar arquivos de fonte
        </Link>
        {font?.visibility === "released" && (
          <p className="lib-form__note">
            Esta tipografia já está liberada: nome, link oficial, licença e arquivos mudam para o cliente assim que você salvar.
          </p>
        )}
      </form>
    </Modal>
  );
}

// ================================================================ guidelines

// Minimal rich text: blank line = paragraph, "- " = bullet, "## " = heading.
export function GuidelineText({ text, empty = "Nada escrito ainda." }) {
  const blocks = useMemo(() => {
    const out = [];
    let list = null;
    for (const raw of String(text ?? "").split(/\n/)) {
      const line = raw.trimEnd();
      if (/^\s*[-•]\s+/.test(line)) {
        if (!list) out.push((list = { type: "ul", items: [] }));
        list.items.push(line.replace(/^\s*[-•]\s+/, ""));
        continue;
      }
      list = null;
      if (!line.trim()) out.push({ type: "gap" });
      else if (/^#{1,3}\s+/.test(line)) out.push({ type: "h", text: line.replace(/^#{1,3}\s+/, "") });
      else {
        const last = out[out.length - 1];
        if (last?.type === "p") last.text += `\n${line}`;
        else out.push({ type: "p", text: line });
      }
    }
    return out.filter((b) => b.type !== "gap");
  }, [text]);
  if (!blocks.length) return <p className="lib-guide__empty">{empty}</p>;
  return (
    <div className="lib-guide__text">
      {blocks.map((block, i) =>
        block.type === "ul" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : block.type === "h" ? (
          <h4 key={i}>{block.text}</h4>
        ) : (
          <p key={i}>{block.text}</p>
        ),
      )}
    </div>
  );
}

function GuideEditor({ label, description, value, onChange, disabled, changed }) {
  const [mode, setMode] = useState("edit");
  return (
    <div className="lib-guide">
      <div className="lib-guide__head">
        <div>
          <h3 className="lib-guide__title">
            {label}
            {changed && <StatusBadge kind="identity" value="draft" label="Alterado" size="sm" className="lib-guide__changed" />}
          </h3>
          <p className="lib-guide__desc">{description}</p>
        </div>
        <Segmented
          aria-label={`Modo de ${label}`}
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "edit", label: "Editar", disabled },
            { value: "preview", label: "Prévia" },
          ]}
        />
      </div>
      {mode === "edit" && !disabled ? (
        <Textarea
          rows={8}
          autoGrow
          maxRows={24}
          maxLength={20000}
          value={value}
          aria-label={label}
          placeholder={"Parágrafos separados por linha em branco.\n- Itens de lista começam com hífen\n## Subtítulos com ##"}
          onValueChange={onChange}
        />
      ) : (
        <div className="lib-guide__preview">
          <GuidelineText text={value} />
        </div>
      )}
    </div>
  );
}

// Working text (draft or, without one, the released text) and what differs
// from the released text the client reads.
export function guidelineState(brand) {
  const usage = brand?.usageGuidelinesDraft ?? brand?.usageGuidelines ?? "";
  const typography = brand?.typographyGuidelinesDraft ?? brand?.typographyGuidelines ?? "";
  const changed = {
    usage: usage !== (brand?.usageGuidelines ?? ""),
    typography: typography !== (brand?.typographyGuidelines ?? ""),
  };
  return { usage, typography, changed, pending: Boolean(brand?.hasUnreleasedGuidelines) };
}

// Guidelines are saved as a team draft (designers included) and reach the
// client only through the identity release, like colours and fonts (D3).
export function GuidelinesSection({ brand, canEdit, canRelease, onSaved, onRelease }) {
  const toast = useToast();
  const state = guidelineState(brand);
  const [usage, setUsage] = useState(state.usage);
  const [typography, setTypography] = useState(state.typography);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = usage !== state.usage || typography !== state.typography;
  useEffect(() => {
    if (!dirty) {
      setUsage(state.usage);
      setTypography(state.typography);
    }
  }, [state.usage, state.typography]); // eslint-disable-line react-hooks/exhaustive-deps

  const released = { usage: brand.usageGuidelines ?? "", typography: brand.typographyGuidelines ?? "" };
  const pending = !dirty && state.pending;
  const hasReleased = Boolean(released.usage || released.typography);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.patch(`/brands/${brand.id}/guidelines`, { usageGuidelines: usage, typographyGuidelines: typography });
      setSaved(true);
      toast.success(
        res?.brand?.hasUnreleasedGuidelines
          ? "Rascunho salvo. O cliente vê o texto depois da liberação."
          : "Orientações iguais às liberadas: nada a liberar.",
      );
      setTimeout(() => setSaved(false), 2200);
      onSaved?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  let status = null;
  if (state.pending) status = <StatusBadge kind="identity" value="draft" label="Rascunho não liberado" />;
  else if (hasReleased) status = <StatusBadge kind="identity" value="released" label="Liberado" />;

  return (
    <section aria-labelledby="lib-guides-title">
      <SectionHead id="lib-guides-title" eyebrow="Orientações" title="Como usar" accent="a marca" actions={status} />
      <p className="lib-guide__notice">
        {state.pending
          ? "Há alterações salvas como rascunho, visíveis só para a equipe. O cliente continua vendo a versão liberada até “Liberar identidade”."
          : "O texto salvo fica como rascunho, visível só para a equipe. O cliente vê as orientações em Minha marca depois de “Liberar identidade”."}
        {brand.guidelinesReleasedAt ? ` Última liberação em ${formatDate(brand.guidelinesReleasedAt)}.` : ""}
      </p>
      <div className="lib-guides">
        <GuideEditor
          label="Uso da marca"
          description="Área de proteção, tamanhos mínimos, aplicações permitidas e proibidas."
          value={usage}
          onChange={setUsage}
          disabled={!canEdit}
          changed={usage !== released.usage}
        />
        <GuideEditor
          label="Tipografia"
          description="Hierarquia, combinações e cuidados com as fontes."
          value={typography}
          onChange={setTypography}
          disabled={!canEdit}
          changed={typography !== released.typography}
        />
      </div>
      {canEdit && (
        <div className="lib-form__foot">
          {saved && !dirty ? (
            <span className="lib-saved" role="status">
              <CheckDraw size={20} /> Rascunho salvo
            </span>
          ) : dirty ? (
            <span className="lib-form__dirty">Alterações não salvas</span>
          ) : pending && !canRelease ? (
            <span className="lib-lock">
              <Lock size={13} strokeWidth={1.4} aria-hidden="true" />
              Um gestor revisa e libera as orientações para o cliente.
            </span>
          ) : (
            <span />
          )}
          <div className="lib-form__buttons">
            <Button variant={pending && canRelease ? "secondary" : "primary"} loading={saving} disabled={!dirty} onClick={save}>
              Salvar rascunho
            </Button>
            {pending && canRelease && (
              <Button variant="primary" icon={Send} onClick={onRelease}>
                Revisar e liberar
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ================================================================ release

export function IdentityReleaseDialog({ open, brand, colors, fonts, materialsToRelease, onClose, onReleased, onReviewMaterials }) {
  const toast = useToast();
  const draftColors = colors.filter((c) => c.visibility === "draft");
  const draftFonts = fonts.filter((f) => f.visibility === "draft");
  const guide = guidelineState(brand);
  const guideParts = [guide.changed.usage && "Uso da marca", guide.changed.typography && "Tipografia"].filter(Boolean);
  const [colorIds, setColorIds] = useState(new Set());
  const [fontIds, setFontIds] = useState(new Set());
  const [guidelines, setGuidelines] = useState(false);
  const [notifyApp, setNotifyApp] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setColorIds(new Set(draftColors.map((c) => c.id)));
    setFontIds(new Set(draftFonts.map((f) => f.id)));
    setGuidelines(guide.pending);
    setMessage("");
    setDone(null);
    setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (setter) => (id, on) =>
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const nothing = !colorIds.size && !fontIds.size && !guidelines;

  const confirm = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.post(`/brands/${brand.id}/identity/release`, {
        colorIds: [...colorIds],
        fontIds: [...fontIds],
        guidelines,
        notify: notifyApp,
        notifyEmail,
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      setDone(res);
      toast.success(`Identidade de ${brand.name} liberada ao cliente.`);
      onReleased?.(res);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      size="md"
      eyebrow="Liberar identidade"
      title={done ? "Identidade liberada" : `O que ${brand?.client?.name ?? "o cliente"} passa a ver`}
      description={done ? null : "Cores, tipografias e orientações começam como rascunho. Escolha o que entra em Minha marca agora."}
      className="lib-idrelease"
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button variant="primary" icon={Send} loading={saving} disabled={nothing} onClick={confirm}>
              Liberar
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="lib-release__done" role="status">
          <CheckDraw size={64} />
          <p className="lib-release__done-text">
            {[
              done.released?.colors ? `${done.released.colors} ${done.released.colors === 1 ? "cor" : "cores"}` : null,
              done.released?.fonts ? `${done.released.fonts} ${done.released.fonts === 1 ? "tipografia" : "tipografias"}` : null,
              done.released?.guidelines ? "orientações" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            {done.recipients ? ` · ${done.recipients === 1 ? "1 pessoa avisada" : `${done.recipients} pessoas avisadas`}` : ""}
          </p>
        </div>
      ) : (
        <div className="lib-idrelease__body">
          <fieldset className="lib-idrelease__group">
            <legend className="lib-mini-title">Cores em rascunho</legend>
            {draftColors.length ? (
              draftColors.map((color) => (
                <Checkbox
                  key={color.id}
                  checked={colorIds.has(color.id)}
                  onCheckedChange={(on) => toggle(setColorIds)(color.id, on)}
                  label={
                    <span className="lib-idrelease__color">
                      <span className="lib-idrelease__dot" style={{ background: color.hex }} aria-hidden="true" />
                      {color.name} <small>{color.hex}</small>
                    </span>
                  }
                />
              ))
            ) : (
              <p className="lib-state__muted">Nenhuma cor nova.</p>
            )}
          </fieldset>
          <fieldset className="lib-idrelease__group">
            <legend className="lib-mini-title">Tipografias em rascunho</legend>
            {draftFonts.length ? (
              draftFonts.map((font) => (
                <Checkbox
                  key={font.id}
                  checked={fontIds.has(font.id)}
                  onCheckedChange={(on) => toggle(setFontIds)(font.id, on)}
                  label={font.family}
                  description={font.distribution === "allowed" ? "Com arquivos para download" : "Somente referência e link oficial"}
                />
              ))
            ) : (
              <p className="lib-state__muted">Nenhuma tipografia nova.</p>
            )}
          </fieldset>
          <fieldset className="lib-idrelease__group">
            <legend className="lib-mini-title">Orientações alteradas</legend>
            {guide.pending ? (
              <div className="lib-idrelease__guide">
                <Checkbox
                  checked={guidelines}
                  onCheckedChange={setGuidelines}
                  label={guideParts.join(" e ") || "Orientações"}
                  description="O cliente passa a ver o texto revisado em Minha marca."
                />
                <details className="lib-idrelease__peek">
                  <summary>Conferir o texto que será liberado</summary>
                  <div className="lib-idrelease__peek-body">
                    {guide.changed.usage && (
                      <div>
                        <p className="lib-mini-title">Uso da marca</p>
                        <GuidelineText text={guide.usage} empty="Sem texto: a seção deixa de aparecer para o cliente." />
                      </div>
                    )}
                    {guide.changed.typography && (
                      <div>
                        <p className="lib-mini-title">Tipografia</p>
                        <GuidelineText text={guide.typography} empty="Sem texto: a seção deixa de aparecer para o cliente." />
                      </div>
                    )}
                  </div>
                </details>
              </div>
            ) : (
              <p className="lib-state__muted">Nenhuma alteração nas orientações.</p>
            )}
          </fieldset>
          {materialsToRelease.length > 0 && (
            <div className="lib-idrelease__materials">
              <p>
                {materialsToRelease.length === 1 ? "1 logo ou arquivo de identidade" : `${materialsToRelease.length} logos e arquivos de identidade`} ainda não
                liberados. Eles passam pelo resumo de liberação.
              </p>
              <Button size="sm" onClick={onReviewMaterials}>
                Revisar e liberar arquivos
              </Button>
            </div>
          )}
          <div className="lib-release__checks">
            <Checkbox label="Avisar na plataforma" checked={notifyApp} onCheckedChange={setNotifyApp} />
            <Checkbox label="Enviar e-mail" checked={notifyEmail} onCheckedChange={setNotifyEmail} />
          </div>
          <Field label="Mensagem" optional>
            <Textarea rows={2} autoGrow maxLength={1000} value={message} onValueChange={setMessage} />
          </Field>
          {error && (
            <p className="lib-release__error" role="alert">
              {error.message}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

