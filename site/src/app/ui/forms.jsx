import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, CircleAlert, Minus, Search, X } from "lucide-react";
import { renderIcon } from "./Icon.jsx";
import { Kbd } from "./display.jsx";
import { prefersReducedMotion } from "./layer.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const FieldContext = createContext(null);

// Controls inside <Field> pick up id, aria-describedby, aria-invalid and required.
function useFieldProps({ id, invalid, required, "aria-describedby": describedBy }) {
  const field = useContext(FieldContext);
  return {
    id: id ?? field?.id,
    "aria-invalid": invalid || field?.invalid || undefined,
    "aria-describedby": [describedBy, field?.describedBy].filter(Boolean).join(" ") || undefined,
    required: required ?? field?.required,
  };
}

// Label + control + hint + error. Error text is announced with the control.
export function Field({
  label,
  hint,
  error,
  required,
  optional,
  id: idProp,
  className,
  children,
  inline = false,
  labelAside,
}) {
  const autoId = useId();
  const id = idProp || `f${autoId.replace(/:/g, "")}`;
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;
  const ctx = {
    id,
    invalid: Boolean(error),
    required,
    describedBy: [errorId, hintId].filter(Boolean).join(" ") || undefined,
  };
  const content =
    typeof children === "function"
      ? children({
          id,
          "aria-describedby": ctx.describedBy,
          "aria-invalid": ctx.invalid || undefined,
        })
      : children;
  return (
    <FieldContext.Provider value={ctx}>
      <div
        className={cx("ui-field", inline && "ui-field--inline", error && "is-invalid", className)}
      >
        {label && (
          <div className="ui-field__top">
            <label className="ui-field__label" htmlFor={id}>
              {label}
              {required && (
                <span className="ui-field__req" aria-hidden="true">
                  *
                </span>
              )}
              {optional && !required && <span className="ui-field__opt">opcional</span>}
            </label>
            {labelAside}
          </div>
        )}
        {content}
        {error && (
          <p id={errorId} className="ui-field__error">
            <CircleAlert size={14} strokeWidth={1.6} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        {hint && (
          <p id={hintId} className="ui-field__hint">
            {hint}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

const INVALID = '[aria-invalid="true"]';
const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const isShown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

function firstInvalid(scope) {
  for (const el of scope.querySelectorAll(INVALID)) {
    if (!isShown(el)) continue;
    // aria-invalid on a wrapper (custom control): focus the control inside it.
    const target = el.matches(FOCUSABLE) ? el : [...el.querySelectorAll(FOCUSABLE)].find(isShown);
    if (target) return target;
  }
  return null;
}

// After a failed submit: moves focus to the first control marked
// aria-invalid="true" inside `root` (an element, a ref, or omitted for the
// whole document) and scrolls it to the middle of its scroll container.
// Focusing it makes screen readers read the label, the invalid state and the
// error text (Field links it through aria-describedby).
// Call it right after setting the error state, in the same handler: it waits
// for the next frame, when React has committed the new aria-invalid marks
// (so a field fixed since the last attempt is not picked), and looks once
// more a frame later. Resolves with the focused element, or null.
export function focusFirstInvalid(root, { reducedMotion } = {}) {
  const reduced = reducedMotion ?? prefersReducedMotion();
  const apply = () => {
    const node = root && typeof root === "object" && "current" in root ? root.current : root;
    const scope = node || (typeof document !== "undefined" ? document : null);
    const target = scope && firstInvalid(scope);
    if (!target) return null;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    return target;
  };
  if (typeof requestAnimationFrame === "undefined") return Promise.resolve(apply());
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const found = apply();
      if (found) resolve(found);
      else requestAnimationFrame(() => resolve(apply()));
    });
  });
}

const valueHandler = (onChange, onValueChange) => (event) => {
  onChange?.(event);
  onValueChange?.(event.target.value, event);
};

// Text input. `icon` sits at the start, `suffix` (text or node) at the end.
export function Input({
  icon,
  suffix,
  size = "md",
  invalid,
  className,
  onChange,
  onValueChange,
  ref,
  type = "text",
  ...rest
}) {
  const field = useFieldProps({ invalid, ...rest });
  const input = (
    <input
      ref={ref}
      type={type}
      className={cx("ui-control", `ui-control--${size}`, !icon && !suffix && className)}
      {...rest}
      {...field}
      onChange={valueHandler(onChange, onValueChange)}
    />
  );
  if (!icon && !suffix) return input;
  return (
    <div className={cx("ui-affix", icon && "has-icon", suffix && "has-suffix", className)}>
      {icon && <span className="ui-affix__icon">{renderIcon(icon, { size: 16 })}</span>}
      {input}
      {suffix && <span className="ui-affix__suffix">{suffix}</span>}
    </div>
  );
}

// Multi-line text. `autoGrow` expands with the content up to `maxRows`.
export function Textarea({
  invalid,
  className,
  rows = 4,
  autoGrow = false,
  maxRows = 14,
  onChange,
  onValueChange,
  ref,
  ...rest
}) {
  const field = useFieldProps({ invalid, ...rest });
  const inner = useRef(null);
  const resize = () => {
    const el = inner.current;
    if (!el || !autoGrow) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 21;
    el.style.height = `${Math.min(el.scrollHeight + 2, line * maxRows + 24)}px`;
  };
  useLayoutEffect(resize, [rest.value, autoGrow]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea
      ref={(node) => {
        inner.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      rows={rows}
      className={cx("ui-control ui-textarea", className)}
      {...rest}
      {...field}
      onChange={(event) => {
        valueHandler(onChange, onValueChange)(event);
        resize();
      }}
    />
  );
}

// Native select with the kit's chrome. `options` [{value, label, disabled}]
// or children <option>s; `placeholder` adds an empty first option.
export function Select({
  options,
  placeholder,
  size = "md",
  invalid,
  className,
  children,
  onChange,
  onValueChange,
  ref,
  ...rest
}) {
  const field = useFieldProps({ invalid, ...rest });
  return (
    <div className={cx("ui-select", `ui-select--${size}`, className)}>
      <select
        ref={ref}
        className={cx("ui-control", `ui-control--${size}`)}
        {...rest}
        {...field}
        onChange={valueHandler(onChange, onValueChange)}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options
          ? options.map((option) =>
              typeof option === "string" ? (
                <option key={option} value={option}>
                  {option}
                </option>
              ) : (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ),
            )
          : children}
      </select>
      <ChevronDown className="ui-select__chevron" size={16} strokeWidth={1.4} aria-hidden="true" />
    </div>
  );
}

// Native date input (value "YYYY-MM-DD").
export function DateInput({
  size = "md",
  invalid,
  className,
  onChange,
  onValueChange,
  ref,
  type = "date",
  ...rest
}) {
  const field = useFieldProps({ invalid, ...rest });
  return (
    <input
      ref={ref}
      type={type}
      className={cx("ui-control", `ui-control--${size}`, "ui-date", className)}
      {...rest}
      {...field}
      onChange={valueHandler(onChange, onValueChange)}
    />
  );
}

// Custom box over a real checkbox (keyboard, forms and screen readers intact).
// Self-labelled (not wired to <Field>); without `label`, pass aria-label.
export function Checkbox({
  label,
  description,
  indeterminate = false,
  className,
  onChange,
  onCheckedChange,
  ref,
  size = "md",
  ...rest
}) {
  const inner = useRef(null);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  const box = (
    <span className={cx("ui-check", `ui-check--${size}`, !label && className)}>
      <input
        ref={(node) => {
          inner.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="checkbox"
        aria-checked={indeterminate ? "mixed" : undefined}
        {...rest}
        onChange={(event) => {
          onChange?.(event);
          onCheckedChange?.(event.target.checked, event);
        }}
      />
      <span className="ui-check__box" aria-hidden="true">
        {indeterminate ? <Minus size={12} strokeWidth={2} /> : <Check size={12} strokeWidth={2} />}
      </span>
    </span>
  );
  if (!label) return box;
  return (
    <label className={cx("ui-choice", rest.disabled && "is-disabled", className)}>
      {box}
      <span className="ui-choice__text">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

// On/off setting. Native checkbox with role="switch".
export function Switch({ label, description, className, onChange, onCheckedChange, ref, ...rest }) {
  const control = (
    <span className={cx("ui-switch", !label && className)}>
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        {...rest}
        onChange={(event) => {
          onChange?.(event);
          onCheckedChange?.(event.target.checked, event);
        }}
      />
      <span className="ui-switch__track" aria-hidden="true">
        <span className="ui-switch__thumb" />
      </span>
    </span>
  );
  if (!label) return control;
  return (
    <label className={cx("ui-choice ui-choice--switch", rest.disabled && "is-disabled", className)}>
      <span className="ui-choice__text">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
      {control}
    </label>
  );
}

// Chips editor: Enter or comma adds, Backspace on empty removes the last one.
// value: string[]; onChange(nextTags).
export function TagInput({
  value = [],
  onChange,
  placeholder = "Adicionar etiqueta",
  suggestions = [],
  max,
  invalid,
  disabled,
  className,
  normalize = (text) => text.trim().replace(/\s+/g, " "),
  "aria-label": ariaLabel,
  ...rest
}) {
  const field = useFieldProps({ invalid, ...rest });
  const [text, setText] = useState("");
  const inputRef = useRef(null);
  const listId = useId();
  const tags = Array.isArray(value) ? value : [];
  const full = max !== undefined && tags.length >= max;

  const add = (raw) => {
    const parts = String(raw).split(",").map(normalize).filter(Boolean);
    if (!parts.length) return;
    const next = [...tags];
    for (const part of parts) {
      if (max !== undefined && next.length >= max) break;
      if (!next.some((t) => t.toLowerCase() === part.toLowerCase())) next.push(part);
    }
    if (next.length !== tags.length) onChange?.(next);
    setText("");
  };
  const remove = (index) => {
    onChange?.(tags.filter((_, i) => i !== index));
    inputRef.current?.focus();
  };

  return (
    <div
      className={cx(
        "ui-tags ui-control",
        invalid && "is-invalid",
        disabled && "is-disabled",
        className,
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget) inputRef.current?.focus();
      }}
    >
      {tags.map((tag, i) => (
        <span key={`${tag}-${i}`} className="ui-tag">
          <span>{tag}</span>
          {!disabled && (
            <button type="button" aria-label={`Remover ${tag}`} onClick={() => remove(i)}>
              <X size={12} strokeWidth={1.6} aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        {...field}
        aria-label={ariaLabel}
        list={suggestions.length ? listId : undefined}
        value={text}
        disabled={disabled || full}
        placeholder={full ? "" : placeholder}
        onChange={(event) => {
          const next = event.target.value;
          if (next.includes(",")) add(next);
          else setText(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            if (text.trim()) {
              event.preventDefault();
              add(text);
            }
          } else if (event.key === "Backspace" && !text && tags.length) {
            event.preventDefault();
            onChange?.(tags.slice(0, -1));
          }
        }}
        onBlur={() => text.trim() && add(text)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          if (pasted.includes(",") || pasted.includes("\n")) {
            event.preventDefault();
            add(pasted.replace(/\n/g, ","));
          }
        }}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
    </div>
  );
}

// Search box: instant typing, debounced onChange(value). Esc clears.
// `shortcut` ("/") focuses it from anywhere outside other fields.
export function SearchInput({
  value = "",
  onChange,
  onSearch,
  delay = 300,
  placeholder = "Buscar",
  label = "Buscar",
  shortcut,
  size = "md",
  className,
  autoFocus,
  ref,
  ...rest
}) {
  const [text, setText] = useState(value ?? "");
  const lastSent = useRef(value ?? "");
  const inputRef = useRef(null);

  useEffect(() => {
    if ((value ?? "") !== lastSent.current) {
      lastSent.current = value ?? "";
      setText(value ?? "");
    }
  }, [value]);

  useEffect(() => {
    if (text === lastSent.current) return undefined;
    const id = setTimeout(() => {
      lastSent.current = text;
      onChange?.(text);
    }, delay);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, delay]);

  useEffect(() => {
    if (!shortcut) return undefined;
    const onKey = (event) => {
      if (event.key !== shortcut || event.metaKey || event.ctrlKey || event.altKey) return;
      const t = event.target;
      if (t.closest?.("input, textarea, select, [contenteditable='true'], dialog")) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shortcut]);

  const flush = (next) => {
    lastSent.current = next;
    onChange?.(next);
  };

  return (
    <div className={cx("ui-search", `ui-search--${size}`, className)} role="search">
      <Search className="ui-search__icon" size={16} strokeWidth={1.4} aria-hidden="true" />
      <input
        ref={(node) => {
          inputRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="search"
        className={cx("ui-control", `ui-control--${size}`)}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        {...rest}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && text) {
            event.preventDefault();
            event.stopPropagation();
            setText("");
            flush("");
          } else if (event.key === "Enter") {
            flush(text);
            onSearch?.(text);
          }
        }}
      />
      {text ? (
        <button
          type="button"
          className="ui-search__clear"
          aria-label="Limpar busca"
          onClick={() => {
            setText("");
            flush("");
            inputRef.current?.focus();
          }}
        >
          <X size={14} strokeWidth={1.6} aria-hidden="true" />
        </button>
      ) : (
        shortcut && (
          <Kbd className="ui-search__kbd" aria-hidden="true">
            {shortcut}
          </Kbd>
        )
      )}
    </div>
  );
}
