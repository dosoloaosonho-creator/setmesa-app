'use strict'

const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

/**
 * O BANCO DO SET MESA NUVEM.
 *
 * Arquivo PRÓPRIO, separado do banco de licenças. É a mesma regra que o Michel
 * fixou desde o começo: um arquivo por assunto, para um projeto não derrubar o
 * outro. Aqui mora a operação dos restaurantes (mesas, comandas, dinheiro do
 * turno); lá mora o faturamento (quem comprou quantos créditos).
 *
 * MULTI-RESTAURANTE DESDE A PRIMEIRA LINHA: toda tabela carrega `contaId`, e
 * toda consulta filtra por ele. Não existe leitura sem dono. É o que impede um
 * restaurante enxergar a mesa do outro — e arrumar isso depois seria reescrever
 * tudo.
 */

const CAMINHO = process.env.BANCO_NUVEM ||
  path.join(__dirname, '..', '..', 'dados', 'setmesa-nuvem.db')

fs.mkdirSync(path.dirname(CAMINHO), { recursive: true })

const bd = new Database(CAMINHO)
bd.pragma('journal_mode = WAL')
bd.pragma('foreign_keys = ON')

bd.exec(`
  CREATE TABLE IF NOT EXISTS contas (
    id            TEXT PRIMARY KEY,
    nome          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE,
    senhaHash     TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    restaurante   TEXT    NOT NULL DEFAULT '',
    instalacaoId  TEXT    NOT NULL,
    vendas        INTEGER NOT NULL DEFAULT 0,
    criadoEm      INTEGER NOT NULL,
    ultimoAcesso  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token     TEXT PRIMARY KEY,
    contaId   TEXT    NOT NULL,
    criadoEm  INTEGER NOT NULL,
    expiraEm  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessoes_conta ON sessoes(contaId);

  CREATE TABLE IF NOT EXISTS categorias (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    contaId  TEXT    NOT NULL,
    nome     TEXT    NOT NULL,
    ordem    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_categorias_conta ON categorias(contaId, ordem);

  CREATE TABLE IF NOT EXISTS itens (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    contaId        TEXT    NOT NULL,
    categoriaId    INTEGER NOT NULL,
    nome           TEXT    NOT NULL,
    precoCentavos  INTEGER NOT NULL DEFAULT 0,
    ativo          INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_itens_conta ON itens(contaId, categoriaId);

  CREATE TABLE IF NOT EXISTS mesas (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    contaId  TEXT    NOT NULL,
    nome     TEXT    NOT NULL,
    ativo    INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_mesas_conta ON mesas(contaId);

  CREATE TABLE IF NOT EXISTS comandas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    contaId    TEXT    NOT NULL,
    mesaId     INTEGER NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'ABERTA',
    abertaEm   INTEGER NOT NULL,
    fechadaEm  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_comandas_conta ON comandas(contaId, status);

  CREATE TABLE IF NOT EXISTS pedidos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    contaId        TEXT    NOT NULL,
    comandaId      INTEGER NOT NULL,
    itemId         INTEGER NOT NULL DEFAULT 0,
    nome           TEXT    NOT NULL,
    precoCentavos  INTEGER NOT NULL DEFAULT 0,
    quantidade     INTEGER NOT NULL DEFAULT 1,
    cliente        TEXT    NOT NULL DEFAULT '',
    criadoEm       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pedidos_comanda ON pedidos(contaId, comandaId);

  CREATE TABLE IF NOT EXISTS pagamentos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    contaId        TEXT    NOT NULL,
    comandaId      INTEGER NOT NULL,
    valorCentavos  INTEGER NOT NULL,
    forma          TEXT    NOT NULL DEFAULT 'DINHEIRO',
    cliente        TEXT    NOT NULL DEFAULT '',
    criadoEm       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pagamentos_conta ON pagamentos(contaId, criadoEm DESC);
`)

const agora = () => Date.now()

/**
 * A FOLGA DE CENTAVOS.
 *
 * Dividir 33,33 por três dá 11,11 três vezes, e sobra um centavo que ninguém
 * vai pagar. Sem essa folga a comanda nunca fecha e o garçom fica preso na
 * tela. É a mesma regra do app.
 */
const FOLGA_DE_CENTAVOS = 5

// ---------------------------------------------------------------------------
// CONTAS
// ---------------------------------------------------------------------------

