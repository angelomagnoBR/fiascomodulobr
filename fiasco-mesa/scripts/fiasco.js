/**
 * Fiasco: Mesa — módulo para Foundry VTT (v12/v13)
 * Ficha de jogador, ficha de dado, pool de dados com Dice So Nice e importador de playsets.
 * Cada parte pode ser ligada/desligada em Configurações > Configurar Módulos > Fiasco: Mesa.
 */

const MOD = "fiasco-mesa";
const TIPO_JOGADOR = `${MOD}.jogador`;
const TIPO_DADO = `${MOD}.dado`;

const { HandlebarsApplicationMixin, ApplicationV2, DialogV2 } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const SheetConfig = foundry.applications?.apps?.DocumentSheetConfig ?? globalThis.DocumentSheetConfig;
const FilePickerCls = () => foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
const GEN = () => game.release?.generation ?? 12;

/* Cores do Dice So Nice. Edite aqui se quiser outro visual. */
const APARENCIA_DSN = {
  branco: { colorset: "custom", foreground: "#1b1b1b", background: "#efe6d2", outline: "#1b1b1b", edge: "#d6c9aa", texture: "none", material: "plastic" },
  preto:  { colorset: "custom", foreground: "#efe6d2", background: "#161616", outline: "#efe6d2", edge: "#2e2e2e", texture: "none", material: "plastic" }
};

/* ------------------------------------------------------------------ */
/*  Configurações (liga/desliga)                                       */
/* ------------------------------------------------------------------ */

const OPCOES = {
  fichaJogador: { name: "Ficha de Jogador", hint: "Usa a ficha personalizada de jogador (com mapa de relações). Desligado: ficha simples.", type: Boolean, default: true, reload: true },
  fichaDado:    { name: "Ficha de Dado", hint: "Usa a ficha personalizada de dado. Desligado: ficha simples.", type: Boolean, default: true, reload: true },
  criarDados:   { name: "Botões de dados", hint: "Mostra os botões 'Criar dados' e 'Rolar todos' na aba de Atores (só GM).", type: Boolean, default: true, reload: true },
  hudDado:      { name: "Botão de rolar no token", hint: "Adiciona um botão de rolar no HUD do token de dado (rola todos os dados selecionados).", type: Boolean, default: true, reload: true },
  mapa:         { name: "Mapa de Relações", hint: "Habilita a janela com o mapa de relações de todos os jogadores.", type: Boolean, default: true, reload: true },
  importador:   { name: "Importador de Playset", hint: "Mostra o botão 'Importar Playset' na aba de Diários (só GM).", type: Boolean, default: true, reload: true },
  diceSoNice:   { name: "Usar Dice So Nice", hint: "Anima a rolagem em 3D com dados brancos e pretos (precisa do módulo Dice So Nice).", type: Boolean, default: true, reload: false },
  mensagemChat: { name: "Mensagem no chat", hint: "Mostra no chat o resultado de cada rolagem de dados.", type: Boolean, default: true, reload: false },
  tamanhoDado:  { name: "Tamanho do token de dado", hint: "Em quadrados da grade (ex.: 0.5 = meio quadrado).", type: Number, default: 0.5, reload: false },
  facesCaminho: { name: "Imagens das faces", hint: "Caminho das faces. Use {cor} (branco/preto) e {valor} (1-6).", type: String, default: `modules/${MOD}/assets/dados/{cor}-{valor}.svg`, reload: false }
};

function registrarConfiguracoes() {
  for (const [key, o] of Object.entries(OPCOES)) {
    game.settings.register(MOD, key, {
      name: o.name, hint: o.hint, scope: "world", config: true,
      type: o.type, default: o.default, requiresReload: o.reload
    });
  }
}

function ativo(key) {
  try { return game.settings.get(MOD, key); } catch { return OPCOES[key]?.default; }
}

