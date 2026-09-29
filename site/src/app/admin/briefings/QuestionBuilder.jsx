import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CircleAlert, Copy, GripVertical, ListPlus, Plus, Trash2, X } from "lucide-react";
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
  Switch,
  Tooltip,
  useReducedMotion,
  useToast,
} from "../../ui/index.js";
import { QUESTION_TYPES, hasOptions, pad2, typeMeta } from "../../client/briefings/questions.jsx";
import { moveItem, useDragSort } from "./useDragSort.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// Icon action of a question card: the accessible name carries the question,
// the tooltip shows only the short verb (not repeated as a description).
function CardAction({ tip, ...props }) {
  return (
    <Tooltip content={tip} describe={false}>
      <IconButton size="sm" variant="ghost" tooltip={false} {...props} />
    </Tooltip>
  );
}

// "pergunta 3 (Qual é o público?)" — names the question in repeated controls.
const questionName = (question, index) => {
  const text = String(question.label ?? "").trim();
  const short = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return `pergunta ${index + 1} (${short || "sem título"})`;
};

export function newQuestionId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `q${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const blankQuestion = (type = "text") => ({
  id: newQuestionId(),
  label: "",
  help: "",
  type,
  required: false,
  options: hasOptions(type) ? ["", ""] : [],
});

// Editable list of questions. questions/onChange hold the whole array;
// errors = { [questionId]: { label?, options? } }.
export default function QuestionBuilder({ questions, onChange, errors = {} }) {
  const toast = useToast();
  const reduced = useReducedMotion();
  const [focusId, setFocusId] = useState(null);
  const listRef = useRef(null);
  // After "Mover para cima/baixo" the card may be moved in the DOM (losing
  // focus); keep focus on the arrow that was pressed, in the moved card.
  const moveFocus = useRef(null); // { id, dir }

  useLayoutEffect(() => {
    const target = moveFocus.current;
    if (!target) return;
    moveFocus.current = null;
    const card = listRef.current?.querySelector(`[data-question-id="${target.id}"]`);
    const button = card?.querySelector(`[data-move="${target.dir}"]`);
    if (!button) return;
    button.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [questions, reduced]);

  const moveBy = (index, delta) => {
    const to = index + delta;
    if (to < 0 || to >= questions.length) return; // boundary arrows stay focusable (aria-disabled)
    moveFocus.current = { id: questions[index].id, dir: delta < 0 ? "up" : "down" };
    onChange(moveItem(questions, index, to));
  };

  useEffect(() => {
    if (!focusId) return;
    const input = document.getElementById(`hub-qlabel-${focusId}`);
    if (input) {
      input.focus({ preventScroll: true });
      input.closest(".hub-qcard")?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    }
    setFocusId(null);
  }, [focusId, reduced]);

  const sort = useDragSort({
    keys: questions.map((q) => q.id),
    onMove: (from, to) => onChange(moveItem(questions, from, to)),
    label: (index) => `pergunta ${index + 1}${questions[index]?.label ? ` (${questions[index].label})` : ""}`,
  });

  const update = (index, patch) => {
    const next = [...questions];
    const current = next[index];
    const merged = { ...current, ...patch };
    if (patch.type && hasOptions(patch.type) && merged.options.filter((o) => o.trim()).length === 0) merged.options = ["", ""];
    next[index] = merged;
    onChange(next);
  };

  const add = (type) => {
    const question = blankQuestion(type);
    onChange([...questions, question]);
    setFocusId(question.id);
  };

  const duplicate = (index) => {
    const source = questions[index];
    const copy = { ...source, id: newQuestionId(), label: source.label ? `${source.label} (cópia)` : "", options: [...source.options] };
    const next = [...questions];
    next.splice(index + 1, 0, copy);
    onChange(next);
    setFocusId(copy.id);
  };

  const remove = (index) => {
    const removed = questions[index];
    const before = questions;
    onChange(questions.filter((_, i) => i !== index));
    const neighbour = questions[index + 1] ?? questions[index - 1];
    if (neighbour) requestAnimationFrame(() => document.getElementById(`hub-qlabel-${neighbour.id}`)?.focus());
    toast.info({
      message: removed.label ? `Pergunta “${removed.label}” removida.` : "Pergunta removida.",
      action: { label: "Desfazer", onClick: () => onChange(before) },
    });
  };

  return (
    <div className="hub-builder">
      {questions.length === 0 ? (
        <EmptyState
          compact
          icon={ListPlus}
          title="Nenhuma pergunta ainda"
          description="Escolha um tipo abaixo para adicionar a primeira pergunta."
        />
      ) : (
        <ol className={cx("hub-qlist", sort.dragging && "is-sorting")} ref={listRef}>
          {questions.map((question, index) => {
            const error = errors[question.id];
            return (
              <li
                key={question.id}
                data-question-id={question.id}
                ref={sort.itemRef(question.id)}
                style={sort.itemStyle(index)}
                className={cx("hub-qcard", sort.itemClass(index), error && "is-invalid")}
              >
                <div className="hub-qcard__rail">
                  <button className="hub-grip" {...sort.handleProps(index)}>
                    <GripVertical size={18} strokeWidth={1.4} aria-hidden="true" />
                  </button>
                  <span className="hub-qcard__num" aria-hidden="true">
                    {pad2(index + 1)}
                  </span>
                </div>
                <div className="hub-qcard__body">
                  <div className="hub-qcard__row">
                    <Field label={`Pergunta ${index + 1}`} error={error?.label} className="hub-qcard__label" id={`hub-qlabel-${question.id}`}>
                      <Input
                        value={question.label}
                        maxLength={300}
                        placeholder="Escreva a pergunta"
                        onValueChange={(value) => update(index, { label: value })}
                      />
                    </Field>
                    <Field label="Tipo" className="hub-qcard__type">
                      <Select
                        aria-label={`Tipo da pergunta ${index + 1}`}
                        value={question.type}
                        options={QUESTION_TYPES.map((type) => ({ value: type.value, label: type.label }))}
                        onValueChange={(value) => update(index, { type: value })}
                      />
                    </Field>
                  </div>
                  <Field label="Orientação para o cliente" optional>
                    <Input
                      aria-label={`Orientação para o cliente na pergunta ${index + 1} (opcional)`}
                      value={question.help}
                      maxLength={1000}
                      size="sm"
                      placeholder="Ex.: inclua links, exemplos ou o nível de detalhe esperado"
                      onValueChange={(value) => update(index, { help: value })}
                    />
                  </Field>
                  {hasOptions(question.type) && (
                    <OptionsEditor
                      question={question}
                      questionNumber={index + 1}
                      error={error?.options}
                      onChange={(options) => update(index, { options })}
                    />
                  )}
                  <div className="hub-qcard__foot">
                    <Switch
                      label="Obrigatória"
                      aria-label={`P${questionName(question, index).slice(1)} obrigatória`}
                      checked={question.required}
                      onCheckedChange={(checked) => update(index, { required: checked })}
                      className="hub-qcard__req"
                    />
                    <div className="hub-qcard__actions">
                      <CardAction
                        label={`Mover a ${questionName(question, index)} para cima`}
                        tip="Mover para cima"
                        icon={ArrowUp}
                        data-move="up"
                        aria-disabled={index === 0 || undefined}
                        className="hub-qmove"
                        onClick={() => moveBy(index, -1)}
                      />
                      <CardAction
                        label={`Mover a ${questionName(question, index)} para baixo`}
                        tip="Mover para baixo"
                        icon={ArrowDown}
                        data-move="down"
                        aria-disabled={index === questions.length - 1 || undefined}
                        className="hub-qmove"
                        onClick={() => moveBy(index, 1)}
                      />
                      <CardAction
                        label={`Duplicar a ${questionName(question, index)}`}
                        tip="Duplicar pergunta"
                        icon={Copy}
                        onClick={() => duplicate(index)}
                      />
                      <CardAction
                        label={`Remover a ${questionName(question, index)}`}
                        tip="Remover pergunta"
                        icon={Trash2}
                        className="hub-danger-icon"
                        onClick={() => remove(index)}
                      />
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <span className="ui-sr-only" aria-live="polite">
        {sort.message}
      </span>

      <div className="hub-addq">
        <p className="hub-addq__title">
          <Plus size={16} strokeWidth={1.4} aria-hidden="true" />
          Adicionar pergunta
        </p>
        <div className="hub-addq__types">
          {QUESTION_TYPES.map((type) => {
            const TypeIcon = type.icon;
            return (
              <button key={type.value} type="button" className="hub-addq__type" onClick={() => add(type.value)}>
                <TypeIcon size={18} strokeWidth={1.4} aria-hidden="true" />
                <span>{type.label}</span>
                <small>{type.hint}</small>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Options of a choice/multi question: Enter adds the next one, Backspace on
// an empty option removes it, pasting several lines creates several options.
// questionNumber keeps option controls distinct between questions for
// screen readers ("Remover opção 2 da pergunta 3").
function OptionsEditor({ question, questionNumber, onChange, error }) {
  const of = questionNumber ? ` da pergunta ${questionNumber}` : "";
  const refs = useRef([]);
  const [focusIndex, setFocusIndex] = useState(null);
  const multi = question.type === "multi";
  const options = question.options.length ? question.options : ["", ""];

  useEffect(() => {
    if (focusIndex === null) return;
    refs.current[focusIndex]?.focus();
    setFocusIndex(null);
  }, [focusIndex]);

  const set = (index, value) => onChange(options.map((option, i) => (i === index ? value : option)));
  const insertAfter = (index, values = [""]) => {
    const next = [...options];
    next.splice(index + 1, 0, ...values);
    onChange(next.slice(0, 30));
    setFocusIndex(Math.min(index + values.length, 29));
  };
  const removeAt = (index) => {
    if (options.length <= 1) return;
    onChange(options.filter((_, i) => i !== index));
    setFocusIndex(Math.max(0, index - 1));
  };

  return (
    <div className={cx("hub-opts", error && "is-invalid")} role="group" aria-label={`Opções de ${typeMeta(question.type).label.toLowerCase()}`}>
      <p className="hub-opts__label">Opções</p>
      <ol className="hub-opts__list">
        {options.map((option, index) => (
          <li key={index} className="hub-opt">
            <span className={cx("hub-opt__mark", multi ? "is-box" : "is-dot")} aria-hidden="true" />
            <input
              ref={(node) => {
                refs.current[index] = node;
              }}
              id={index === 0 ? `hub-qopt-${question.id}` : undefined}
              className="ui-control ui-control--sm hub-opt__input"
              value={option}
              maxLength={120}
              placeholder={`Opção ${index + 1}`}
              aria-label={`Opção ${index + 1}${of}`}
              aria-invalid={Boolean(error && !option.trim()) || undefined}
              onChange={(event) => set(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (options.length < 30) insertAfter(index);
                } else if (event.key === "Backspace" && !option && options.length > 1) {
                  event.preventDefault();
                  removeAt(index);
                }
              }}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                if (!text.includes("\n")) return;
                event.preventDefault();
                const lines = text
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean);
                if (!lines.length) return;
                const next = [...options];
                next[index] = option ? option : lines.shift();
                if (lines.length) next.splice(index + 1, 0, ...lines);
                onChange(next.slice(0, 30));
                setFocusIndex(Math.min(index + lines.length, 29));
              }}
            />
            <IconButton
              label={`Remover opção ${index + 1}${of}`}
              icon={X}
              size="sm"
              variant="ghost"
              tooltip={false}
              disabled={options.length <= 1}
              onClick={() => removeAt(index)}
            />
          </li>
        ))}
      </ol>
      <Button
        variant="link"
        size="sm"
        icon={Plus}
        disabled={options.length >= 30}
        onClick={() => insertAfter(options.length - 1)}
        aria-label={questionNumber ? `Adicionar opção à pergunta ${questionNumber}` : undefined}
      >
        Adicionar opção
      </Button>
      {error && (
        <p className="hub-question__error">
          <CircleAlert size={14} strokeWidth={1.6} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
