/**
 * Fiasco: Mesa — módulo para Foundry VTT (v12/v13)
 * Ficha de jogador, ficha de dado, pool de dados com Dice So Nice e importador de Cenários.
 * Também permite escrever na mesa com fonte e cor à escolha, visível para todos.
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
  escrever:     { name: "Escrever na mesa", hint: "Botão de caneta nos controles de Token (e Alt+T): escreva na mesa, com fonte e cor à escolha, e todos veem.", type: Boolean, default: true, reload: true },
  importador:   { name: "Importador de Cenário", hint: "Mostra o botão 'Importar Cenário' na aba de Diários (só GM).", type: Boolean, default: true, reload: true },
  diceSoNice:   { name: "Usar Dice So Nice", hint: "Anima a rolagem em 3D com dados brancos e pretos (precisa do módulo Dice So Nice).", type: Boolean, default: true, reload: false },
  mensagemChat: { name: "Mensagem no chat", hint: "Mostra no chat o resultado de cada rolagem de dados.", type: Boolean, default: true, reload: false },
  tamanhoDado:  { name: "Tamanho do token de dado", hint: "Em quadrados da grade (ex.: 1 = um quadrado, 1.5 = um quadrado e meio). Muda na hora os dados que já estão na mesa.", type: Number, default: 1, reload: false, onChange: () => redimensionarDados() },
  facesCaminho: { name: "Imagens das faces", hint: "Caminho das faces. Use {cor} (branco/preto) e {valor} (1-6).", type: String, default: `modules/${MOD}/assets/dados/{cor}-{valor}.svg`, reload: false }
};

function registrarConfiguracoes() {
  for (const [key, o] of Object.entries(OPCOES)) {
    game.settings.register(MOD, key, {
      name: o.name, hint: o.hint, scope: "world", config: true,
      type: o.type, default: o.default, requiresReload: o.reload,
      ...(o.onChange ? { onChange: o.onChange } : {})
    });
  }
  game.settings.register(MOD, "ultimaEscrita", { scope: "client", config: false, type: Object, default: { ...PADRAO_ESCRITA } });
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

function tamanhoDado() {
  return Math.max(0.25, Number(ativo("tamanhoDado")) || 1);
}

/** Aplica o tamanho escolhido aos atores base e aos dados de todas as cenas (só o GM executa). */
async function redimensionarDados() {
  if (!game.user.isGM) return;
  const t = tamanhoDado();
  for (const a of game.actors.filter((x) => x.type === TIPO_DADO)) {
    await a.update({ "prototypeToken.width": t, "prototypeToken.height": t });
  }
  for (const scene of game.scenes) {
    const upd = scene.tokens.filter((tk) => ehDado(tk)).map((tk) => {
      const grid = scene.grid.size;
      const dx = ((tk.width - t) * grid) / 2;
      return { _id: tk.id, width: t, height: t, x: Math.round(tk.x + dx), y: Math.round(tk.y + dx) };
    });
    if (upd.length) await scene.updateEmbeddedDocuments("Token", upd);
  }
  ui.notifications.info(`Fiasco: dados redimensionados para ${t}.`);
}

/** Pega (ou cria) o ator base de uma cor. */
async function atorBase(cor) {
  const existente = game.actors.find((a) => a.type === TIPO_DADO && a.getFlag(MOD, "base") === cor);
  if (existente) return existente;
  const t = tamanhoDado();
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
      const tam = tamanhoDado() * grid;
      const doc = await base.getTokenDocument({
        x: Math.round(cx + Math.cos(ang) * dist - tam / 2),
        y: Math.round(cy + Math.sin(ang) * dist - tam / 2),
        rotation: Math.floor(Math.random() * 360)
      });
      const obj = doc.toObject();
      obj.width = obj.height = tamanhoDado();
      obj.texture.src = face(cor, valor);
      obj.delta = { system: { valor }, img: face(cor, valor) };
      novos.push(obj);
    }
  }
  await scene.createEmbeddedDocuments("Token", novos);
  ui.notifications.info(`Fiasco: ${porCor} brancos e ${porCor} pretos no centro da mesa.`);
}

