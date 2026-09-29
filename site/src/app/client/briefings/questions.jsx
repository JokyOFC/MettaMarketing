// Briefing question kit shared by the client form, the team's preview and the
// answers view: type vocabulary, answer helpers, inputs and read-only values.
import { useId } from "react";
import {
  AlignLeft,
  CalendarDays,
  CircleAlert,
  CircleDot,
  ExternalLink,
  Link2,
  ListChecks,
  Type,
} from "lucide-react";
import { DateInput, Input, Textarea, formatDate } from "../../ui/index.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

export const QUESTION_TYPES = [
  { value: "text", label: "Texto curto", hint: "Uma linha", icon: Type },
  { value: "textarea", label: "Texto longo", hint: "Parágrafos", icon: AlignLeft },
  { value: "choice", label: "Escolha única", hint: "Uma opção", icon: CircleDot },
  { value: "multi", label: "Múltipla escolha", hint: "Várias opções", icon: ListChecks },
  { value: "date", label: "Data", hint: "Dia do calendário", icon: CalendarDays },
  { value: "url", label: "Link", hint: "Endereço na web", icon: Link2 },
];

export const typeMeta = (type) => QUESTION_TYPES.find((item) => item.value === type) ?? QUESTION_TYPES[0];
export const hasOptions = (type) => type === "choice" || type === "multi";
export const pad2 = (n) => String(n).padStart(2, "0");

export const TEXT_LIMITS = { text: 1000, textarea: 10000, url: 2000 };

export function hasAnswer(question, value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim().length > 0;
}

export function progressOf(questions = [], answers = {}) {
  let answered = 0;
  let required = 0;
  let requiredAnswered = 0;
  for (const question of questions) {
    const ok = hasAnswer(question, answers[question.id]);
    if (ok) answered += 1;
    if (question.required) {
      required += 1;
      if (ok) requiredAnswered += 1;
    }
  }
  return { total: questions.length, answered, required, requiredAnswered };
}

// Plain-text version of the answers (copy to clipboard, e-mail, notes).
export function answersAsText(briefing) {
  const lines = [briefing.title, ""];
  (briefing.questions || []).forEach((question, index) => {
    const value = briefing.answers?.[question.id];
    let text = "Sem resposta";
    if (hasAnswer(question, value)) {
      if (Array.isArray(value)) text = value.join(", ");
      else if (question.type === "date") text = formatDate(value);
      else text = String(value);
    }
    lines.push(`${index + 1}. ${question.label}`, text, "");
  });
  return lines.join("\n").trim();
}

// Due date copy and tone: { date, relative, tone: 'late'|'soon'|null, text }.
export function dueInfo(dueDate, { open = true } = {}) {
  if (!dueDate) return null;
  const [y, m, d] = dueDate.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86_400_000);
  const date = formatDate(dueDate, { year: due.getFullYear() !== today.getFullYear() });
  if (!open) return { date, relative: null, tone: null, text: date };
  let relative;
  if (days === 0) relative = "vence hoje";
  else if (days === 1) relative = "vence amanhã";
  else if (days > 1) relative = `em ${days} dias`;
  else if (days === -1) relative = "venceu ontem";
  else relative = `venceu há ${-days} dias`;
  const tone = days < 0 ? "late" : days <= 2 ? "soon" : null;
  return { date, relative, tone, text: `${date} · ${relative}` };
}

// DOM id of a question's first focusable control.
export const controlId = (scope, questionId) => `${scope}-q-${questionId}`;