/* ------------------------------------------------------------------ */
/*  Modelos de dados                                                   */
/* ------------------------------------------------------------------ */

const F = foundry.data.fields;

function campoRelacao() {
  return new F.SchemaField({
    vizinho: new F.StringField({ initial: "", blank: true }),
    relacao: new F.StringField({ initial: "", blank: true }),
    detalhe: new F.StringField({ initial: "", blank: true })
  });
}

class JogadorData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      conceito: new F.StringField({ initial: "", blank: true }),
      necessidade: new F.StringField({ initial: "", blank: true }),
      objeto: new F.StringField({ initial: "", blank: true }),
      local: new F.StringField({ initial: "", blank: true }),
      esquerda: campoRelacao(),
      direita: campoRelacao(),
      brancos: new F.NumberField({ initial: 0, integer: true, min: 0 }),
      pretos: new F.NumberField({ initial: 0, integer: true, min: 0 }),
      notas: new F.StringField({ initial: "", blank: true })
    };
  }
}

class DadoData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      cor: new F.StringField({ initial: "branco", choices: ["branco", "preto"] }),
      valor: new F.NumberField({ initial: 1, integer: true, min: 1, max: 6 })
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Utilidades de dados                                                */
/* ------------------------------------------------------------------ */

function face(cor, valor) {
  return String(ativo("facesCaminho")).replace("{cor}", cor).replace("{valor}", valor);
}

/** Muda cor e/ou valor de um dado e atualiza a imagem (token ou ator). */
async function definirFace(actor, { cor, valor } = {}) {
  const c = cor ?? actor.system.cor;
  const v = valor ?? actor.system.valor;
  const src = face(c, v);
  const data = { "system.cor": c, "system.valor": v, img: src };
  if (!actor.isToken) data["prototypeToken.texture.src"] = src;
  await actor.update(data);
  if (actor.isToken && actor.token) await actor.token.update({ "texture.src": src });
}

const ehDado = (doc) => (doc?.actor ?? doc)?.type === TIPO_DADO;

/** Rola uma lista de TokenDocuments de dado. Brancos e pretos saem com cores próprias no Dice So Nice. */
async function rolarTokens(tokens) {
  const dados = (tokens ?? []).filter((t) => ehDado(t) && t.actor?.isOwner);
  if (!dados.length) return ui.notifications.warn("Fiasco: nenhum dado selecionado (ou você não é dono dele).");

  const brancos = dados.filter((t) => t.actor.system.cor === "branco");
  const pretos = dados.filter((t) => t.actor.system.cor === "preto");
  const termos = [];
  if (brancos.length) termos.push(`${brancos.length}d6[branco]`);
  if (pretos.length) termos.push(`${pretos.length}d6[preto]`);

  const roll = await new Roll(termos.join(" + ")).evaluate();
  let i = 0;
  const dieB = brancos.length ? roll.dice[i++] : null;
  const dieP = pretos.length ? roll.dice[i++] : null;
  if (dieB) dieB.options.appearance = APARENCIA_DSN.branco;
  if (dieP) dieP.options.appearance = APARENCIA_DSN.preto;

  if (ativo("diceSoNice") && game.dice3d) {
    try { await game.dice3d.showForRoll(roll, game.user, true); } catch (e) { console.warn(`${MOD} | Dice So Nice`, e); }
  }

  const resB = dieB?.results.map((r) => r.result) ?? [];
  const resP = dieP?.results.map((r) => r.result) ?? [];
  await Promise.all([
    ...brancos.map((t, k) => definirFace(t.actor, { valor: resB[k] })),
    ...pretos.map((t, k) => definirFace(t.actor, { valor: resP[k] }))
  ]);

  if (ativo("mensagemChat")) {
    const linha = (rot, cls, arr) => arr.length
      ? `<div class="fiasco-chat-linha"><b>${rot}:</b> ${arr.map((v) => `<span class="fiasco-pip ${cls}">${v}</span>`).join("")}</div>` : "";
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ user: game.user }),
      content: `<div class="fiasco-chat"><h3>Rolagem de dados</h3>${linha("Brancos", "branco", resB)}${linha("Pretos", "preto", resP)}</div>`
    });
  }
}

