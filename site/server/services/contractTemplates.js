// Contract templates: the initial models (one for monthly plans, one for
// one-off services such as brand identity), the catalog of variables, and the
// small markup the PDF renderer understands:
//   # Título       clause heading
//   ## Subtítulo   smaller heading
//   - item         bullet
//   **negrito**    bold span inside a line
//   {{chave}}      variable; {{itens}} alone on a line expands into bullets
// Blank lines separate paragraphs. There is no HTML and no code execution.

export const KINDS = ["subscription", "one_off"];

export const KIND_LABELS = {
  subscription: "Planos mensais",
  one_off: "Identidade visual e serviços avulsos",
};

export const VARIABLES = [
  { key: "contrato_codigo", label: "Código do contrato", example: "CT-7F3K2QAB" },
  { key: "data", label: "Data de emissão", example: "29 de setembro de 2026" },
  { key: "contratante_nome", label: "Contratante (razão social ou nome)", example: "Aurora Pagamentos Ltda." },
  { key: "contratante_documento", label: "CNPJ ou CPF da contratante", example: "11.222.333/0001-81" },
  { key: "representante_nome", label: "Quem assina pela contratante", example: "Marina Costa" },
  { key: "representante_email", label: "E-mail de quem assina pela contratante", example: "marina@aurora.com.br" },
  { key: "marca", label: "Marca", example: "Aurora" },
  { key: "servico", label: "Plano ou serviço", example: "Gestão" },
  { key: "descricao", label: "Descrição do pedido", example: "Identidade visual" },
  { key: "itens", label: "Itens do plano ou serviço (lista)", example: "Planejamento mensal de conteúdo" },
  { key: "valor", label: "Valor", example: "R$ 3.000,00" },
  { key: "valor_por_extenso", label: "Valor por extenso", example: "três mil reais" },
  { key: "periodicidade", label: "Periodicidade", example: "mensal" },
  { key: "vencimento", label: "Vencimento", example: "10 de outubro de 2026" },
  { key: "aviso_previo_dias", label: "Aviso prévio para encerrar (dias)", example: "30" },
  { key: "contratada_nome", label: "Contratada (razão social)", example: "METTA MARKETING LTDA" },
  { key: "contratada_documento", label: "CNPJ da contratada", example: "68.562.250/0001-59" },
  { key: "contratada_representante", label: "Quem assina pela Metta", example: "Nome do representante" },
  { key: "foro", label: "Foro (cidade/UF)", example: "São Paulo/SP" },
];

const KNOWN = new Set(VARIABLES.map((v) => v.key));

const PARTIES = `**CONTRATANTE:** {{contratante_nome}}, inscrita no CNPJ/CPF sob o nº {{contratante_documento}}, neste ato representada por {{representante_nome}} ({{representante_email}}).

**CONTRATADA:** {{contratada_nome}}, inscrita no CNPJ sob o nº {{contratada_documento}}, neste ato representada por {{contratada_representante}}.

As partes acima identificadas celebram este contrato de prestação de serviços, que se rege pelas cláusulas a seguir.`;

const COMMON_TAIL = (n) => `# Cláusula ${n}ª — Da confidencialidade e da proteção de dados
${n}.1. As partes manterão sigilo sobre as informações confidenciais a que tiverem acesso em razão deste contrato e tratarão dados pessoais de acordo com a Lei nº 13.709/2018 (LGPD), apenas para executá-lo.

# Cláusula ${n + 1}ª — Da assinatura eletrônica
${n + 1}.1. As partes reconhecem a validade da assinatura deste contrato por meio eletrônico, na plataforma AssinaVelox, nos termos do art. 10, § 2º, da Medida Provisória nº 2.200-2/2001, e a admitem como meio de comprovação da autoria e da integridade do documento.

# Cláusula ${n + 2}ª — Do foro
${n + 2}.1. Fica eleito o foro da comarca de {{foro}} para dirimir as questões oriundas deste contrato.

Documento emitido em {{data}} pela plataforma Metta. Contrato {{contrato_codigo}}.`;

