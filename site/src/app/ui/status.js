// Official pt-BR labels and discreet tones for every state in the platform.
// Visibility, approval and publication are independent axes (docs/PLATFORM.md §3):
// never merge them into a single "status". Tones are always paired with text.
//
// Tones: neutral · slate · olive (done/approved) · amber (waiting) ·
//        clay (changes) · teal (scheduled/published/delivered) · red (failure).

const T = (label, tone = "neutral") => ({ label, tone });

export const STATUS = {
  visibility: {
    draft: T("Rascunho", "neutral"),
    internal_review: T("Revisão interna", "slate"),
    released: T("Liberado", "olive"),
  },
  approval: {
    none: T("Sem aprovação", "neutral"),
    pending: T("Aguardando aprovação", "amber"),
    changes_requested: T("Ajustes solicitados", "clay"),
    approved: T("Aprovado", "olive"),
  },
  publication: {
    not_scheduled: T("Não agendado", "neutral"),
    scheduled: T("Agendado", "teal"),
    published: T("Publicado", "teal"),
  },
  delivered: { true: T("Entregue", "teal"), false: T("Não entregue", "neutral") },
  archived: { true: T("Arquivado", "neutral"), false: T("Ativo", "olive") },
  version: {
    draft: T("Rascunho", "neutral"),
    internal_review: T("Revisão interna", "slate"),
    released: T("Liberada", "amber"),
    changes_requested: T("Ajustes solicitados", "clay"),
    approved: T("Aprovada", "olive"),
    superseded: T("Substituída", "neutral"),
  },
  decision: {
    approved: T("Aprovado", "olive"),
    changes_requested: T("Ajustes solicitados", "clay"),
  },
  project: {
    planning: T("Planejamento", "slate"),
    in_progress: T("Em andamento", "amber"),
    in_review: T("Em revisão", "clay"),
    delivered: T("Entregue", "teal"),
    paused: T("Pausado", "neutral"),
    archived: T("Arquivado", "neutral"),
  },
  task: {
    todo: T("A fazer", "neutral"),
    doing: T("Em andamento", "amber"),
    review: T("Em revisão", "slate"),
    done: T("Concluída", "olive"),
  },
  order: {
    draft: T("Rascunho", "neutral"),
    pending_payment: T("Aguardando pagamento", "amber"),
    paid: T("Pago", "olive"),
    failed: T("Falhou", "red"),
    cancelled: T("Cancelado", "neutral"),
    refunded: T("Estornado", "slate"),
  },
  contract: {
    draft: T("Rascunho", "neutral"),
    sending: T("Preparando envio", "slate"),
    sent: T("Aguardando assinaturas", "amber"),
    completed: T("Concluído", "olive"),
    refused: T("Recusado", "red"),
    expired: T("Expirado", "neutral"),
    canceled: T("Cancelado", "neutral"),
    failed: T("Falha no envio", "red"),
  },
  contractSigner: {
    pending: T("Pendente", "neutral"),
    notified: T("Convite enviado", "amber"),
    viewed: T("Convite aberto", "amber"),
    signed: T("Aceite registrado", "olive"),
    approved: T("Aprovado", "olive"),
    refused: T("Recusou", "red"),
    expired: T("Expirado", "neutral"),
    canceled: T("Cancelado", "neutral"),
    delegated: T("Delegou", "slate"),
  },
  subscription: {
    pending: T("Aguardando ativação", "amber"),
    active: T("Ativa", "olive"),
    paused: T("Pausada", "neutral"),
    cancelled: T("Cancelada", "neutral"),
    failed: T("Falhou", "red"),
  },
  // Mercado Pago payment statuses as stored in payments.status.
  payment: {
    pending: T("Pendente", "amber"),
    in_process: T("Em análise", "amber"),
    authorized: T("Autorizado", "slate"),
    approved: T("Aprovado", "olive"),
    in_mediation: T("Em disputa", "clay"),
    rejected: T("Recusado", "red"),
    cancelled: T("Cancelado", "neutral"),
    refunded: T("Estornado", "slate"),
    charged_back: T("Contestado", "red"),
  },
  briefing: {
    draft: T("Rascunho", "neutral"),
    awaiting_client: T("Aguardando preenchimento", "amber"),
    in_progress: T("Em preenchimento", "slate"),
    submitted: T("Respondido", "teal"),
    reviewed: T("Revisado", "olive"),
  },
  zip: {
    queued: T("Na fila", "neutral"),
    running: T("Gerando", "amber"),
    ready: T("Pronto", "olive"),
    failed: T("Falhou", "red"),
    expired: T("Expirado", "neutral"),
  },
  role: {
    admin: T("Administrador", "olive"),
    manager: T("Gestor", "teal"),
    designer: T("Designer/editor", "slate"),
    finance: T("Financeiro", "amber"),
    client: T("Cliente", "neutral"),
  },
  memberRole: {
    lead: T("Responsável", "olive"),
    designer: T("Designer", "slate"),
    editor: T("Editor", "slate"),
  },
  user: {
    invited: T("Convite enviado", "amber"),
    active: T("Ativo", "olive"),
    disabled: T("Desativado", "neutral"),
  },
  client: {
    active: T("Ativo", "olive"),
    paused: T("Pausado", "amber"),
    archived: T("Arquivado", "neutral"),
  },
  brand: {
    active: T("Ativa", "olive"),
    archived: T("Arquivada", "neutral"),
  },
  kit: {
    draft: T("Rascunho", "neutral"),
    released: T("Liberado", "olive"),
    archived: T("Arquivado", "neutral"),
  },
  kitKind: {
    brand_kit: T("Kit de marca", "olive"),
    project_package: T("Pacote do projeto", "teal"),
    custom: T("Kit personalizado", "slate"),
  },
  identity: {
    draft: T("Rascunho", "neutral"),
    released: T("Liberado", "olive"),
  },
  fontDistribution: {
    allowed: T("Distribuição permitida", "olive"),
    reference_only: T("Somente referência", "amber"),
  },
  comment: {
    client: T("Visível ao cliente", "teal"),
    internal: T("Nota interna", "clay"),
  },
  commentKind: {
    comment: T("Comentário", "neutral"),
    change_request: T("Pedido de ajuste", "clay"),
    approval_note: T("Nota de aprovação", "olive"),
  },
  previewStatus: {
    pending: T("Gerando prévia", "amber"),
    ready: T("Prévia pronta", "olive"),
    unsupported: T("Sem prévia", "neutral"),
    failed: T("Falha na prévia", "red"),
  },
  email: {
    queued: T("Na fila", "amber"),
    sent: T("Enviado", "olive"),
    failed: T("Falhou", "red"),
    not_configured: T("E-mail não configurado", "neutral"),
  },
  upload: {
    queued: T("Na fila", "neutral"),
    uploading: T("Enviando", "amber"),
    done: T("Enviado", "olive"),
    error: T("Falhou", "red"),
    cancelled: T("Cancelado", "neutral"),
  },
  service: {
    subscription: T("Assinatura mensal", "teal"),
    one_off: T("Avulso", "slate"),
  },
  active: { true: T("Ativo", "olive"), false: T("Inativo", "neutral") },
};

