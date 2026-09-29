// Brand palette: large swatches that copy their HEX on click or Enter.
import { useRef } from "react";
import { Check, TextSelect } from "lucide-react";
import { CopyButton, useCopy, useToast } from "../../ui/index.js";
import { cx, normalizeHex, readableTone } from "./lib.js";

const ICON = { strokeWidth: 1.4, "aria-hidden": true };

// Selects the text of a node so it can be copied by hand (Ctrl+C / long press).
function selectText(node) {
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

function manualCopyHint() {
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  if (touch) return "toque e segure para copiar";
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  return `copie com ${mac ? "⌘" : "Ctrl"}+C`;
}

function codesOf(color, hex) {
  return [
    { label: "HEX", value: hex },
    { label: "RGB", value: color.rgb },
    { label: "CMYK", value: color.cmyk },
    { label: "Pantone", value: color.pantone },
  ].filter((code) => code.value && String(code.value).trim());
}

function Swatch({ color, index }) {
  const toast = useToast();
  // `failed` stays on for a few seconds after a blocked copy (browser
  // setting, embedded page): say so and leave the HEX selected in the code
  // list so it can be copied by hand.
  const { copy, copied, failed } = useCopy(1600);
  const hexRef = useRef(null);
  const hex = normalizeHex(color.hex) || String(color.hex || "");
  const tone = readableTone(hex);
  const codes = codesOf(color, hex);

  const onCopy = async () => {
    const ok = await copy(hex);
    if (ok) return;
    const selected = hexRef.current ? selectText(hexRef.current) : false;
    toast.error(
      selected
        ? `Não foi possível copiar. O código ${hex} ficou selecionado: ${manualCopyHint()}.`
        : `Não foi possível copiar. Selecione o código ${hex} e copie manualmente.`,
    );
  };

  return (
    <li className="mb-swatch ui-enter" style={{ "--i": Math.min(index, 8) }}>
      <button
        type="button"
        className={cx("mb-swatch__color", `is-${tone}`, copied && "is-copied", failed && "is-failed")}
        style={{ "--swatch": normalizeHex(hex) || "transparent" }}
        onClick={onCopy}
        aria-label={`${color.name}: copiar HEX ${hex}`}
      >
        <span className="mb-swatch__label">
          <span className="mb-swatch__name">{color.name}</span>
          <span className="mb-swatch__hex">{hex}</span>
        </span>
        <span className="mb-swatch__hint" aria-hidden="true">
          Copiar HEX
        </span>
        <span className="mb-swatch__copied" aria-hidden="true">
          <Check size={16} {...ICON} strokeWidth={1.8} />
          Copiado
        </span>
        <span className="mb-swatch__failed" aria-hidden="true">
          <TextSelect size={16} {...ICON} />
          Copie o código abaixo
        </span>
      </button>
      <span className="ui-sr-only" role="status" aria-live="polite">
        {copied ? `${hex} copiado` : ""}
      </span>
      <div className="mb-swatch__body">
        {color.role && <p className="mb-swatch__role">{color.role}</p>}
        <dl className="mb-codes">
          {codes.map((code) => (
            <div key={code.label} className={cx("mb-code", failed && code.label === "HEX" && "is-selected")}>
              <dt>{code.label}</dt>
              <dd>
                <span className="mb-code__value" ref={code.label === "HEX" ? hexRef : undefined}>
                  {code.value}
                </span>
                <CopyButton
                  iconOnly
                  size="sm"
                  text={code.value}
                  label={`Copiar ${code.label} de ${color.name}`}
                  copiedLabel={`${code.label} copiado`}
                  className="mb-code__copy"
                />
              </dd>
            </div>
          ))}
        </dl>
        {color.usage && <p className="mb-swatch__usage">{color.usage}</p>}
      </div>
    </li>
  );
}

export function paletteText(colors) {
  return colors
    .map((c) => `${c.name} — ${normalizeHex(c.hex) || c.hex}`)
    .join("\n");
}

export function PaletteCopy({ colors }) {
  return (
    <CopyButton
      variant="secondary"
      size="md"
      text={() => paletteText(colors)}
      label="Copiar paleta"
      copiedLabel="Paleta copiada"
    />
  );
}

export default function Palette({ colors }) {
  return (
    <ul className="mb-palette" aria-label="Cores da marca">
      {colors.map((color, i) => (
        <Swatch key={color.id || `${color.hex}-${i}`} color={color} index={i} />
      ))}
    </ul>
  );
}