/** Rola os dados selecionados no canvas. */
function rolarSelecionados() {
  return rolarTokens(canvas.tokens.controlled.map((t) => t.document));
}

/** Rola todos os dados da cena atual. */
function rolarTodos() {
  return rolarTokens(canvas.scene?.tokens.filter((t) => ehDado(t)) ?? []);
}

/** Pega (ou cria) o ator base de uma cor. */
async function atorBase(cor) {
  const existente = game.actors.find((a) => a.type === TIPO_DADO && a.getFlag(MOD, "base") === cor);
  if (existente) return existente;
  const t = Number(ativo("tamanhoDado")) || 0.5;
  const src = face(cor, 1);
  return Actor.create({
    name: cor === "branco" ? "Dado Branco" : "Dado Preto",
    type: TIPO_DADO,
    img: src,
    system: { cor, valor: 1 },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    flags: { [MOD]: { base: cor } },
    prototypeToken: {
      name: cor === "branco" ? "Branco" : "Preto",
      actorLink: false,
      width: t, height: t,
      texture: { src },
      displayName: CONST.TOKEN_DISPLAY_MODES.NONE,
      displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
      disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
      lockRotation: false,
      sight: { enabled: false }
    }
  });
}

/** Cria o pool central: 4 dados por jogador, metade branco e metade preto. */
async function criarDados({ jogadores = 4, limpar = true } = {}) {
  if (!game.user.isGM) return ui.notifications.warn("Fiasco: só o GM pode criar os dados.");
  const scene = canvas.scene;
  if (!scene) return ui.notifications.warn("Fiasco: abra uma cena antes.");

  if (limpar) {
    const velhos = scene.tokens.filter((t) => ehDado(t)).map((t) => t.id);
    if (velhos.length) await scene.deleteEmbeddedDocuments("Token", velhos);
  }

  const porCor = jogadores * 2;
  const grid = canvas.dimensions.size;
  const r = canvas.dimensions.sceneRect;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const raio = grid * Math.max(1.5, jogadores * 0.6);
  const novos = [];

  for (const cor of ["branco", "preto"]) {
    const base = await atorBase(cor);
    for (let k = 0; k < porCor; k++) {
      const valor = Math.ceil(Math.random() * 6);
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.sqrt(Math.random()) * raio;
      const tam = (base.prototypeToken.width ?? 0.5) * grid;
      const doc = await base.getTokenDocument({
        x: Math.round(cx + Math.cos(ang) * dist - tam / 2),
        y: Math.round(cy + Math.sin(ang) * dist - tam / 2),
        rotation: Math.floor(Math.random() * 360)
      });
      const obj = doc.toObject();
      obj.texture.src = face(cor, valor);
      obj.delta = { system: { valor }, img: face(cor, valor) };
      novos.push(obj);
    }
  }
  await scene.createEmbeddedDocuments("Token", novos);
  ui.notifications.info(`Fiasco: ${porCor} brancos e ${porCor} pretos no centro da mesa.`);
}

async function dialogoCriarDados() {
  const res = await DialogV2.wait({
    window: { title: "Fiasco: Criar dados" },
    content: `
      <div class="fiasco-dialogo">
        <label>Número de jogadores <input type="number" name="jogadores" value="4" min="2" max="6"></label>
        <label class="check"><input type="checkbox" name="limpar" checked> Apagar dados que já estão na cena</label>
        <p class="hint">4 dados por jogador: metade branco, metade preto.</p>
      </div>`,
    buttons: [
      { action: "ok", label: "Criar", default: true,
        callback: (ev, btn) => ({ jogadores: Number(btn.form.elements.jogadores.value) || 4, limpar: btn.form.elements.limpar.checked }) },
      { action: "cancelar", label: "Cancelar" }
    ],
    rejectClose: false
  });
  if (res && typeof res === "object") return criarDados(res);
}