function criarConta (c) {
  bd.prepare(
    `INSERT INTO contas (id, nome, email, senhaHash, salt, restaurante, instalacaoId, criadoEm)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(c.id, c.nome, c.email, c.senhaHash, c.salt, c.restaurante || '', c.instalacaoId, agora())
  return contaPorId(c.id)
}

const contaPorId = id => bd.prepare('SELECT * FROM contas WHERE id = ?').get(id) || null
const contaPorEmail = email =>
  bd.prepare('SELECT * FROM contas WHERE email = ?').get(String(email).trim().toLowerCase()) || null

function marcarAcesso (contaId) {
  bd.prepare('UPDATE contas SET ultimoAcesso = ? WHERE id = ?').run(agora(), contaId)
}

function salvarRestaurante (contaId, nome) {
  bd.prepare('UPDATE contas SET restaurante = ? WHERE id = ?').run(String(nome || ''), contaId)
  return contaPorId(contaId)
}

// ---------------------------------------------------------------------------
// SESSÕES
//
// Ficam no banco, não na memória: o Michel reinicia o servidor quando sobe uma
// versão nova, e ninguém quer o salão inteiro sendo deslogado no meio do turno
// por causa de um deploy.
// ---------------------------------------------------------------------------

function abrirSessao (token, contaId, horas) {
  const ate = agora() + horas * 3600 * 1000
  bd.prepare('INSERT INTO sessoes (token, contaId, criadoEm, expiraEm) VALUES (?,?,?,?)')
    .run(token, contaId, agora(), ate)
  return ate
}

function sessaoValida (token) {
  if (!token) return null
  const s = bd.prepare('SELECT * FROM sessoes WHERE token = ?').get(token)
  if (!s) return null
  if (s.expiraEm < agora()) { fecharSessao(token); return null }
  return s
}

const fecharSessao = token => bd.prepare('DELETE FROM sessoes WHERE token = ?').run(token)

/** Varre o lixo de sessão vencida. Roda de hora em hora, não a cada pedido. */
const limparSessoes = () => bd.prepare('DELETE FROM sessoes WHERE expiraEm < ?').run(agora())

// ---------------------------------------------------------------------------
// CARDÁPIO E MESAS
// ---------------------------------------------------------------------------

function criarCategoria (contaId, nome) {
  const ordem = bd.prepare('SELECT COUNT(*) n FROM categorias WHERE contaId = ?').get(contaId).n
  const r = bd.prepare('INSERT INTO categorias (contaId, nome, ordem) VALUES (?,?,?)')
    .run(contaId, String(nome).trim(), ordem)
  return bd.prepare('SELECT * FROM categorias WHERE id = ?').get(r.lastInsertRowid)
}

const categoriasDe = contaId =>
  bd.prepare('SELECT * FROM categorias WHERE contaId = ? ORDER BY ordem, id').all(contaId)

function criarItem (contaId, categoriaId, nome, precoCentavos) {
  const cat = bd.prepare('SELECT * FROM categorias WHERE id = ? AND contaId = ?')
    .get(categoriaId, contaId)
  if (!cat) throw new Error('Categoria não é desta conta.')
  const r = bd.prepare(
    'INSERT INTO itens (contaId, categoriaId, nome, precoCentavos) VALUES (?,?,?,?)'
  ).run(contaId, categoriaId, String(nome).trim(), Math.max(0, Math.floor(precoCentavos)))
  return bd.prepare('SELECT * FROM itens WHERE id = ?').get(r.lastInsertRowid)
}

const itensDe = contaId =>
  bd.prepare('SELECT * FROM itens WHERE contaId = ? AND ativo = 1 ORDER BY categoriaId, nome').all(contaId)

/**
 * Item sai do cardápio, mas não some do histórico: vira inativo. Apagar de
 * verdade quebraria a conta de ontem, que já tem esse item lançado.
 */
const desativarItem = (contaId, id) =>
  bd.prepare('UPDATE itens SET ativo = 0 WHERE id = ? AND contaId = ?').run(id, contaId)

function criarMesa (contaId, nome) {
  const r = bd.prepare('INSERT INTO mesas (contaId, nome) VALUES (?,?)')
    .run(contaId, String(nome).trim())
  return bd.prepare('SELECT * FROM mesas WHERE id = ?').get(r.lastInsertRowid)
}

const mesaDe = (contaId, id) =>
  bd.prepare('SELECT * FROM mesas WHERE id = ? AND contaId = ?').get(id, contaId) || null

const mesasDe = contaId =>
  bd.prepare('SELECT * FROM mesas WHERE contaId = ? AND ativo = 1 ORDER BY id').all(contaId)

const desativarMesa = (contaId, id) =>
  bd.prepare('UPDATE mesas SET ativo = 0 WHERE id = ? AND contaId = ?').run(id, contaId)

// ---------------------------------------------------------------------------
// COMANDAS
// ---------------------------------------------------------------------------

function comandaAbertaDaMesa (contaId, mesaId) {
  return bd.prepare(
    "SELECT * FROM comandas WHERE contaId = ? AND mesaId = ? AND status = 'ABERTA'"
  ).get(contaId, mesaId) || null
}

/** Abrir a mesma mesa duas vezes devolve a comanda que já está aberta. */
function abrirComanda (contaId, mesaId) {
  const mesa = bd.prepare('SELECT * FROM mesas WHERE id = ? AND contaId = ?').get(mesaId, contaId)
  if (!mesa) throw new Error('Mesa não é desta conta.')
  const jaAberta = comandaAbertaDaMesa(contaId, mesaId)
  if (jaAberta) return jaAberta
  const r = bd.prepare('INSERT INTO comandas (contaId, mesaId, abertaEm) VALUES (?,?,?)')
    .run(contaId, mesaId, agora())
  return bd.prepare('SELECT * FROM comandas WHERE id = ?').get(r.lastInsertRowid)
}

const comanda = (contaId, id) =>
  bd.prepare('SELECT * FROM comandas WHERE id = ? AND contaId = ?').get(id, contaId) || null

const comandasAbertas = contaId =>
  bd.prepare("SELECT * FROM comandas WHERE contaId = ? AND status = 'ABERTA' ORDER BY abertaEm").all(contaId)

function lancarPedido (contaId, comandaId, itemId, quantidade, cliente) {
  const cmd = comanda(contaId, comandaId)
  if (!cmd) throw new Error('Comanda não encontrada.')
  if (cmd.status !== 'ABERTA') throw new Error('Esta comanda já foi fechada.')
  const item = bd.prepare('SELECT * FROM itens WHERE id = ? AND contaId = ?').get(itemId, contaId)
  if (!item) throw new Error('Item não é desta conta.')

  const qtd = Math.max(1, Math.floor(quantidade || 1))
  const r = bd.prepare(
    `INSERT INTO pedidos (contaId, comandaId, itemId, nome, precoCentavos, quantidade, cliente, criadoEm)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(contaId, comandaId, item.id, item.nome, item.precoCentavos, qtd, String(cliente || '').trim(), agora())
  return bd.prepare('SELECT * FROM pedidos WHERE id = ?').get(r.lastInsertRowid)
}

function removerPedido (contaId, comandaId, pedidoId) {
  const cmd = comanda(contaId, comandaId)
  if (!cmd || cmd.status !== 'ABERTA') throw new Error('Comanda fechada.')
  bd.prepare('DELETE FROM pedidos WHERE id = ? AND comandaId = ? AND contaId = ?')
    .run(pedidoId, comandaId, contaId)
}

const pedidosDe = (contaId, comandaId) =>
  bd.prepare('SELECT * FROM pedidos WHERE contaId = ? AND comandaId = ? ORDER BY id').all(contaId, comandaId)

const pagamentosDe = (contaId, comandaId) =>
  bd.prepare('SELECT * FROM pagamentos WHERE contaId = ? AND comandaId = ? ORDER BY id').all(contaId, comandaId)

function receber (contaId, comandaId, valorCentavos, forma, cliente) {
  const cmd = comanda(contaId, comandaId)
  if (!cmd) throw new Error('Comanda não encontrada.')
  if (cmd.status !== 'ABERTA') throw new Error('Esta comanda já foi fechada.')
  const valor = Math.floor(valorCentavos)
  if (!Number.isFinite(valor) || valor <= 0) throw new Error('Valor inválido.')
  const r = bd.prepare(
    `INSERT INTO pagamentos (contaId, comandaId, valorCentavos, forma, cliente, criadoEm)
     VALUES (?,?,?,?,?,?)`
  ).run(contaId, comandaId, valor, String(forma || 'DINHEIRO'), String(cliente || '').trim(), agora())
  return bd.prepare('SELECT * FROM pagamentos WHERE id = ?').get(r.lastInsertRowid)
}

/**
 * A CONTA DA COMANDA, INCLUSIVE DIVIDIDA POR CLIENTE.
 *
 * A divisão sai do nome escrito em cada pedido. Quem não tem nome cai em
 * "Mesa" — é o couvert de todo mundo, a água que ninguém assume. O pagamento
 * também carrega nome, então dá para ver quem já pagou a parte dele.
 */
function contaDaComanda (contaId, comandaId) {
  const cmd = comanda(contaId, comandaId)
  if (!cmd) return null
  const pedidos = pedidosDe(contaId, comandaId)
  const pagos = pagamentosDe(contaId, comandaId)

  const total = pedidos.reduce((s, p) => s + p.precoCentavos * p.quantidade, 0)
  const pago = pagos.reduce((s, p) => s + p.valorCentavos, 0)

  const porCliente = {}
  const nomeDe = n => (String(n || '').trim() || 'Mesa')
  for (const p of pedidos) {
    const n = nomeDe(p.cliente)
    porCliente[n] = porCliente[n] || { cliente: n, total: 0, pago: 0, itens: [] }
    porCliente[n].total += p.precoCentavos * p.quantidade
    porCliente[n].itens.push(p)
  }
  for (const p of pagos) {
    const n = nomeDe(p.cliente)
    porCliente[n] = porCliente[n] || { cliente: n, total: 0, pago: 0, itens: [] }
    porCliente[n].pago += p.valorCentavos
  }

  const mesa = bd.prepare('SELECT * FROM mesas WHERE id = ?').get(cmd.mesaId)
  return {
    comanda: cmd,
    mesa: mesa ? mesa.nome : 'Mesa',
    pedidos,
    pagamentos: pagos,
    total,
    pago,
    falta: Math.max(0, total - pago),
    podeFechar: total - pago <= FOLGA_DE_CENTAVOS,
    porCliente: Object.values(porCliente).map(c => ({ ...c, falta: Math.max(0, c.total - c.pago) }))
  }
}

/**
 * FECHAR SÓ COM A CONTA PAGA.
 *
 * A regra mora aqui, no banco, e não na tela. Tela some, tela tem botão novo,
 * tela tem outra versão. O dinheiro não pode depender disso.
 */
function fecharComanda (contaId, comandaId) {
  const c = contaDaComanda(contaId, comandaId)
  if (!c) throw new Error('Comanda não encontrada.')
  if (c.comanda.status !== 'ABERTA') return c
  if (!c.podeFechar) {
    const emReais = (c.falta / 100).toFixed(2).replace('.', ',')
    const err = new Error(`Ainda faltam R$ ${emReais} nesta conta.`)
    err.falta = c.falta
    throw err
  }
  bd.prepare("UPDATE comandas SET status = 'FECHADA', fechadaEm = ? WHERE id = ? AND contaId = ?")
    .run(agora(), comandaId, contaId)
  bd.prepare('UPDATE contas SET vendas = vendas + 1 WHERE id = ?').run(contaId)
  return contaDaComanda(contaId, comandaId)
}

/**
 * LIBERAR MESA ABERTA POR ENGANO.
 *
 * Só some a comanda que está limpa — sem nada lançado e sem nada recebido.
 * Com um centavo dentro, ela não sai mais: apagar comanda com dinheiro é
 * apagar caixa, e isso nenhum sistema nosso vai deixar acontecer por um toque
 * errado no telefone.
 */
function cancelarComandaVazia (contaId, comandaId) {
  const cmd = comanda(contaId, comandaId)
  if (!cmd) throw new Error('Comanda não encontrada.')
  if (cmd.status !== 'ABERTA') throw new Error('Esta comanda já foi fechada.')
  if (pedidosDe(contaId, comandaId).length) throw new Error('Esta mesa já tem pedido lançado.')
  if (pagamentosDe(contaId, comandaId).length) throw new Error('Esta mesa já tem valor recebido.')
  bd.prepare('DELETE FROM comandas WHERE id = ? AND contaId = ?').run(comandaId, contaId)
}

// ---------------------------------------------------------------------------
// CAIXA DO DIA
// ---------------------------------------------------------------------------

function caixaDoDia (contaId, inicio, fim) {
  const linhas = bd.prepare(
    `SELECT p.*, m.nome AS mesa
       FROM pagamentos p
       LEFT JOIN comandas c ON c.id = p.comandaId
       LEFT JOIN mesas m    ON m.id = c.mesaId
      WHERE p.contaId = ? AND p.criadoEm >= ? AND p.criadoEm < ?
      ORDER BY p.criadoEm DESC`
  ).all(contaId, inicio, fim)

  const porForma = {}
  for (const l of linhas) porForma[l.forma] = (porForma[l.forma] || 0) + l.valorCentavos

  const fechadas = bd.prepare(
    "SELECT COUNT(*) n FROM comandas WHERE contaId = ? AND status = 'FECHADA' AND fechadaEm >= ? AND fechadaEm < ?"
  ).get(contaId, inicio, fim).n

  return {
    total: linhas.reduce((s, l) => s + l.valorCentavos, 0),
    porForma,
    comandasFechadas: fechadas,
    pagamentos: linhas.slice(0, 200)
  }
}

module.exports = {
  FOLGA_DE_CENTAVOS,
  criarConta, contaPorId, contaPorEmail, marcarAcesso, salvarRestaurante,
  abrirSessao, sessaoValida, fecharSessao, limparSessoes,
  criarCategoria, categoriasDe, criarItem, itensDe, desativarItem,
  criarMesa, mesasDe, mesaDe, desativarMesa,
  abrirComanda, comanda, comandasAbertas, comandaAbertaDaMesa,
  lancarPedido, removerPedido, pedidosDe, receber, contaDaComanda, fecharComanda,
  cancelarComandaVazia,
  caixaDoDia
}
