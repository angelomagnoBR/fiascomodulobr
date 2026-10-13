# Fiasco: Mesa

Módulo para jogar Fiasco Classic no Foundry VTT (v12 e v13), em qualquer sistema. Recomendado: mundo com **Simple Worldbuilding** + módulo **Dice So Nice**.

## Instalação
1. Copie a pasta `fiasco-mesa` para `Data/modules/` do seu Foundry.
2. Reinicie o Foundry, abra o mundo e ative **Fiasco: Mesa** em *Gerenciar Módulos*.

## O que vem no módulo

| Parte | Onde aparece |
|---|---|
| Ficha de Jogador | Botão **Novo jogador** no topo da aba Atores (o "Criar Ator" do Simple Worldbuilding não mostra esse tipo) |
| Ficha de Dado | Abre ao clicar num dado da mesa |
| Criar dados / Rolar todos | Botões no topo da aba **Atores** (só GM) |
| Mapa de Relações | Botão **Mapa** na aba Atores ou dentro da ficha |
| Botão de rolar no token | Clique direito no dado → ícone de dado |
| Importar Cenário | Botão no topo da aba **Diários** (só GM) |
| Escrever na mesa | Botão de **caneta** nos controles de Token, ou **Alt+T** |

## Ligar e desligar partes
*Configurações → Configurar Módulos → Fiasco: Mesa.* Cada parte tem uma caixa própria. Se desligar uma ficha, ela vira a **ficha simples**, sem quebrar nada. Algumas opções recarregam a página.

## Como montar a mesa
1. Crie a cena com a imagem de fundo, **sem grade visível**, e desligue visão de token e névoa.
2. Na aba Atores, clique em **Criar dados** e diga quantos jogadores. Saem 4 dados por jogador, metade branco e metade preto, espalhados no centro da cena.
3. Os dados ficam com permissão **Dono** para todos: qualquer jogador arrasta qualquer dado para a sua área.
4. Para rolar: selecione os dados (arraste uma caixa em volta) → clique direito → ícone de dado. Ou o GM usa **Rolar todos**.
5. Clique em **Novo jogador** (aba Atores) para cada pessoa e preencha os vizinhos. O mapa monta sozinho.

## Escrever na mesa
1. Clique na **caneta** (controles de Token, na barra da esquerda) ou aperte **Alt+T**.
2. Clique na mesa onde quer escrever. Abre uma janela com o texto, a **fonte**, a **cor** e o **tamanho**, com prévia ao vivo.
3. Clique em **Escrever**. O texto aparece para todos e fica salvo na cena.

Para **editar ou apagar**, ligue a caneta de novo e clique em cima do texto. Cada jogador edita os próprios textos; o GM edita todos. **Esc** cancela.

O módulo traz cinco fontes: Máquina de escrever (Special Elite), Caneta pincel (Permanent Marker), Letra de mão (Caveat), Cartaz (Alfa Slab One) e Faroeste (Rye). As fontes do Foundry e as que você adicionou também aparecem na lista. A janela lembra a última fonte, cor e tamanho que você usou.

Jogadores sem permissão de desenhar também podem escrever: o texto é criado pelo GM em nome deles, então **um GM precisa estar conectado**. Os textos são Desenhos comuns do Foundry, então o GM também pode movê-los pela camada de Desenhos.

## Dice So Nice
Brancos e pretos rolam com cores próprias e a face do token muda depois da animação. Para mudar as cores 3D, edite `APARENCIA_DSN` no topo de `scripts/fiasco.js`.

## Licenças das fontes
As fontes em `assets/fontes` são livres: Special Elite e Permanent Marker sob Apache 2.0; Caveat, Alfa Slab One e Rye sob SIL Open Font License 1.1. Os textos das licenças estão na mesma pasta.

## Macros (opcional)
Crie uma macro do tipo **Script** com uma destas linhas:

```js
FiascoMesa.rolarSelecionados();   // rola os dados selecionados
FiascoMesa.rolarTodos();          // rola todos os dados da cena
FiascoMesa.dialogoCriarDados();   // abre a janela de criar dados
FiascoMesa.abrirMapa();           // abre o mapa de relações
FiascoMesa.alternarEscrita();     // liga/desliga o modo de escrever na mesa
```

## Trocar as imagens dos dados
Coloque suas 12 imagens em qualquer pasta, com nomes `branco-1.png` … `preto-6.png`, e mude **Imagens das faces** nas configurações. Exemplo: `worlds/meu-mundo/dados/{cor}-{valor}.png`.

## Cenários (playsets)
O botão **Importar Cenário** lê um arquivo `.json` e cria:
- um **Diário** com Visão geral, as 4 tabelas e a Preparação rápida;
- 4 **Tabelas de Rolagem** (Relações, Necessidades, Locações, Objetos), cada uma com 36 resultados. A fórmula `(1d6 - 1) * 6 + 1d6` sorteia Categoria e Elemento de uma vez.

Para outro Cenário, mande o PDF para o Claude e peça o `.json` no formato `fiasco-mesa-playset-1`.

### Formato do arquivo
```json
{
  "formato": "fiasco-mesa-playset-1",
  "titulo": "Nome do Cenário",
  "subtitulo": "opcional",
  "introducao": "Parágrafos separados por linha em branco",
  "regrasEspeciais": ["opcional"],
  "movieNight": "opcional",
  "creditos": "opcional",
  "tabelas": [
    { "nome": "Relações", "categorias": [ { "nome": "Família", "itens": ["1", "2", "3", "4", "5", "6"] } ] }
  ],
  "preparacaoRapida": [
    { "tabela": "Relações", "grupos": [ { "rotulo": "Para três jogadores", "itens": ["..."] } ] }
  ],
  "tabelasExtras": [
    { "nome": "Exemplo", "formula": "1d6", "descricao": "opcional", "resultados": [ { "faixa": [1, 1], "texto": "..." } ] }
  ]
}
```
`tabelasExtras` serve para tabelas com outra fórmula. Sem `formula`, a tabela vai só para o Diário (como a Conclusão).

> Os Cenários são material com direitos autorais. Use os arquivos só no seu mundo, a partir de cópias que você comprou.