/* ------------------------------------------------------------------ */
/*  Fichas                                                             */
/* ------------------------------------------------------------------ */

async function trocarImagem(app) {
  const FP = FilePickerCls();
  return new FP({ type: "image", current: app.document.img, callback: (path) => app.document.update({ img: path }) }).browse();
}

function nomeAtor(id) {
  return id ? (game.actors.get(id)?.name ?? "?") : "";
}

class FichaJogador extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fiasco-mesa", "ficha-jogador"],
    position: { width: 620, height: 760 },
    window: { resizable: true },
    form: { submitOnChange: true },
    actions: {
      trocarImagem: function () { return trocarImagem(this); },
      contador: FichaJogador.#contador,
      abrirMapa: () => abrirMapa()
    }
  };

  static PARTS = { main: { template: `modules/${MOD}/templates/jogador.hbs`, scrollable: [".fiasco-corpo"] } };

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const a = this.document;
    const vizinhos = { "": "—" };
    for (const o of game.actors.filter((x) => x.type === TIPO_JOGADOR && x.id !== a.id)) vizinhos[o.id] = o.name;
    return Object.assign(ctx, {
      actor: a,
      system: a.system,
      vizinhos,
      esqNome: nomeAtor(a.system.esquerda.vizinho) || "Vizinho à esquerda",
      dirNome: nomeAtor(a.system.direita.vizinho) || "Vizinho à direita",
      mapaAtivo: ativo("mapa")
    });
  }

  static async #contador(event, target) {
    const campo = target.dataset.campo;
    const passo = Number(target.dataset.passo);
    const atual = foundry.utils.getProperty(this.document, `system.${campo}`) ?? 0;
    await this.document.update({ [`system.${campo}`]: Math.max(0, atual + passo) });
  }
}

class FichaDado extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fiasco-mesa", "ficha-dado"],
    position: { width: 340, height: "auto" },
    form: { submitOnChange: true },
    actions: {
      rolar: FichaDado.#rolar,
      valor: FichaDado.#valor,
      cor: FichaDado.#cor
    }
  };

  static PARTS = { main: { template: `modules/${MOD}/templates/dado.hbs` } };

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const s = this.document.system;
    return Object.assign(ctx, {
      actor: this.document,
      system: s,
      imagem: face(s.cor, s.valor),
      faces: [1, 2, 3, 4, 5, 6].map((v) => ({ v, src: face(s.cor, v), ativo: v === s.valor })),
      ehBranco: s.cor === "branco",
      ehToken: this.document.isToken
    });
  }

  static async #rolar() {
    const tok = this.document.token;
    if (tok) return rolarTokens([tok]);
    const v = Math.ceil(Math.random() * 6);
    return definirFace(this.document, { valor: v });
  }

  static async #valor(event, target) {
    return definirFace(this.document, { valor: Number(target.dataset.valor) });
  }

  static async #cor(event, target) {
    return definirFace(this.document, { cor: target.dataset.cor });
  }
}

/** Ficha reserva, usada quando a ficha personalizada está desligada. */
class FichaSimples extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fiasco-mesa", "ficha-simples"],
    position: { width: 360, height: "auto" },
    form: { submitOnChange: true },
    actions: { trocarImagem: function () { return trocarImagem(this); } }
  };
  static PARTS = { main: { template: `modules/${MOD}/templates/simples.hbs` } };
  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    return Object.assign(ctx, { actor: this.document });
  }
}

