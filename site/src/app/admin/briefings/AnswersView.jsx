import { MessageSquareDashed } from "lucide-react";
import { CopyButton, EmptyState, formatDateTime } from "../../ui/index.js";
import { AnswerValue, QuestionBlock, answersAsText } from "../../client/briefings/questions.jsx";

// Clean read view of the client's answers, in question order.
export default function AnswersView({ briefing }) {
  const { answered, total, required, requiredAnswered } = briefing.progress;
  const partial = briefing.status === "awaiting_client" || briefing.status === "in_progress";

  if (partial && answered === 0)
    return (
      <EmptyState
        icon={MessageSquareDashed}
        title="O cliente ainda não começou a responder"
        description="As respostas aparecem aqui conforme o cliente preenche. Você é avisado quando ele enviar."
      />
    );

  return (
    <section className="hub-answers" aria-labelledby="hub-answers-title">
      <header className="hub-answers__head">
        <div>
          <p className="ui-eyebrow">{partial ? "Respostas parciais" : "Respostas do cliente"}</p>
          <h2 id="hub-answers-title" className="hub-answers__title">
            {answered} de {total} perguntas <em>respondidas</em>
          </h2>
          <p className="ui-meta">
            {required ? `${requiredAnswered} de ${required} obrigatórias. ` : ""}
            {partial
              ? "O cliente ainda está preenchendo; estas respostas foram salvas automaticamente e podem mudar até o envio."
              : briefing.submittedAt
                ? `Enviadas${briefing.submittedBy?.name ? ` por ${briefing.submittedBy.name}` : ""} em ${formatDateTime(briefing.submittedAt)}.`
                : ""}
          </p>
        </div>
        <CopyButton text={() => answersAsText(briefing)} label="Copiar respostas" variant="secondary" />
      </header>
      <div className="hub-questions is-readonly">
        {briefing.questions.map((question, index) => (
          <QuestionBlock key={question.id} index={index} question={question} readOnly className="ui-enter">
            <AnswerValue question={question} value={briefing.answers?.[question.id]} />
          </QuestionBlock>
        ))}
      </div>
    </section>
  );
}