/**
 * Cria um ator do tipo Fiasco: Jogador direto pelo código.
 * Necessário porque o Simple Worldbuilding troca a janela "Criar Ator"
 * por uma que só lista templates dele, escondendo os tipos do módulo.
 */
async function criarJogador(nome = "Novo jogador") {
  if (!game.user.isGM && !game.user.can("ACTOR_CREATE")) {
    return ui.notifications.warn("Fiasco: você não tem permissão para criar atores.");
  }
  const actor = await Actor.create({
    name: nome || "Novo jogador",
    type: TIPO_JOGADOR,
    img: "icons/svg/mystery-man.svg",
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
  });
  actor?.sheet.render(true);
  return actor;
}

async function dialogoCriarJogador() {
  const nome = await DialogV2.wait({
    window: { title: "Fiasco: Novo jogador" },
    content: `
      <div class="fiasco-dialogo">
        <label>Nome do personagem <input type="text" name="nome" placeholder="Ex.: Adamastor Moreira" autofocus></label>
      </div>`,
    buttons: [
      { action: "ok", label: "Criar", default: true, callback: (ev, btn) => btn.form.elements.nome.value.trim() || "Novo jogador" },
      { action: "cancelar", label: "Cancelar" }
    ],
    rejectClose: false
  });
  if (typeof nome === "string" && nome !== "cancelar") return criarJogador(nome);
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
    position: { width: 600, height: 620 },
    window: { resizable: true },
    form: { submitOnChange: true },
    actions: {
      trocarImagem: function () { return trocarImagem(this); },
      contador: FichaJogador.#contador,
      aba: FichaJogador.#aba,
      abrirMapa: () => abrirMapa()
    }
  };

  static PARTS = { main: { template: `modules/${MOD}/templates/jogador.hbs`, scrollable: [".fiasco-aba"] } };

  /** Aba aberta; fica guardada enquanto a janela existir. */
  _aba = "relacoes";

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
      mapaAtivo: ativo("mapa"),
      aba: { relacoes: this._aba === "relacoes", elementos: this._aba === "elementos", notas: this._aba === "notas" }
    });
  }

  /** Troca de aba sem redesenhar a ficha. */
  static #aba(event, target) {
    this._aba = target.dataset.aba;
    const root = this.element;
    root.querySelectorAll("[data-action='aba']").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === this._aba));
    root.querySelectorAll(".fiasco-aba").forEach((sec) => sec.classList.toggle("ativa", sec.dataset.aba === this._aba));
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
/*  Importador de Cenário                                              */
/* ------------------------------------------------------------------ */