// One question: numeral, label, help, control and error. Choice types use a
// fieldset/legend so the group is announced with its question.
export function QuestionBlock({ index, question, scope = "hub", error, children, readOnly = false, className }) {
  const baseId = controlId(scope, question.id);
  const helpId = question.help ? `${baseId}-help` : undefined;
  const errorId = error ? `${baseId}-error` : undefined;
  const group = hasOptions(question.type) && !readOnly;
  const Tag = group ? "fieldset" : "div";
  const Title = group ? "legend" : readOnly ? "h3" : "label";
  const titleProps = !group && !readOnly ? { htmlFor: baseId } : {};
  return (
    <Tag
      className={cx("hub-question", error && "is-invalid", readOnly && "is-readonly", className)}
      data-question={question.id}
      aria-describedby={group ? [helpId, errorId].filter(Boolean).join(" ") || undefined : undefined}
    >
      <span className="hub-question__num" aria-hidden="true">
        {pad2(index + 1)}
      </span>
      <div className="hub-question__body">
        <Title className="hub-question__label" {...titleProps}>
          <span className="ui-sr-only">Pergunta {index + 1}: </span>
          {question.label}
          {question.required ? (
            <span className="hub-question__req">
              <span aria-hidden="true">obrigatória</span>
              <span className="ui-sr-only">(obrigatória)</span>
            </span>
          ) : null}
        </Title>
        {question.help && (
          <p id={helpId} className="hub-question__help">
            {question.help}
          </p>
        )}
        <div className="hub-question__control">
          {typeof children === "function" ? children({ id: baseId, describedBy: [errorId, helpId].filter(Boolean).join(" ") || undefined }) : children}
        </div>
        {error && (
          <p id={errorId} className="hub-question__error">
            <CircleAlert size={14} strokeWidth={1.6} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </Tag>
  );
}

// Option cards over native radios/checkboxes (keyboard and screen readers intact).
function Options({ question, value, onChange, disabled, id, describedBy, invalid }) {
  const name = useId();
  const multi = question.type === "multi";
  const selected = multi ? (Array.isArray(value) ? value : []) : value ?? "";
  const toggle = (option, checked) => {
    if (!multi) return onChange(option);
    const next = checked ? [...selected, option] : selected.filter((item) => item !== option);
    onChange(question.options.filter((item) => next.includes(item)));
  };
  return (
    <div className={cx("hub-options", multi && "is-multi")} role={multi ? "group" : "radiogroup"} aria-describedby={describedBy} aria-invalid={invalid || undefined}>
      {(question.options || []).map((option, i) => {
        const checked = multi ? selected.includes(option) : selected === option;
        return (
          <label key={option} className={cx("hub-option", checked && "is-checked", disabled && "is-disabled")}>
            <input
              id={i === 0 ? id : undefined}
              type={multi ? "checkbox" : "radio"}
              name={name}
              value={option}
              checked={checked}
              disabled={disabled}
              onChange={(event) => toggle(option, event.target.checked)}
            />
            <span className={cx("hub-option__mark", multi ? "is-box" : "is-dot")} aria-hidden="true" />
            <span className="hub-option__text">{option}</span>
          </label>
        );
      })}
      {!multi && selected && !question.required && !disabled && (
        <button type="button" className="hub-options__clear" onClick={() => onChange("")}>
          Limpar escolha
        </button>
      )}
    </div>
  );
}

// Control for one question. onChange(value) receives a string or string[].
export function QuestionInput({ question, value, onChange, disabled = false, id, describedBy, invalid = false }) {
  // kit controls merge `invalid` into aria-invalid themselves
  const common = {
    id,
    disabled,
    invalid,
    "aria-describedby": describedBy,
    "aria-required": question.required || undefined,
  };
  switch (question.type) {
    case "textarea":
      return (
        <Textarea
          {...common}
          value={value ?? ""}
          rows={4}
          autoGrow
          maxLength={TEXT_LIMITS.textarea}
          placeholder="Escreva sua resposta"
          onValueChange={onChange}
        />
      );
    case "choice":
    case "multi":
      return <Options question={question} value={value} onChange={onChange} disabled={disabled} id={id} describedBy={describedBy} invalid={invalid} />;
    case "date":
      return <DateInput {...common} className="hub-date" value={value ?? ""} onValueChange={onChange} />;
    case "url":
      return (
        <Input
          {...common}
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          icon={Link2}
          value={value ?? ""}
          maxLength={TEXT_LIMITS.url}
          placeholder="https://"
          onValueChange={onChange}
        />
      );
    default:
      return (
        <Input
          {...common}
          value={value ?? ""}
          maxLength={TEXT_LIMITS.text}
          placeholder="Escreva sua resposta"
          onValueChange={onChange}
        />
      );
  }
}

// Read-only answer. Links open in a new tab; multi answers become chips.
export function AnswerValue({ question, value }) {
  if (!hasAnswer(question, value)) return <p className="hub-answer is-empty">Sem resposta</p>;
  if (Array.isArray(value))
    return (
      <ul className="hub-answer hub-answer--chips" aria-label="Opções escolhidas">
        {value.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  if (question.type === "date")
    return (
      <p className="hub-answer">
        <time dateTime={value}>{formatDate(value)}</time>
      </p>
    );
  if (question.type === "url") {
    const safe = /^https?:\/\//i.test(value);
    return (
      <p className="hub-answer">
        {safe ? (
          <a className="hub-answer__link" href={value} target="_blank" rel="noreferrer noopener">
            <span>{value}</span>
            <ExternalLink size={14} strokeWidth={1.4} aria-hidden="true" />
            <span className="ui-sr-only">(abre em nova aba)</span>
          </a>
        ) : (
          value
        )}
      </p>
    );
  }
  return <p className={cx("hub-answer", question.type === "textarea" && "is-long")}>{value}</p>;
}
