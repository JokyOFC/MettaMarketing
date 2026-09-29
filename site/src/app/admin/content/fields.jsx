import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button, DateInput, Field, Input, Select, Textarea, formatNumber, useToast } from "../../ui/index.js";
import { api } from "../../api/client.js";
import { cx } from "../../shared/review/util.js";

// Caption limits of each network (characters).
export const CAPTION_LIMITS = {
  instagram: 2200,
  tiktok: 2200,
  x: 280,
  linkedin: 3000,
  facebook: 63206,
  youtube: 5000,
  pinterest: 500,
  whatsapp: 700,
};

export const NETWORK_OPTIONS = [
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["linkedin", "LinkedIn"],
  ["tiktok", "TikTok"],
  ["youtube", "YouTube"],
  ["x", "X"],
  ["pinterest", "Pinterest"],
  ["whatsapp", "WhatsApp"],
  ["outro", "Outra rede"],
].map(([value, label]) => ({ value, label }));

export const FORMAT_OPTIONS = [
  ["estatico", "Estático"],
  ["carrossel", "Carrossel"],
  ["stories", "Stories"],
  ["reels", "Reels"],
  ["video", "Vídeo"],
  ["outro", "Outro"],
].map(([value, label]) => ({ value, label }));

// Brands grouped by client in a native select.
export function BrandSelect({ brands = [], value, onValueChange, ...rest }) {
  const groups = [];
  for (const brand of brands) {
    let group = groups.find((g) => g.clientId === brand.clientId);
    if (!group) groups.push((group = { clientId: brand.clientId, name: brand.clientName, brands: [] }));
    group.brands.push(brand);
  }
  return (
    <Select value={value} onValueChange={onValueChange} placeholder="Escolha a marca" {...rest}>
      {groups.map((group) => (
        <optgroup key={group.clientId} label={group.name}>
          {group.brands.map((brand) => (
            <option key={brand.id} value={brand.id}>
              {brand.name === group.name ? brand.name : `${brand.name}`}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

// Where the caption stands against the network's limit: under 90 %, close
// (90 % or more) or over the limit.
const captionLevel = (length, limit) => (!limit ? "ok" : length > limit ? "over" : length >= limit * 0.9 ? "near" : "ok");

// Screen readers hear the caption length only when it crosses a threshold
// (90 % of the network's limit, over the limit, back under the limit), after a short
// pause in typing — never on every keystroke. The visible counter is linked
// to the field with aria-describedby instead of being a live region.
function useThresholdAnnouncement(length, limit) {
  const level = captionLevel(length, limit);
  const [message, setMessage] = useState("");
  const previous = useRef(level);
  useEffect(() => {
    if (level === previous.current) return undefined;
    const timer = setTimeout(() => {
      const from = previous.current;
      previous.current = level;
      if (level === "over")
        setMessage(`A legenda passou do limite de ${formatNumber(limit)} caracteres desta rede.`);
      else if (level === "near")
        setMessage(`A legenda está perto do limite: ${formatNumber(length)} de ${formatNumber(limit)} caracteres.`);
      else if (from === "over") setMessage("A legenda voltou para dentro do limite.");
      else setMessage("");
    }, 700);
    return () => clearTimeout(timer);
  }, [level, length, limit]);
  useEffect(() => {
    // a new network changes the limit: start from its current level quietly
    previous.current = captionLevel(length, limit);
    setMessage("");
  }, [limit]); // eslint-disable-line react-hooks/exhaustive-deps
  return message;
}

export function CaptionField({ value, onChange, network, error, disabled, hint }) {
  const limit = CAPTION_LIMITS[network];
  const length = value?.length ?? 0;
  const over = limit && length > limit;
  const counterId = `cnt-counter-${useId().replace(/:/g, "")}`;
  const announcement = useThresholdAnnouncement(length, limit);
  return (
    <Field
      label="Legenda"
      optional
      error={error || (over ? `A legenda passa do limite de ${formatNumber(limit)} caracteres desta rede.` : undefined)}
      hint={hint}
      labelAside={
        <>
          <span id={counterId} className={cx("cnt-counter", over && "is-over")}>
            {formatNumber(length)}
            {limit ? ` / ${formatNumber(limit)}` : ""} caracteres
          </span>
          <span className="ui-sr-only" role="status">
            {announcement}
          </span>
        </>
      }
    >
      <Textarea
        value={value}
        onValueChange={onChange}
        rows={6}
        autoGrow
        maxRows={18}
        maxLength={5000}
        disabled={disabled}
        aria-describedby={counterId}
      />
    </Field>
  );
}

// Campaign of the brand, with inline creation (no page change).
export function CampaignField({ brandId, projectId, value, onChange, campaigns = [], onCreated, error, disabled }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", startDate: "", endDate: "" });
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const list = campaigns.filter((campaign) => campaign.brandId === brandId);

  const create = async () => {
    if (!draft.name.trim()) {
      setFields({ name: "Dê um nome à campanha." });
      return;
    }
    setBusy(true);
    setFields({});
    try {
      const { campaign } = await api.post("/campaigns", {
        brandId,
        projectId: projectId || undefined,
        name: draft.name.trim(),
        startDate: draft.startDate || undefined,
        endDate: draft.endDate || undefined,
      });
      onCreated?.(campaign);
      onChange(campaign.id);
      setDraft({ name: "", startDate: "", endDate: "" });
      setOpen(false);
      toast.success(`Campanha “${campaign.name}” criada.`);
    } catch (err) {
      if (err.fields) setFields(err.fields);
      else toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field
      label="Campanha"
      optional
      error={error}
      labelAside={
        brandId && !disabled ? (
          <button type="button" className="rv-textbtn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <Plus size={13} strokeWidth={1.4} aria-hidden="true" />
            Nova campanha
          </button>
        ) : null
      }
    >
      <Select
        value={value ?? ""}
        onValueChange={onChange}
        disabled={!brandId || disabled}
        options={[{ value: "", label: brandId ? "Sem campanha" : "Escolha a marca primeiro" }, ...list.map((c) => ({ value: c.id, label: c.name }))]}
      />
      {open && (
        <div className="cnt-inline-create ui-enter">
          <Field label="Nome da campanha" required error={fields.name}>
            <Input
              value={draft.name}
              maxLength={120}
              onValueChange={(name) => setDraft((d) => ({ ...d, name }))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  create();
                }
              }}
              autoFocus
            />
          </Field>
          <Field label="Início" optional error={fields.startDate}>
            <DateInput value={draft.startDate} onValueChange={(startDate) => setDraft((d) => ({ ...d, startDate }))} />
          </Field>
          <Field label="Fim" optional error={fields.endDate}>
            <DateInput value={draft.endDate} onValueChange={(endDate) => setDraft((d) => ({ ...d, endDate }))} />
          </Field>
          <Button size="sm" variant="primary" loading={busy} onClick={create}>
            Criar campanha
          </Button>
        </div>
      )}
    </Field>
  );
}