function registrarFichas() {
  SheetConfig.registerSheet(Actor, MOD, FichaSimples, {
    types: [TIPO_JOGADOR, TIPO_DADO], makeDefault: true, label: "Fiasco: Ficha simples"
  });
  if (ativo("fichaJogador")) {
    SheetConfig.registerSheet(Actor, MOD, FichaJogador, { types: [TIPO_JOGADOR], makeDefault: true, label: "Fiasco: Ficha de Jogador" });
  }
  if (ativo("fichaDado")) {
    SheetConfig.registerSheet(Actor, MOD, FichaDado, { types: [TIPO_DADO], makeDefault: true, label: "Fiasco: Ficha de Dado" });
  }
}

/* ------------------------------------------------------------------ */
/*  Mapa de relações                                                   */
/* ------------------------------------------------------------------ */

class MapaRelacoes extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MOD}-mapa`,
    classes: ["fiasco-mesa", "fiasco-mapa"],
    window: { title: "Fiasco: Mapa de Relações", resizable: true },
    position: { width: 680, height: 720 },
    actions: { abrirFicha: (ev, t) => game.actors.get(t.dataset.id)?.sheet.render(true) }
  };

  static PARTS = { main: { template: `modules/${MOD}/templates/mapa.hbs` } };

  async _prepareContext() {
    const jogadores = game.actors.filter((a) => a.type === TIPO_JOGADOR && a.visible);
    const n = jogadores.length;
    const C = 300, R = n > 1 ? 215 : 0;
    const pos = new Map();
    const nos = jogadores.map((a, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
      const x = C + R * Math.cos(ang), y = C + R * Math.sin(ang);
      pos.set(a.id, { x, y });
      return { id: a.id, nome: a.name, conceito: a.system.conceito, necessidade: a.system.necessidade, img: a.img, x, y };
    });

    const arestas = new Map();
    for (const a of jogadores) {
      for (const lado of ["esquerda", "direita"]) {
        const r = a.system[lado];
        if (!r.vizinho || !pos.has(r.vizinho)) continue;
        const chave = [a.id, r.vizinho].sort().join("|");
        const atual = arestas.get(chave);
        const relacao = r.relacao || atual?.relacao || "";
        const detalhes = new Set([...(atual?.detalhes ?? []), r.detalhe].filter(Boolean));
        const p1 = pos.get(a.id), p2 = pos.get(r.vizinho);
        arestas.set(chave, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2, relacao, detalhes: [...detalhes] });
      }
    }
    return { nos, arestas: [...arestas.values()].map((e) => ({ ...e, detalhe: e.detalhes.join(" · ") })), vazio: !n };
  }
}

let mapaApp = null;
function abrirMapa() {
  if (!ativo("mapa")) return ui.notifications.warn("Fiasco: o Mapa de Relações está desligado nas configurações.");
  mapaApp ??= new MapaRelacoes();
  return mapaApp.render(true);
}

/* ------------------------------------------------------------------ */
/*  Importador de playset                                              */
/* ------------------------------------------------------------------ */

const esc = (s) => foundry.utils.escapeHTML ? foundry.utils.escapeHTML(String(s ?? "")) : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const paragrafos = (txt) => String(txt ?? "").split(/\n\s*\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim())}</p>`).join("");

function htmlTabela(tab) {
  const cats = tab.categorias.map((c, i) => `
    <h2>${i + 1}. ${esc(c.nome)}</h2>
    <ol>${c.itens.map((it) => `<li>${esc(it)}</li>`).join("")}</ol>`).join("");
  return `<p><em>Escolha a categoria com um dado e o item com outro.</em></p>${cats}`;
}

function resultadoTabela(texto, faixa) {
  const tipo = CONST.TABLE_RESULT_TYPES?.TEXT ?? "text";
  const base = { type: tipo, range: faixa, weight: Math.max(1, faixa[1] - faixa[0] + 1) };
  if (GEN() >= 13) return { ...base, name: texto, description: texto };
  return { ...base, text: texto };
}