const esc = (s) => foundry.utils.escapeHTML ? foundry.utils.escapeHTML(String(s ?? "")) : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const paragrafos = (txt) => String(txt ?? "").split(/\n\s*\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim())}</p>`).join("");

function htmlTabela(tab) {
  const cats = tab.categorias.map((c, i) => `
    <h2>${i + 1}. ${esc(c.nome)}</h2>
    <ol>${c.itens.map((it) => `<li>${esc(it)}</li>`).join("")}</ol>`).join("");
  return `<p><em>Escolha a Categoria com um dado e o Elemento com outro.</em></p>${cats}`;
}

function resultadoTabela(texto, faixa) {
  const tipo = CONST.TABLE_RESULT_TYPES?.TEXT ?? "text";
  const base = { type: tipo, range: faixa, weight: Math.max(1, faixa[1] - faixa[0] + 1) };
  if (GEN() >= 13) return { ...base, name: texto, description: texto };
  return { ...base, text: texto };
}

/**
 * Importa um Cenário. Sem pasta-mãe, cria "Fiasco — <título>" na raiz;
 * com pasta-mãe (vindo de um pacote), cria a subpasta "<título>" dentro dela.
 */
async function importarPlayset(dados, { maeJ = null, maeT = null, abrir = true } = {}) {
  if (!dados?.titulo || !Array.isArray(dados.tabelas)) throw new Error("Arquivo não parece um Cenário do Fiasco: Mesa.");
  const titulo = dados.titulo;
  const nomePasta = maeJ ? titulo : `Fiasco — ${titulo}`;

  const pastaJ = await Folder.create({ name: nomePasta, type: "JournalEntry", folder: maeJ?.id ?? null });
  const pastaT = await Folder.create({ name: nomePasta, type: "RollTable", folder: maeT?.id ?? null });

  // Diário
  const paginas = [];
  const visao = [
    dados.subtitulo ? `<h2>${esc(dados.subtitulo)}</h2>` : "",
    paragrafos(dados.introducao),
    dados.regrasEspeciais?.length ? `<h2>Regras do Cenário</h2><ul>${dados.regrasEspeciais.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "",
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
      extra.resultados.map((r) => `<tr><td>${r.faixa[0] === r.faixa[1] ? r.faixa[0] : r.faixa[1] >= 99 ? `${r.faixa[0]}+` : `${r.faixa[0]}–${r.faixa[1]}`}</td><td>${esc(r.texto)}</td></tr>`).join("")}</tbody></table>`;
    paginas.push({ name: extra.nome, type: "text", text: { content: html } });
  }

  const diario = await JournalEntry.create({
    name: `Cenário: ${titulo}`, folder: pastaJ.id,
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
      description: `Categoria (1º dado) e Elemento (2º dado) do Cenário ${titulo}.`,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      results
    });
  }
  for (const extra of dados.tabelasExtras ?? []) {
    if (!extra.formula) continue; // tabela só de consulta (ex.: Conclusão): fica apenas no Diário
    await RollTable.create({
      name: `${titulo}: ${extra.nome}`, folder: pastaT.id,
      formula: extra.formula,
      description: extra.descricao ?? "",
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      results: extra.resultados.map((r) => resultadoTabela(r.texto, r.faixa))
    });
  }

  if (abrir) {
    ui.notifications.info(`Fiasco: Cenário "${titulo}" importado.`);
    diario.sheet.render(true);
  }
  return diario;
}

/** Monta uma página de diário a partir de blocos { titulo, paragrafos[], lista[] }. */
function htmlBlocos(blocos = []) {
  return blocos.map((b) => [
    b.titulo ? `<h2>${esc(b.titulo)}</h2>` : "",
    (b.paragrafos ?? []).map((t) => `<p>${esc(t)}</p>`).join(""),
    b.lista?.length ? `<ul>${b.lista.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""
  ].join("")).join("");
}

/**
 * Importa um pacote: vários Cenários + diários avulsos (ex.: resumo das regras),
 * tudo dentro da pasta "Fiasco — <título do pacote>".
 */
async function importarPacote(pacote) {
  const titulo = pacote.titulo || "Pacote";
  const maeJ = await Folder.create({ name: `Fiasco — ${titulo}`, type: "JournalEntry" });
  const maeT = await Folder.create({ name: `Fiasco — ${titulo}`, type: "RollTable" });

  let primeiro = null;
  for (const d of pacote.diarios ?? []) {
    const j = await JournalEntry.create({
      name: d.nome, folder: maeJ.id,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      pages: (d.paginas ?? []).map((pg) => ({ name: pg.nome, type: "text", text: { content: htmlBlocos(pg.blocos) } }))
    });
    primeiro ??= j;
  }
  for (const c of pacote.cenarios ?? []) await importarPlayset(c, { maeJ, maeT, abrir: false });

  ui.notifications.info(`Fiasco: pacote "${titulo}" importado (${(pacote.cenarios ?? []).length} Cenários).`);
  primeiro?.sheet.render(true);
}

/** Decide se o arquivo é um Cenário avulso ou um pacote. */
function importarArquivo(dados) {
  return Array.isArray(dados?.cenarios) ? importarPacote(dados) : importarPlayset(dados);
}

