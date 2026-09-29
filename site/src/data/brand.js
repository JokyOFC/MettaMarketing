export const contactEmail = "suporte@mettamkt.com.br";
export const mailto = (subject) =>
  `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}`;
export const plans = [
  {
    name: "Presença",
    price: "1.500",
    description:
      "Para quem já tem uma equipe de publicação e precisa de conteúdo com direção.",
    items: [
      "Planejamento mensal de conteúdo",
      "Até 8 conteúdos para feed por mês",
      "Artes estáticas e carrosséis",
      "Legendas e adaptações digitais",
      "Calendário editorial",
      "Entrega organizada dos materiais",
    ],
  },
  {
    name: "Gestão",
    price: "3.000",
    description:
      "Para delegar a rotina do Instagram com consistência e acompanhamento.",
    items: [
      "Tudo do plano Presença",
      "Até 12 conteúdos para feed por mês",
      "Gestão e publicação no Instagram",
      "Stories e roteiros para Reels",
      "Acompanhamento de métricas",
      "Relatório mensal em PDF",
      "Ajustes conforme desempenho",
    ],
  },
  {
    name: "Estratégia",
    price: "4.500",
    description:
      "Para conectar conteúdo, audiovisual e canais aos objetivos da marca.",
    items: [
      "Tudo do plano Gestão",
      "Estratégia mensal de conteúdo",
      "Edição de Reels e vídeos com materiais do cliente",
      "Direcionamento de gravações",
      "Planejamento de campanhas",
      "Estruturação do WhatsApp",
      "Reunião estratégica mensal - via call",
    ],
  },
];
export const steps = [
  {
    name: "Escutar",
    title: "Conversa estratégica",
    text: "Começamos pelo seu negócio. Objetivos, público, contexto e desafios orientam as primeiras decisões.",
    deliverable: "Diagnóstico e prioridades",
  },
  {
    name: "Direcionar",
    title: "Planejamento personalizado",
    text: "Organizamos o posicionamento, os pilares de conteúdo e os canais em um plano alinhado ao seu momento.",
    deliverable: "Direção estratégica e calendário",
  },
  {
    name: "Criar",
    title: "Produção de conteúdo",
    text: "Traduzimos a estratégia em artes, textos e vídeos. As entregas passam por uma etapa de alinhamento e aprovação.",
    deliverable: "Conteúdos prontos para comunicar",
  },
  {
    name: "Evoluir",
    title: "Gestão e acompanhamento",
    text: "Acompanhamos o desempenho, identificamos aprendizados e ajustamos o conteúdo para o próximo ciclo.",
    deliverable: "Análise e próximos passos",
  },
];

export const whatsappUrl = "https://wa.me/551120620707";
export const whatsappNumber = "+55 (11) 2062-0707";