async function importarPlayset(dados) {
  if (!dados?.titulo || !Array.isArray(dados.tabelas)) throw new Error("Arquivo não parece um playset do Fiasco: Mesa.");
  const titulo = dados.titulo;

  const pastaJ = await Folder.create({ name: `Fiasco — ${titulo}`, type: "JournalEntry" });
  const pastaT = await Folder.create({ name: `Fiasco — ${titulo}`, type: "RollTable" });

  // Diário
  const paginas = [];
  const visao = [
    dados.subtitulo ? `<h2>${esc(dados.subtitulo)}</h2>` : "",
    paragrafos(dados.introducao),
    dados.regrasEspeciais?.length ? `<h2>Regras do playset</h2><ul>${dados.regrasEspeciais.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "",
    dados.movieNight ? `<h2>Movie Night</h2><p>${esc(dados.movieNight)}</p>` : "",
    dados.creditos ? `<hr><p class="fiasco-creditos"><small>${esc(dados.creditos)}</small></p>` : ""
  ].join("");
  paginas.push({ name: "Visão geral", type: "text", text: { content: visao } });
  for (const tab of dados.tabelas) paginas.push({ name: tab.nome, type: "text", text: { content: htmlTabela(tab) } });

  if (dados.preparacaoRapida?.length) {
    const html = dados.preparacaoRapida.map((sec) => `
      <h2>${esc(sec.tabela)}</h2>
      ${sec.grupos.map((g) => `<h3>${esc(g.rotulo)}</h3><ul>${g.itens.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("")}`).join("");
    paginas.push({ name: "Preparação rápida", type: "text", text: { content: html } });
  }
  for (const extra of dados.tabelasExtras ?? []) {
    const html = `${paragrafos(extra.descricao)}<table><thead><tr><th>Resultado</th><th>Efeito</th></tr></thead><tbody>${
      extra.resultados.map((r) => `<tr><td>${r.faixa[0] === r.faixa[1] ? r.faixa[0] : `${r.faixa[0]}–${r.faixa[1]}`}</td><td>${esc(r.texto)}</td></tr>`).join("")}</tbody></table>`;
    paginas.push({ name: extra.nome, type: "text", text: { content: html } });
  }

  const diario = await JournalEntry.create({
    name: `Playset: ${titulo}`, folder: pastaJ.id,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
    pages: paginas
  });

  // Tabelas 6x6: (1d6-1)*6 + 1d6 = 1..36, uniforme
  for (const tab of dados.tabelas) {
    const results = [];
    tab.categorias.forEach((c, ci) => c.itens.forEach((it, ii) => {
      const n = ci * 6 + ii + 1;
      results.push(resultadoTabela(`${c.nome} — ${it}`, [n, n]));
    }));
    await RollTable.create({
      name: `${titulo}: ${tab.nome}`, folder: pastaT.id,
      formula: "(1d6 - 1) * 6 + 1d6",
      description: `Categoria (1º dado) e item (2º dado) do playset ${titulo}.`,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      results
    });
  }
  for (const extra of dados.tabelasExtras ?? []) {
    await RollTable.create({
      name: `${titulo}: ${extra.nome}`, folder: pastaT.id,
      formula: extra.formula,
      description: extra.descricao ?? "",
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      results: extra.resultados.map((r) => resultadoTabela(r.texto, r.faixa))
    });
  }

  ui.notifications.info(`Fiasco: playset "${titulo}" importado.`);
  diario.sheet.render(true);
}

async function dialogoImportar() {
  const arquivo = await DialogV2.wait({
    window: { title: "Fiasco: Importar Playset" },
    content: `
      <div class="fiasco-dialogo">
        <p>Escolha o arquivo <b>.json</b> do playset. Ele cria um Diário com as tabelas e as Tabelas de Rolagem.</p>
        <input type="file" name="arquivo" accept=".json,application/json">
      </div>`,
    buttons: [
      { action: "ok", label: "Importar", default: true, callback: (ev, btn) => btn.form.elements.arquivo.files[0] ?? null },
      { action: "cancelar", label: "Cancelar" }
    ],
    rejectClose: false
  });
  if (!(arquivo instanceof File)) return;
  try {
    await importarPlayset(JSON.parse(await arquivo.text()));
  } catch (e) {
    console.error(e);
    ui.notifications.error(`Fiasco: falha ao importar — ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Botões na interface                                                */
/* ------------------------------------------------------------------ */

const elem = (html) => (html instanceof HTMLElement ? html : html?.[0]);

function inserirBotoes(html, id, botoes) {
  const root = elem(html);
  if (!root || root.querySelector(`#${id}`)) return;
  const alvo = root.querySelector(".header-actions") ?? root.querySelector("header");
  if (!alvo) return;
  const box = document.createElement("div");
  box.id = id;
  box.className = "fiasco-botoes";
  for (const b of botoes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<i class="${b.icone}"></i> ${b.rotulo}`;
    btn.addEventListener("click", (ev) => { ev.preventDefault(); b.acao(); });
    box.append(btn);
  }
  alvo.after(box);
}

function registrarHooksInterface() {
  Hooks.on("renderActorDirectory", (app, html) => {
    const botoes = [];
    if (game.user.isGM && ativo("criarDados")) {
      botoes.push({ rotulo: "Criar dados", icone: "fas fa-dice", acao: dialogoCriarDados });
      botoes.push({ rotulo: "Rolar todos", icone: "fas fa-dice-six", acao: rolarTodos });
    }
    if (ativo("mapa")) botoes.push({ rotulo: "Mapa", icone: "fas fa-diagram-project", acao: abrirMapa });
    if (botoes.length) inserirBotoes(html, `${MOD}-atores`, botoes);
  });

  Hooks.on("renderJournalDirectory", (app, html) => {
    if (!game.user.isGM || !ativo("importador")) return;
    inserirBotoes(html, `${MOD}-diarios`, [{ rotulo: "Importar Playset", icone: "fas fa-file-import", acao: dialogoImportar }]);
  });

  if (ativo("hudDado")) {
    Hooks.on("renderTokenHUD", (hud, html) => {
      const tok = hud.object?.document;
      if (!ehDado(tok)) return;
      const col = elem(html)?.querySelector(".col.right");
      if (!col) return;
      const btn = document.createElement("div");
      btn.className = "control-icon fiasco-hud-rolar";
      btn.title = "Rolar dados selecionados";
      btn.innerHTML = `<i class="fas fa-dice"></i>`;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        const sel = canvas.tokens.controlled.map((t) => t.document).filter(ehDado);
        rolarTokens(sel.length ? sel : [tok]);
      });
      col.append(btn);
    });
  }

  // Mapa se atualiza sozinho quando um jogador muda
  for (const h of ["createActor", "updateActor", "deleteActor"]) {
    Hooks.on(h, (actor) => { if (actor.type === TIPO_JOGADOR && mapaApp?.rendered) mapaApp.render(); });
  }

  // Jogadores novos ficam visíveis para todos (Observador), para o mapa funcionar
  Hooks.on("preCreateActor", (actor, data) => {
    if (actor.type !== TIPO_JOGADOR || data.ownership?.default !== undefined) return;
    actor.updateSource({ "ownership.default": CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER });
  });
}

/* ------------------------------------------------------------------ */
/*  Inicialização                                                      */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  registrarConfiguracoes();
  CONFIG.Actor.dataModels[TIPO_JOGADOR] = JogadorData;
  CONFIG.Actor.dataModels[TIPO_DADO] = DadoData;
  registrarFichas();
  registrarHooksInterface();

  const api = { criarDados, dialogoCriarDados, rolarSelecionados, rolarTodos, rolarTokens, abrirMapa, importarPlayset, dialogoImportar, definirFace };
  game.modules.get(MOD).api = api;
  globalThis.FiascoMesa = api;
});