// Plain vocabularies (no tone) used in filters, forms and metadata.
export const LABELS = {
  network: {
    instagram: "Instagram",
    facebook: "Facebook",
    linkedin: "LinkedIn",
    tiktok: "TikTok",
    youtube: "YouTube",
    x: "X",
    pinterest: "Pinterest",
    whatsapp: "WhatsApp",
    outro: "Outra rede",
  },
  postFormat: {
    estatico: "Estático",
    carrossel: "Carrossel",
    stories: "Stories",
    reels: "Reels",
    video: "Vídeo",
    outro: "Outro",
  },
  fileRole: {
    original: "Original",
    final: "Final aprovado",
    editable: "Editável",
    cover: "Capa",
  },
  mediaKind: {
    image: "Imagem",
    vector: "Vetor",
    video: "Vídeo",
    audio: "Áudio",
    pdf: "PDF",
    font: "Fonte",
    document: "Documento",
    archive: "Arquivo compactado",
    design: "Arquivo de design",
    other: "Arquivo",
  },
  variant: {
    principal: "Logo principal",
    secundaria: "Versão secundária",
    simbolo: "Símbolo",
    clara: "Versão clara",
    escura: "Versão escura",
    monocromatica: "Monocromática",
  },
  area: {
    identity: "Identidade visual",
    content: "Conteúdo",
    other: "Materiais",
  },
  materialKind: {
    asset: "Material",
    post: "Publicação",
  },
  previewBg: {
    auto: "Automático",
    light: "Fundo claro",
    dark: "Fundo escuro",
    checker: "Transparência",
  },
};

const key = (value) =>
  value === true ? "true" : value === false ? "false" : value == null ? "" : String(value);

export function statusInfo(kind, value) {
  const entry = STATUS[kind]?.[key(value)];
  if (entry) return entry;
  // "archived"/"delivered" also accept a timestamp as truthy value.
  if ((kind === "archived" || kind === "delivered") && value) return STATUS[kind].true;
  return null;
}

export function statusLabel(kind, value) {
  const info = statusInfo(kind, value);
  if (info) return info.label;
  return value == null ? "" : String(value);
}

export function statusTone(kind, value) {
  return statusInfo(kind, value)?.tone || "neutral";
}

// [{value, label}] for selects and filters, in declaration order.
export function statusOptions(kind, { exclude = [] } = {}) {
  const map = STATUS[kind] || {};
  return Object.entries(map)
    .filter(([value]) => !exclude.includes(value))
    .map(([value, info]) => ({ value, label: info.label }));
}

export function label(vocabulary, value) {
  if (value == null || value === "") return "";
  return LABELS[vocabulary]?.[value] ?? statusLabel(vocabulary, value);
}

export function labelOptions(vocabulary) {
  return Object.entries(LABELS[vocabulary] || {}).map(([value, text]) => ({
    value,
    label: text,
  }));
}

export const roleLabel = (role) => statusLabel("role", role);
export const networkLabel = (value) => label("network", value);
export const postFormatLabel = (value) => label("postFormat", value);
export const fileRoleLabel = (value) => label("fileRole", value);
export const mediaKindLabel = (value) => label("mediaKind", value);
export const variantLabel = (value) => label("variant", value);
export const areaLabel = (value) => label("area", value);
