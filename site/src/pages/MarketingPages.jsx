import {
  WhatsAppLink,
  PurchaseButton,
  IdentityBanner,
} from "../components/Commercial.jsx";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageFrame, PageHeading, Arrow } from "../components/SiteChrome.jsx";
import { plans, steps, contactEmail, mailto } from "../data/brand.js";

function NextPage({
  title = "Vamos encontrar a sua direção?",
  to = "/contato",
  label = "Começar uma conversa",
}) {
  return (
    <aside className="next-page">
      <h2>{title}</h2>
      <Link className="button" to={to}>
        {label}
        <Arrow />
      </Link>
    </aside>
  );
}

export function AboutPage() {
  return (
    <PageFrame>
      <section className="page-intro editorial-split">
        <PageHeading
          label="A essência Metta"
          title="Um olhar atento."
          accent="Uma marca que avança."
        >
          Acreditamos em uma comunicação que faz sentido para o negócio e para
          quem está do outro lado.
        </PageHeading>
        <figure className="editorial-image">
          <img
            src="/images/brand-original.webp"
            width="1672"
            height="941"
            alt="Marca Metta Marketing em parede verde oliva"
          />
          <figcaption>
            ESTRATÉGIAS QUE CONECTAM SUA FINTECH AOS CLIENTES.
          </figcaption>
        </figure>
      </section>
      <section className="content-block about-story">
        <p className="eyebrow">
          <span className="dash" />
          Nossa visão
        </p>
        <h2>
          Presença é o começo.
          <br />
          <em>Conexão é o caminho.</em>
        </h2>
        <div>
          <p>
            A Metta desenvolve estratégias de marketing e presença digital para
            marcas que buscam se posicionar com clareza, consistência e
            intenção.
          </p>
          <p>
            Nosso olhar é especialmente dedicado a Fintechs e Bancos Digitais:
            negócios que precisam comunicar inovação e transmitir confiança, sem
            perder a proximidade com as pessoas.
          </p>
          <p>
            Unimos estratégia, conteúdo e gestão. Cada escolha visual, cada
            texto e cada publicação fazem parte de uma mesma direção.
          </p>
        </div>
      </section>
      <section className="values-grid content-block">
        {[
          [
            "Clareza",
            "Simplificar assuntos complexos sem perder o que importa.",
          ],
          [
            "Intenção",
            "Criar a partir dos objetivos da marca, com uma razão para cada escolha.",
          ],
          [
            "Consistência",
            "Construir uma presença reconhecível e cuidar da evolução ao longo do tempo.",
          ],
        ].map(([title, text], i) => (
          <article key={title}>
            <span>0{i + 1}</span>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </section>
      <NextPage
        title="Conheça o nosso jeito de trabalhar."
        to="/metodo"
        label="Explore o método"
      />
    </PageFrame>
  );
}

export function SolutionsPage() {
  const solutions = [
    [
      "Estratégia",
      "Clareza antes de cada movimento.",
      "Posicionamento, planejamento de conteúdo e direcionamento para conectar a comunicação aos objetivos do negócio.",
      [
        "Leitura de contexto e público",
        "Pilares editoriais e tom de voz",
        "Planejamento de campanhas",
        "Direcionamento dos canais",
      ],
    ],
    [
      "Conteúdo",
      "A sua essência, em cada entrega.",
      "Artes, textos e vídeos pensados para comunicar o valor da marca e tornar assuntos complexos mais próximos.",
      [
        "Artes estáticas e carrosséis",
        "Legendas e roteiros",
        "Stories e conteúdo para o feed",
        "Edição de Reels com materiais do cliente",
      ],
    ],
    [
      "Gestão",
      "Consistência também é estratégia.",
      "Publicação, acompanhamento e análise do que funciona para manter a presença ativa e evoluir com intenção.",
      [
        "Gestão e publicação no Instagram",
        "Acompanhamento de métricas",
        "Relatório mensal nos planos de gestão",
        "Ajustes de conteúdo e próximos passos",
      ],
    ],
  ];
  return (
    <PageFrame>
      <section className="page-intro">
        <PageHeading
          label="Soluções Metta"
          title="Cada ponto conectado."
          accent="Sua marca por inteiro."
        >
          Da primeira ideia à rotina dos canais, construímos uma comunicação com
          direção.
        </PageHeading>
      </section>
      <section className="solution-details content-block">
        {solutions.map(([name, title, text, items], i) => (
          <article key={name} id={name.toLowerCase()}>
            <div className="solution-index">0{i + 1}</div>
            <div>
              <p className="eyebrow">{name}</p>
              <h2>{title}</h2>
              <p>{text}</p>
            </div>
            <ul>
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>
      <NextPage
        title="Uma solução para o seu momento."
        to="/planos"
        label="Conheça os planos"
      />
    </PageFrame>
  );
}

export function MethodPage() {
  return (
    <PageFrame dark>
      <section className="page-intro">
        <PageHeading
          label="O processo Metta"
          title="Um processo claro."
          accent="E espaço para evoluir."
        >
          Uma metodologia que conecta escuta, planejamento, produção e
          acompanhamento.
        </PageHeading>
      </section>
      <section className="method-details content-block">
        {steps.map((step, i) => (
          <article key={step.name}>
            <span className="large-index">0{i + 1}</span>
            <div>
              <p className="eyebrow">{step.name}</p>
              <h2>{step.title}</h2>
              <p>{step.text}</p>
            </div>
            <div className="deliverable">
              <span>O QUE ORIENTA A ETAPA</span>
              <p>{step.deliverable}</p>
            </div>
          </article>
        ))}
      </section>
      <div className="method-note content-block">
        <p>
          O escopo e as etapas de acompanhamento são ajustados ao plano
          contratado e ao momento da sua marca.
        </p>
      </div>
      <NextPage title="Toda boa estratégia começa com escuta." />
    </PageFrame>
  );
}

export function PlansPage() {
  return (
    <PageFrame>
      <section className="page-intro">
        <PageHeading
          label="Formas de avançar"
          title="O seu momento."
          accent="A nossa estratégia."
        >
          Três níveis de atuação, com o mesmo cuidado em cada entrega.
        </PageHeading>
      </section>
      <section className="content-block full-plans">
        <IdentityBanner />
        <div className="plan-grid">
          {plans.map((p, i) => (
            <article
              className={`plan ${i === 2 ? "featured" : ""}`}
              key={p.name}
            >
              <div className="plan-top">
                <span>0{i + 1}</span>
                <span>{i === 2 ? "VISÃO INTEGRADA" : "METTA MARKETING"}</span>
              </div>
              <h2>{p.name}</h2>
              <p className="plan-description">{p.description}</p>
              <div className="price">
                <small>R$</small> {p.price}
                <span>/ mês</span>
              </div>
              <ul>
                {p.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <PurchaseButton />
            </article>
          ))}
        </div>
        <p className="plan-note">
          O escopo final é alinhado na conversa inicial. A edição de vídeos
          utiliza materiais enviados pelo cliente.
        </p>
      </section>
      <section className="content-block faq">
        <p className="eyebrow">Antes do próximo passo</p>
        {[
          [
            "Qual plano inclui publicação?",
            "O plano Gestão inclui gestão e publicação no Instagram. O plano Estratégia inclui os serviços do plano Gestão. No Presença, a publicação fica com sua equipe.",
          ],
          [
            "A produção de vídeo inclui filmagem?",
            "O plano Estratégia inclui edição de Reels e vídeos a partir dos materiais enviados pelo cliente, além de sugestões e direcionamento de gravação quando necessário.",
          ],
          [
            "Como começamos?",
            "O primeiro passo é uma conversa para entender seu negócio, seus objetivos e a rotina atual da marca. A partir dela, alinhamos o plano e o escopo de trabalho.",
          ],
        ].map(([q, a]) => (
          <details key={q}>
            <summary>
              {q}
              <span>+</span>
            </summary>
            <p>{a}</p>
          </details>
        ))}
      </section>
      <NextPage />
    </PageFrame>
  );
}

export function ContactPage() {
  const selected =
    new URLSearchParams(window.location.search).get("plano") || "";
  const [name, setName] = useState(""),
    [company, setCompany] = useState(""),
    [message, setMessage] = useState(""),
    [plan, setPlan] = useState(selected),
    [prepared, setPrepared] = useState(false);
  function prepare(e) {
    e.preventDefault();
    setPrepared(true);
  }
  const href = `${mailto(`Conversa com a Metta${plan ? ` — Plano ${plan}` : ""}`)}&body=${encodeURIComponent(`Olá, sou ${name}${company ? `, da ${company}` : ""}.\n\n${message}\n\n${plan ? `Tenho interesse no plano ${plan}.` : ""}`)}`;
  return (
    <PageFrame>
      <section className="page-intro contact-page">
        <PageHeading
          label="Vamos conversar"
          title="Seu próximo passo"
          accent="começa com uma conversa."
        >
          Conte o momento da sua marca. Vamos encontrar a direção juntos.
        </PageHeading>
        <div className="contact-columns">
          <div className="contact-address">
            <a href={`mailto:${contactEmail}`}>
              {contactEmail}
              <Arrow diagonal />
            </a>
            <WhatsAppLink />
            <span>
              METTA MARKETING LTDA
              <br />
              CNPJ 68.562.250/0001-59
            </span>
          </div>
          <form
            className="metta-form"
            onSubmit={prepare}
            onChange={() => setPrepared(false)}
          >
            <label>
              Seu nome
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={100}
              />
            </label>
            <label>
              Marca ou empresa
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                autoComplete="organization"
                maxLength={120}
              />
            </label>
            <label>
              Como podemos ajudar?
              <select value={plan} onChange={(e) => setPlan(e.target.value)}>
                <option value="">Quero encontrar a melhor solução</option>
                {plans.map((p) => (
                  <option key={p.name}>{p.name}</option>
                ))}
              </select>
            </label>
            <label>
              Sobre o seu momento
              <textarea
                required
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={2000}
              />
            </label>
            <button className="button solid" type="submit">
              Preparar conversa
              <Arrow />
            </button>
            <p className="form-note">
              Preparamos uma mensagem para você enviar pelo seu aplicativo de
              e-mail.
            </p>
            {prepared && (
              <div className="form-feedback" role="status">
                <p>
                  Sua mensagem está pronta. O envio será feito pelo seu
                  aplicativo de e-mail.
                </p>
                <a className="text-link" href={href}>
                  Abrir e-mail com a mensagem <Arrow diagonal />
                </a>
              </div>
            )}
          </form>
        </div>
      </section>
    </PageFrame>
  );
}

export function NotFoundPage() {
  return (
    <PageFrame>
      <section className="page-intro">
        <PageHeading
          label="404 / Um novo caminho"
          title="Esta página"
          accent="não está por aqui."
        />
        <Link className="button solid" to="/">
          Voltar para o início
          <Arrow />
        </Link>
      </section>
    </PageFrame>
  );
}