export const DEFAULT_TEMPLATES = {
  subscription: {
    title: "Contrato de prestação de serviços de marketing",
    body: `${PARTIES}

# Cláusula 1ª — Do objeto
1.1. A CONTRATADA prestará à CONTRATANTE os serviços do plano **{{servico}}** para a marca **{{marca}}**, que compreendem:
{{itens}}
1.2. As entregas, as aprovações e as solicitações de ajuste acontecem pela área do cliente da plataforma Metta, que registra o histórico de cada material.

# Cláusula 2ª — Do valor e do pagamento
2.1. Pelos serviços, a CONTRATANTE pagará à CONTRATADA o valor mensal de {{valor}} ({{valor_por_extenso}}).
2.2. A cobrança é recorrente e mensal, pelo Mercado Pago, na forma autorizada pela CONTRATANTE na área do cliente.

# Cláusula 3ª — Da vigência e do encerramento
3.1. Este contrato vigora por prazo indeterminado a partir da data da última assinatura.
3.2. Qualquer das partes pode encerrá-lo mediante aviso prévio de {{aviso_previo_dias}} dias, por escrito ou pela plataforma.

# Cláusula 4ª — Das obrigações das partes
4.1. A CONTRATANTE fornecerá, nos prazos combinados, as informações, os briefings, os acessos e os materiais necessários aos serviços, e revisará os materiais apresentados, aprovando-os ou solicitando ajustes pela plataforma.
4.2. A CONTRATADA executará os serviços com qualidade técnica, dentro do escopo do plano contratado, e manterá a CONTRATANTE informada sobre o andamento das entregas.

# Cláusula 5ª — Da propriedade intelectual
5.1. Os materiais aprovados e pagos podem ser usados pela CONTRATANTE nas finalidades da marca {{marca}}. Arquivos editáveis são entregues quando incluídos no plano.

${COMMON_TAIL(6)}`,
  },
  one_off: {
    title: "Contrato de prestação de serviços",
    body: `${PARTIES}

# Cláusula 1ª — Do objeto
1.1. A CONTRATADA prestará à CONTRATANTE o serviço **{{servico}}** para a marca **{{marca}}**, que compreende:
{{itens}}
1.2. As apresentações, as aprovações, as solicitações de ajuste e a entrega dos arquivos acontecem pela área do cliente da plataforma Metta, que registra o histórico de cada versão.

# Cláusula 2ª — Do valor e do pagamento
2.1. Pelo serviço, a CONTRATANTE pagará à CONTRATADA o valor de {{valor}} ({{valor_por_extenso}}), em pagamento único pelo Mercado Pago, com vencimento em {{vencimento}}.

# Cláusula 3ª — Da vigência
3.1. Este contrato vigora a partir da data da última assinatura até a entrega da versão final aprovada pela CONTRATANTE.

# Cláusula 4ª — Das obrigações das partes
4.1. A CONTRATANTE fornecerá as informações e os materiais necessários ao serviço e revisará as versões apresentadas, aprovando-as ou solicitando ajustes pela plataforma.
4.2. A CONTRATADA executará o serviço com qualidade técnica, dentro do escopo contratado, e disponibilizará os arquivos finais na área do cliente.

# Cláusula 5ª — Da propriedade intelectual
5.1. Após a quitação integral, a CONTRATANTE poderá usar a versão final aprovada nas finalidades da marca {{marca}}. Arquivos editáveis são entregues quando incluídos no serviço.

${COMMON_TAIL(6)}`,
  },
};

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g;

/** Variables used by a template body -> { used: [...], unknown: [...] }. */
export function inspectTemplate(text) {
  const used = new Set();
  const unknown = new Set();
  for (const match of String(text ?? "").matchAll(PLACEHOLDER)) (KNOWN.has(match[1]) ? used : unknown).add(match[1]);
  // Malformed markers such as "{{ nome|upper }}" are reported as unknown.
  for (const match of String(text ?? "").matchAll(/\{\{([^}]*)\}\}/g))
    if (!/^\s*[a-z][a-z0-9_]{0,63}\s*$/.test(match[1])) unknown.add(match[1].trim() || "(vazio)");
  return { used: [...used], unknown: [...unknown] };
}

