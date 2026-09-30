import {
  WhatsAppLink,
  PurchaseButton,
  IdentityBanner,
} from "./components/Commercial.jsx";
import { useEffect, useRef, useState } from "react";
import { usePageTransition } from "./components/PageTransition.jsx";
import {
  plans,
  steps,
  contactEmail,
  mailto as emailHref,
} from "./data/brand.js";
import { Link } from "react-router-dom";
import { SiteHeader, SiteFooter } from "./components/SiteChrome.jsx";
import { useSectionSnap, SectionNavigator } from "./components/SectionSnap.jsx";
import HeroScene, {
  HeroMotionToggle,
  useHeroMotion,
} from "./components/HeroScene.jsx";
import "./refinement.css";

const Arrow = ({ diagonal = false }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d={diagonal ? "M5 19 19 5M5 5h14v14" : "M3 12h17m-6-6 6 6-6 6"}
      stroke="currentColor"
      strokeWidth="1.15"
    />
  </svg>
);
const Label = ({ children, light = false }) => (
  <p className={`eyebrow ${light ? "light" : ""}`}>
    <span className="dash" />
    {children}
  </p>
);
export default function Home() {
  useSectionSnap();
  const loading = usePageTransition();
  const motion = useHeroMotion();
  const [active, setActive] = useState("inicio");
  const [service, setService] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const hero = useRef(null);
  const progress = useRef(null);
  const orbit = useRef(null);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reveals = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.setAttribute("data-visible", "true");
            reveals.unobserve(e.target);
          }
        }),
      { threshold: 0.12 },
    );
    document
      .querySelectorAll("[data-reveal]")
      .forEach((el) => reveals.observe(el));
    const sections = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id);
        }),
      { rootMargin: "-20% 0px -55% 0px" },
    );
    document
      .querySelectorAll("main > section[id]")
      .forEach((el) => sections.observe(el));
    const scenes = [...document.querySelectorAll("[data-scene]")];
    const steps = [...document.querySelectorAll(".step")];
    // The header is transparent over the contact section; once the footer
    // comes in, it steps aside so the contact content never runs beneath it.
    const ending = new IntersectionObserver(
      ([entry]) => setAtEnd(entry.isIntersecting),
      { rootMargin: "0px 0px -8px 0px" },
    );
    const footer = document.getElementById("rodape");
    if (footer) ending.observe(footer);
    let raf = 0;
    let smoothY = window.scrollY;
    let lastTime = performance.now();
    function draw(now = performance.now()) {
      const target = window.scrollY;
      const delta = Math.min(now - lastTime, 64);
      lastTime = now;
      smoothY += (target - smoothY) * (1 - Math.exp(-delta / 95));
      const y = smoothY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.current?.style.setProperty(
        "transform",
        `scaleX(${max > 0 ? y / max : 0})`,
      );
      if (!reduced.matches) {
        hero.current?.style.setProperty(
          "--parallax",
          `${Math.min(y * 0.19, 170)}px`,
        );
        orbit.current?.style.setProperty(
          "transform",
          `rotate(${y * 0.012}deg)`,
        );
      }
      scenes.forEach((scene) => {
        const rect = scene.getBoundingClientRect();
        if (rect.bottom < -100 || rect.top > innerHeight + 100) return;
        const position = Math.max(
          0,
          Math.min(1, (innerHeight - rect.top) / (innerHeight + rect.height)),
        );
        scene.style.setProperty("--scene", position.toFixed(4));
      });
      steps.forEach((step) => {
        const rect = step.getBoundingClientRect();
        const amount = Math.max(
          0,
          Math.min(1, (innerHeight * 0.7 - rect.top) / rect.height),
        );
        step.style.setProperty("--step-progress", amount.toFixed(3));
        step.setAttribute("data-current", String(amount > 0 && amount < 1));
      });
      raf = Math.abs(target - smoothY) > 0.2 ? requestAnimationFrame(draw) : 0;
    }
    const scroll = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    window.addEventListener("scroll", scroll, { passive: true, capture: true });
    draw();
    return () => {
      cancelAnimationFrame(raf);
      reveals.disconnect();
      sections.disconnect();
      ending.disconnect();
      window.removeEventListener("scroll", scroll, true);
    };
  }, []);

  const services = [
    {
      title: "Estratégia",
      sub: "Clareza antes de cada movimento.",
      text: "Entendemos o seu negócio, seu público e seus desafios. A partir desse olhar, construímos um posicionamento claro e um planejamento de conteúdo com intenção.",
      tags: ["Posicionamento", "Planejamento", "Direcionamento de marca"],
    },
    {
      title: "Conteúdo",
      sub: "Sua essência, bem comunicada.",
      text: "Transformamos estratégia em artes, textos e vídeos que traduzem o valor da sua marca. Conteúdo pensado para simplificar assuntos complexos e criar conexões reais.",
      tags: ["Artes e carrosséis", "Textos e roteiros", "Reels e vídeos"],
    },
    {
      title: "Gestão",
      sub: "Consistência que faz a diferença.",
      text: "Cuidamos da publicação e do acompanhamento dos canais. Analisamos o que funciona e ajustamos a rota para que sua presença digital evolua com o negócio.",
      tags: [
        "Gestão de Instagram",
        "Análise de métricas",
        "Acompanhamento contínuo",
      ],
    },
  ];

  return (
    <>
      <a className="skip" href="#conteudo">
        Ir para o conteúdo
      </a>
      <div className="scroll-progress" ref={progress} />
      <SiteHeader
        busy={loading}
        hidden={atEnd}
        transparent={["inicio", "contato"].includes(active)}
        tone={
          ["inicio", "metodo", "contato"].includes(active) ? "dark" : "light"
        }
      />
      <SectionNavigator active={active} busy={loading} />
      <main
        className="home-sections"
        id="conteudo"
        inert={loading || undefined}
      >
        <section id="inicio" className="hero" ref={hero}>
          <HeroScene
            ready={!loading}
            enabled={motion.enabled}
            paused={motion.paused}
          />
          <div className="hero-shade" />
          <div className="hero-orbit" ref={orbit} aria-hidden="true">
            <span />
          </div>
          <div className={`hero-copy ${loading ? "waiting" : ""}`}>
            <Label light>PESSOAS MUDAM. MARCAS TAMBÉM.</Label>
            <h1>
              <span className="title-line">
                <span>A comunicação</span>
              </span>
              <span className="title-line">
                <span>precisa acompanhar</span>
              </span>
              <span className="title-line">
                <em>esse movimento.</em>
              </span>
            </h1>
            <p>
              Estratégia, conteúdo e presença digital
              <br className="desktop-break" /> para fintechs e bancos digitais
              com visão de futuro.
            </p>
            <Link className="button" to="/solucoes">
              Conheça nossas soluções <Arrow />
            </Link>
          </div>
          <div className="hero-aside">
            <span>
              CLAREZA NA ESTRATÉGIA.
              <br />
              INTENÇÃO EM CADA DETALHE.
            </span>
            <span className="vertical-line" />
          </div>
          <div className="hero-bottom">
            <a href="#sobre" className="scroll-cue">
              <span>Explore a Metta</span>
              <span className="scroll-track" />
            </a>
            <span>
              ESTRATÉGIA &nbsp; / &nbsp; CONTEÚDO &nbsp; / &nbsp; RESULTADOS
            </span>
            <span className="hero-bottom-end">
              {motion.enabled && (
                <HeroMotionToggle
                  paused={motion.paused}
                  onToggle={() => motion.setPaused(!motion.paused)}
                />
              )}
              <span className="hero-count">01 — 06</span>
            </span>
          </div>
        </section>
        <section className="about section" id="sobre">
          <div className="about-copy" data-reveal>
            <Label>01 / A essência Metta</Label>
            <h2>
              Estratégia.
              <br />
              Criatividade.
              <br />
              <em>Com propósito.</em>
            </h2>
            <p>O digital aproxima. A estratégia conecta.</p>
            <p>
              A Metta une visão de negócio, sensibilidade criativa e gestão para
              transformar a presença digital em uma ferramenta real de
              crescimento.
            </p>
            <p>
              Com um olhar dedicado ao universo das fintechs, traduzimos
              assuntos complexos em uma comunicação clara, humana e relevante.
            </p>
            <a className="text-link" href="/sobre">
              Conheça a Metta por inteiro <Arrow />
            </a>
          </div>
          <figure className="about-visual" data-reveal data-scene>
            <img
              src="/images/brand-original.webp"
              width="1672"
              height="941"
              alt="Identidade Metta Marketing em parede verde oliva com luz e sombras naturais"
              loading="lazy"
            />
            <figcaption>
              <span>
                MENOS RUÍDO.
                <br />
                MAIS SIGNIFICADO.
              </span>
              <span>METTA</span>
            </figcaption>
          </figure>
        </section>
        <section className="services section" id="servicos">
          <div className="section-heading" data-reveal>
            <Label>02 / O que fazemos</Label>
            <div>
              <h2>
                Um olhar completo.
                <br />
                <em>Uma direção clara.</em>
              </h2>
              <p>
                Do posicionamento à rotina dos canais.
                <br />
                Conectamos cada ponto da sua comunicação.
              </p>
            </div>
          </div>
          <div className="service-list">
            {services.map((s, i) => (
              <article
                className={`service ${service === i ? "expanded" : ""}`}
                key={s.title}
                data-reveal
              >
                <h3>
                  <button
                    onClick={() => setService(service === i ? -1 : i)}
                    aria-expanded={service === i}
                    aria-controls={`service-${i}`}
                    id={`service-button-${i}`}
                  >
                    <span className="service-number">0{i + 1}</span>
                    <span>{s.title}</span>
                    <span className="service-subtitle">{s.sub}</span>
                    <span className="service-toggle">
                      {service === i ? "−" : "+"}
                    </span>
                  </button>
                </h3>
                <div
                  className="service-panel"
                  id={`service-${i}`}
                  role="region"
                  aria-labelledby={`service-button-${i}`}
                  aria-hidden={service !== i}
                  inert={service !== i || undefined}
                >
                  <div className="service-panel-inner">
                    <p>{s.text}</p>
                    <div className="tags">
                      {s.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <Link className="text-link section-detail-link" to="/solucoes">
            Explore nossas soluções <Arrow />
          </Link>
        </section>
        <section className="method section" id="metodo" data-scene>
          <div className="method-intro" data-reveal>
            <Label light>03 / Nosso método</Label>
            <h2>
              Do primeiro
              <br />
              olhar ao
              <br />
              <em>próximo passo.</em>
            </h2>
            <p>
              Marcas que crescem com consistência seguem um processo claro. O
              nosso conecta estratégia, criatividade e dados, com foco no seu
              negócio.
            </p>
            <Link className="text-link" to="/metodo">
              Conheça o processo completo <Arrow />
            </Link>
          </div>
          <div className="steps">
            {steps
              .map((s) => [s.title, s.text])
              .map(([title, text], i) => (
                <article className="step" data-reveal key={title}>
                  <span className="step-number">0{i + 1}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                  <span className="step-dot" />
                </article>
              ))}
          </div>
        </section>
        <section className="plans section" id="planos">
          <div className="section-heading" data-reveal>
            <Label>04 / Formas de avançar</Label>
            <div className="plans-heading-row">
              <h2>
                O seu momento.
                <br />
                <em>A nossa estratégia.</em>
              </h2>
              <IdentityBanner />
            </div>
          </div>
          <div className="plan-grid">
            {plans
              .map((p) => ({
                slug: p.slug,
                title: p.name,
                value: p.price,
                desc: p.description,
                items: p.items,
              }))
              .map((plan, i) => (
                <article
                  className={`plan ${i === 2 ? "featured" : ""}`}
                  key={plan.title}
                  data-reveal
                >
                  <div className="plan-top">
                    <span>0{i + 1}</span>
                    <span>
                      {i === 2 ? "VISÃO INTEGRADA" : "METTA MARKETING"}
                    </span>
                  </div>
                  <h3>{plan.title}</h3>
                  <p className="plan-description">{plan.desc}</p>
                  <div className="price">
                    <small>R$</small> {plan.value}
                    <span>/ mês</span>
                  </div>
                  <ul>
                    {plan.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <PurchaseButton slug={plan.slug} planName={plan.title} />
                </article>
              ))}
          </div>
          <Link className="text-link" to="/planos">
            Compare os escopos completos <Arrow />
          </Link>
          <p className="plan-note">
            ¹ Edição com materiais enviados pelo cliente. O escopo é alinhado na
            conversa inicial.
          </p>
        </section>
        <section className="contact section" id="contato" data-scene>
          <div className="contact-top" data-reveal>
            <Label light>05 / Vamos construir o que vem</Label>
            <span>
              MARCA FORTE.
              <br />
              DIREÇÃO CLARA.
            </span>
          </div>
          <div className="contact-main" data-reveal>
            <h2>
              O próximo passo
              <br />
              da sua marca
              <br />
              <em>começa aqui.</em>
            </h2>
            <a
              className="contact-circle"
              href={emailHref("Quero avançar com a Metta Marketing")}
              aria-label="Conversar com a Metta por e-mail"
            >
              <Arrow diagonal />
              <span>
                VAMOS
                <br />
                CONVERSAR
              </span>
            </a>
          </div>
          <div className="contact-details" data-reveal>
            <p>
              Conte o que você imagina.
              <br />
              Vamos encontrar a direção juntos.
            </p>
            <a href={`mailto:${contactEmail}`}>
              {contactEmail}
              <Arrow diagonal />
            </a>
            <WhatsAppLink />
          </div>
        </section>
      </main>
      <SiteFooter home />
    </>
  );
}