async function dialogoImportar() {
  const arquivo = await DialogV2.wait({
    window: { title: "Fiasco: Importar Cenário" },
    content: `
      <div class="fiasco-dialogo">
        <p>Escolha o arquivo <b>.json</b> de um Cenário ou de um pacote (vários Cenários). Ele cria os Diários e as Tabelas de Rolagem.</p>
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
    await importarArquivo(JSON.parse(await arquivo.text()));
  } catch (e) {
    console.error(e);
    ui.notifications.error(`Fiasco: falha ao importar — ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Escrever na mesa                                                   */
/* ------------------------------------------------------------------ */

/* Fontes que vêm com o módulo (licenças em assets/fontes). */
const FONTES_MESA = {
  "Special Elite":    { arquivo: "special-elite",    rotulo: "Máquina de escrever" },
  "Permanent Marker": { arquivo: "permanent-marker", rotulo: "Caneta pincel" },
  "Caveat":           { arquivo: "caveat",           rotulo: "Letra de mão" },
  "Alfa Slab One":    { arquivo: "alfa-slab-one",    rotulo: "Cartaz" },
  "Rye":              { arquivo: "rye",              rotulo: "Faroeste" }
};

const CORES_MESA = [
  { cor: "#efe5cf", nome: "Creme" },
  { cor: "#ffffff", nome: "Branco" },
  { cor: "#1b1b1b", nome: "Preto" },
  { cor: "#d0342c", nome: "Vermelho" },
  { cor: "#e8a92e", nome: "Mostarda" },
  { cor: "#8fc1e3", nome: "Azul" }
];

const SOCKET = `module.${MOD}`;
const PADRAO_ESCRITA = { fonte: "Special Elite", cor: "#efe5cf", tamanho: 48 };

function registrarFontes() {
  CONFIG.fontDefinitions ??= {};
  for (const [familia, f] of Object.entries(FONTES_MESA)) {
    if (CONFIG.fontDefinitions[familia]) continue;
    CONFIG.fontDefinitions[familia] = { editor: true, fonts: [{ urls: [`modules/${MOD}/assets/fontes/${f.arquivo}.woff2`] }] };
  }
}

/** Garante a fonte carregada no navegador (para medir e para a prévia). */
async function carregarFonte(familia, tamanho = 32) {
  try { await document.fonts.load(`${tamanho}px "${familia}"`); } catch { /* segue com a fonte reserva */ }
}

const ehTexto = (d) => !!d?.getFlag?.(MOD, "texto");
const autorId = (d) => d?.author?.id ?? d?._source?.author ?? d?.author;
const gmAtivo = () => game.users.activeGM ?? game.users.find((u) => u.isGM && u.active);
const podeDesenhar = () => game.user.isGM || game.user.can("DRAWING_CREATE");

function ultimaEscrita() {
  try { return { ...PADRAO_ESCRITA, ...game.settings.get(MOD, "ultimaEscrita") }; } catch { return { ...PADRAO_ESCRITA }; }
}

/** Calcula o tamanho da caixa para o texto não quebrar linha. */
function medirTexto(texto, fonte, tamanho) {
  const style = new PIXI.TextStyle({ fontFamily: fonte, fontSize: tamanho });
  const m = PIXI.TextMetrics.measureText(texto, style);
  return { w: Math.ceil(m.width + tamanho * 0.8), h: Math.ceil(m.height + tamanho * 0.5) };
}

/** Monta os dados do Desenho de texto, centrado no ponto (cx, cy). */
function dadosDesenho({ texto, fonte, cor, tamanho }, cx, cy) {
  const { w, h } = medirTexto(texto, fonte, tamanho);
  return {
    x: Math.round(cx - w / 2), y: Math.round(cy - h / 2),
    shape: { type: "r", width: w, height: h },
    text: texto, fontFamily: fonte, fontSize: tamanho, textColor: cor, textAlpha: 1,
    fillType: CONST.DRAWING_FILL_TYPES.NONE, strokeWidth: 0, strokeAlpha: 0
  };
}

/* Quem não tem permissão de desenhar pede ao GM conectado, que cria o texto em nome dele. */
function pedirAoGM(acao, dados) {
  if (!gmAtivo()) return ui.notifications.warn("Fiasco: é preciso um GM conectado para escrever na mesa.");
  game.socket.emit(SOCKET, { acao, dados, usuario: game.user.id, cena: canvas.scene.id });
}

const CAMPOS_TEXTO = ["x", "y", "shape", "text", "fontFamily", "fontSize", "textColor", "textAlpha", "fillType", "strokeWidth", "strokeAlpha"];
const filtrar = (d) => Object.fromEntries(CAMPOS_TEXTO.filter((k) => k in d).map((k) => [k, d[k]]));

function registrarSocket() {
  game.socket.on(SOCKET, async (msg) => {
    if (!game.user.isGM || gmAtivo()?.id !== game.user.id) return;
    const scene = game.scenes.get(msg.cena);
    if (!scene || !game.users.get(msg.usuario)) return;
    if (msg.acao === "criarTexto") {
      await scene.createEmbeddedDocuments("Drawing", [{ ...filtrar(msg.dados), author: msg.usuario, flags: { [MOD]: { texto: true } } }]);
      return;
    }
    const doc = scene.drawings.get(msg.dados?._id);
    if (!ehTexto(doc) || autorId(doc) !== msg.usuario) return;
    if (msg.acao === "editarTexto") await doc.update(filtrar(msg.dados));
    if (msg.acao === "apagarTexto") await doc.delete();
  });
}

async function criarTexto(dados) {
  if (!podeDesenhar()) return pedirAoGM("criarTexto", dados);
  await canvas.scene.createEmbeddedDocuments("Drawing", [{ ...dados, author: game.user.id, flags: { [MOD]: { texto: true } } }]);
}

async function editarTexto(doc, dados) {
  if (podeDesenhar() && doc.isOwner) return doc.update(dados);
  pedirAoGM("editarTexto", { ...dados, _id: doc.id });
}

async function apagarTexto(doc) {
  if (podeDesenhar() && doc.isOwner) return doc.delete();
  pedirAoGM("apagarTexto", { _id: doc.id });
}

/** Janela de escrever/editar, com prévia ao vivo. */
async function dialogoTexto(existente) {
  const base = existente
    ? { texto: existente.text, fonte: existente.fontFamily, cor: existente.textColor?.css ?? String(existente.textColor), tamanho: existente.fontSize }
    : { texto: "", ...ultimaEscrita() };

  const nossas = Object.entries(FONTES_MESA)
    .map(([f, o]) => `<option value="${f}" ${f === base.fonte ? "selected" : ""}>${o.rotulo} (${f})</option>`).join("");
  const outras = Object.keys(CONFIG.fontDefinitions ?? {}).filter((f) => !FONTES_MESA[f]).sort()
    .map((f) => `<option value="${esc(f)}" ${f === base.fonte ? "selected" : ""}>${esc(f)}</option>`).join("");
  const amostras = CORES_MESA
    .map((c) => `<button type="button" class="fiasco-amostra" data-cor="${c.cor}" title="${c.nome}" style="background:${c.cor}"></button>`).join("");

  const content = `
    <div class="fiasco-dialogo fiasco-escrita">
      <textarea name="texto" rows="3" placeholder="Escreva aqui. Enter quebra a linha." autofocus>${esc(base.texto)}</textarea>
      <label>Fonte
        <select name="fonte"><optgroup label="Fiasco">${nossas}</optgroup>${outras ? `<optgroup label="Outras">${outras}</optgroup>` : ""}</select>
      </label>
      <div class="fiasco-linha">
        <label>Cor <input type="color" name="cor" value="${base.cor}"></label>
        <div class="fiasco-amostras">${amostras}</div>
      </div>
      <label>Tamanho <span class="fiasco-tam-valor">${base.tamanho}</span>
        <input type="range" name="tamanho" min="12" max="200" step="2" value="${base.tamanho}">
      </label>
      <div class="fiasco-previa"><span></span></div>
    </div>`;

  const ler = (form) => ({
    texto: form.elements.texto.value.replace(/\s+$/, ""),
    fonte: form.elements.fonte.value,
    cor: form.elements.cor.value,
    tamanho: Number(form.elements.tamanho.value) || 48
  });

  const buttons = [{ action: "ok", label: existente ? "Salvar" : "Escrever", icon: "fas fa-pen-nib", default: true, callback: (ev, btn) => ler(btn.form) }];
  if (existente) buttons.push({ action: "apagar", label: "Apagar", icon: "fas fa-trash" });
  buttons.push({ action: "cancelar", label: "Cancelar" });

  for (const f of Object.keys(FONTES_MESA)) carregarFonte(f);

  return DialogV2.wait({
    window: { title: existente ? "Fiasco: Editar texto" : "Fiasco: Escrever na mesa" },
    position: { width: 420 },
    content,
    buttons,
    rejectClose: false,
    render: (event, arg) => {
      const root = arg instanceof HTMLElement ? arg : arg?.element;
      const form = root?.querySelector("form") ?? root;
      if (!form?.elements?.texto) return;
      const previa = root.querySelector(".fiasco-previa span");
      const tamValor = root.querySelector(".fiasco-tam-valor");
      const atualizar = () => {
        const v = ler(form);
        previa.textContent = v.texto || "Seu texto aqui";
        previa.style.fontFamily = `"${v.fonte}", sans-serif`;
        previa.style.color = v.cor;
        previa.style.fontSize = `${Math.min(v.tamanho, 64)}px`;
        tamValor.textContent = v.tamanho;
      };
      form.addEventListener("input", atualizar);
      form.elements.fonte.addEventListener("change", async () => { await carregarFonte(form.elements.fonte.value); atualizar(); });
      root.querySelectorAll(".fiasco-amostra").forEach((b) => b.addEventListener("click", () => { form.elements.cor.value = b.dataset.cor; atualizar(); }));
      carregarFonte(base.fonte).then(atualizar);
      atualizar();
    }
  });
}

/** Abre a janela no ponto clicado: edita o texto que está ali (se for seu) ou cria um novo. */
async function escreverEm(ponto) {
  const alvo = canvas.scene.drawings.contents.filter((d) => ehTexto(d)
    && (game.user.isGM || autorId(d) === game.user.id)
    && ponto.x >= d.x && ponto.x <= d.x + d.shape.width && ponto.y >= d.y && ponto.y <= d.y + d.shape.height).pop();

  const res = await dialogoTexto(alvo);
  if (res === "apagar" && alvo) return apagarTexto(alvo);
  if (!res || typeof res !== "object") return;
  if (!res.texto.trim()) return ui.notifications.warn("Fiasco: o texto está vazio.");

  await game.settings.set(MOD, "ultimaEscrita", { fonte: res.fonte, cor: res.cor, tamanho: res.tamanho });
  await carregarFonte(res.fonte, res.tamanho);

  if (alvo) {
    const cx = alvo.x + alvo.shape.width / 2, cy = alvo.y + alvo.shape.height / 2;
    return editarTexto(alvo, dadosDesenho(res, cx, cy));
  }
  return criarTexto(dadosDesenho(res, ponto.x, ponto.y));
}

/* Modo escrita: o próximo clique na mesa abre a janela. Esc cancela. */
let modoEscrita = false;
let avisoEscrita = null;

function alternarEscrita(ligar = !modoEscrita) {
  if (ligar && !canvas.ready) return ui.notifications.warn("Fiasco: abra uma cena antes.");
  modoEscrita = ligar;
  document.body.classList.toggle("fiasco-escrevendo", ligar);
  avisoEscrita?.remove();
  avisoEscrita = null;
  if (ligar) {
    avisoEscrita = document.createElement("div");
    avisoEscrita.className = "fiasco-aviso-escrita";
    avisoEscrita.innerHTML = `<i class="fas fa-pen-nib"></i> Clique na mesa onde quer escrever, ou num texto seu para editar. <b>Esc</b> cancela.`;
    document.body.append(avisoEscrita);
  }
}

function registrarModoEscrita() {
  document.addEventListener("pointerdown", (ev) => {
    if (!modoEscrita || ev.button !== 0 || !canvas.ready || ev.target !== canvas.app.view) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const ponto = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
    alternarEscrita(false);
    escreverEm(ponto);
  }, true);

  document.addEventListener("keydown", (ev) => {
    if (modoEscrita && ev.key === "Escape") alternarEscrita(false);
  }, true);

  Hooks.on("canvasTearDown", () => { if (modoEscrita) alternarEscrita(false); });

  // Botão na barra de controles de Tokens (v12: lista; v13: objeto)
  Hooks.on("getSceneControlButtons", (controls) => {
    const tool = { name: "fiascoEscrever", title: "Escrever na mesa (Alt+T)", icon: "fas fa-pen-nib", button: true };
    if (Array.isArray(controls)) {
      controls.find((c) => c.name === "token")?.tools.push({ ...tool, onClick: () => alternarEscrita() });
    } else {
      const grupo = controls.tokens ?? controls.token;
      if (grupo?.tools) grupo.tools.fiascoEscrever = { ...tool, order: Object.keys(grupo.tools).length + 1, onChange: () => alternarEscrita() };
    }
  });

  game.keybindings.register(MOD, "escrever", {
    name: "Escrever na mesa",
    hint: "Liga o modo de escrita: o próximo clique na mesa abre a janela de texto.",
    editable: [{ key: "KeyT", modifiers: ["Alt"] }],
    onDown: () => { alternarEscrita(); return true; }
  });
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
    if (game.user.isGM) botoes.push({ rotulo: "Novo jogador", icone: "fas fa-user-plus", acao: dialogoCriarJogador });
    if (game.user.isGM && ativo("criarDados")) {
      botoes.push({ rotulo: "Criar dados", icone: "fas fa-dice", acao: dialogoCriarDados });
      botoes.push({ rotulo: "Rolar todos", icone: "fas fa-dice-six", acao: rolarTodos });
    }
    if (ativo("mapa")) botoes.push({ rotulo: "Mapa", icone: "fas fa-diagram-project", acao: abrirMapa });
    if (botoes.length) inserirBotoes(html, `${MOD}-atores`, botoes);
  });

  Hooks.on("renderJournalDirectory", (app, html) => {
    if (!game.user.isGM || !ativo("importador")) return;
    inserirBotoes(html, `${MOD}-diarios`, [{ rotulo: "Importar Cenário", icone: "fas fa-file-import", acao: dialogoImportar }]);
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
  registrarFontes();
  if (ativo("escrever")) registrarModoEscrita();

  const api = { alternarEscrita, escreverEm, redimensionarDados, criarJogador, dialogoCriarJogador, criarDados, dialogoCriarDados, rolarSelecionados, rolarTodos, rolarTokens, abrirMapa, importarPlayset, importarPacote, importarArquivo, dialogoImportar, definirFace };
  game.modules.get(MOD).api = api;
  globalThis.FiascoMesa = api;
});

Hooks.once("ready", () => {
  if (ativo("escrever")) registrarSocket();
  for (const f of Object.keys(FONTES_MESA)) carregarFonte(f);
});

/* Ao abrir o mundo, o GM ajusta dados com tamanho diferente do configurado. */
Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  const t = tamanhoDado();
  const fora = game.scenes.some((s) => s.tokens.some((tk) => ehDado(tk) && tk.width !== t))
    || game.actors.some((a) => a.type === TIPO_DADO && a.prototypeToken.width !== t);
  if (fora) redimensionarDados();
});