/**
 * Replaces variables in one pass (a value that contains "{{x}}" is inserted
 * literally and never reprocessed). `itens` alone on a line becomes bullets.
 */
export function fillTemplate(text, values) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    if (/^\s*\{\{\s*itens\s*\}\}\s*$/.test(line)) {
      const items = Array.isArray(values.itens) ? values.itens : [];
      if (items.length) for (const item of items) out.push(`- ${sanitizeInline(item)}`);
      else out.push("- Itens conforme a proposta aprovada pela CONTRATANTE.");
      continue;
    }
    out.push(
      line.replace(PLACEHOLDER, (_, key) => {
        if (!KNOWN.has(key)) return `{{${key}}}`;
        const value = values[key];
        if (Array.isArray(value)) return value.map(sanitizeInline).join("; ");
        return value === undefined || value === null || value === "" ? "—" : sanitizeInline(value);
      }),
    );
  }
  return out.join("\n");
}

// Values never introduce markup: no line breaks, no "**", no leading "#"/"-".
function sanitizeInline(value) {
  return String(value).replace(/[\r\n\t]+/g, " ").replace(/\*\*/g, "*").trim();
}

/** Parses the filled text into blocks for the renderer. */
export function parseBlocks(text) {
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", runs: parseRuns(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      blocks.push({ type: "h2", runs: parseRuns(line.slice(3)) });
    } else if (line.startsWith("# ")) {
      flush();
      blocks.push({ type: "h1", runs: parseRuns(line.slice(2)) });
    } else if (/^[-•]\s+/.test(line)) {
      flush();
      blocks.push({ type: "li", runs: parseRuns(line.replace(/^[-•]\s+/, "")) });
    } else if (/^\d+(\.\d+)*\.\s/.test(line)) {
      // numbered sub-clauses ("1.1. …") start their own paragraph
      flush();
      paragraph.push(line);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

function parseRuns(text) {
  const runs = [];
  const parts = String(text).split("**");
  parts.forEach((part, index) => {
    if (part) runs.push({ text: part, bold: index % 2 === 1 });
  });
  return runs.length ? runs : [{ text: "", bold: false }];
}

// ------------------------------------------------------------------ money in words (pt-BR)

const UNITS = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

function below1000(n) {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const parts = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (rest) {
    if (rest < 20) parts.push(UNITS[rest]);
    else {
      const t = Math.floor(rest / 10);
      const u = rest % 10;
      parts.push(u ? `${TENS[t]} e ${UNITS[u]}` : TENS[t]);
    }
  }
  return parts.join(" e ");
}

function integerWords(n) {
  if (n === 0) return "zero";
  const groups = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  const scales = [
    ["", ""],
    ["mil", "mil"],
    ["milhão", "milhões"],
    ["bilhão", "bilhões"],
  ];
  const words = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (!g) continue;
    let text = i === 1 && g === 1 ? "mil" : below1000(g);
    if (i >= 1 && !(i === 1 && g === 1)) text = `${text} ${g === 1 ? scales[i][0] : scales[i][1]}`;
    words.push({ text, value: g, scale: i });
  }
  // "e" joins the last group when it is below 100 or a round hundred.
  return words
    .map((w, index) => {
      if (index === 0) return w.text;
      const last = index === words.length - 1;
      const joinWithE = last && (w.value < 100 || w.value % 100 === 0);
      return `${joinWithE ? "e " : ""}${w.text}`;
    })
    .join(" ")
    .replace(/ +/g, " ")
    .trim();
}

/** 450000 -> "quatro mil e quinhentos reais"; 150 -> "um real e cinquenta centavos". */
export function moneyInWords(cents) {
  const total = Math.max(0, Math.round(Number(cents) || 0));
  const reais = Math.floor(total / 100);
  const centavos = total % 100;
  const parts = [];
  if (reais) {
    const words = integerWords(reais);
    const de = reais >= 1_000_000 && reais % 1_000_000 === 0 ? " de" : "";
    parts.push(`${words}${de} ${reais === 1 ? "real" : "reais"}`);
  }
  if (centavos) parts.push(`${integerWords(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  return parts.length ? parts.join(" e ") : "zero real";
}
