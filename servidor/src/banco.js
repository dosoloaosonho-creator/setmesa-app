'use strict'

const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

/**
 * O BANCO DO SERVIDOR DE LICENÇAS.
 *
 * É um arquivo só, separado de tudo. Foi escolha deliberada: o Michel pediu que
 * este projeto não encoste no da SEVEN AI, e um arquivo próprio garante isso
 * melhor do que um banco compartilhado com usuário separado — não há como um
 * errar no outro.
 *
 * A CONTA QUE IMPORTA:
 *   saldo = creditosComprados − vendasConsumidas
 *
 * O servidor é dono do que foi COMPRADO (só cresce, e só o Michel mexe).
 * O app é dono do que foi VENDIDO (só cresce, e ele conta offline).
 * Nenhum dos dois pode ser perdido, e a subtração se corrige sozinha:
 * a venda feita na cortesia entra em vendasConsumidas e é cobrada na recarga
 * seguinte, sem ninguém precisar lembrar de descontar nada.
 */

const CAMINHO = process.env.BANCO || path.join(__dirname, '..', 'dados', 'setmesa-licencas.db')

fs.mkdirSync(path.dirname(CAMINHO), { recursive: true })

const bd = new Database(CAMINHO)
bd.pragma('journal_mode = WAL')

bd.exec(`
  CREATE TABLE IF NOT EXISTS instalacoes (
    id                  TEXT PRIMARY KEY,
    apelido             TEXT    NOT NULL DEFAULT '',
    creditosComprados   INTEGER NOT NULL DEFAULT 0,
    vendasConsumidas    INTEGER NOT NULL DEFAULT 0,
    plano               TEXT    NOT NULL DEFAULT '',
    mensagem            TEXT    NOT NULL DEFAULT '',
    bloqueado           INTEGER NOT NULL DEFAULT 0,
    criadoEm            INTEGER NOT NULL,
    vistoEm             INTEGER NOT NULL DEFAULT 0,
    versaoApp           TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS recargas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    instalacaoId  TEXT    NOT NULL,
    quantidade    INTEGER NOT NULL,
    valorCentavos INTEGER NOT NULL DEFAULT 0,
    observacao    TEXT    NOT NULL DEFAULT '',
    criadoEm      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recargas_instalacao ON recargas(instalacaoId, criadoEm DESC);

  -- Guarda a senha do painel depois que o Michel a troca pela tela.
  -- Enquanto não houver nada aqui, vale a senha do .env.
  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  -- RECARGA AUTOMÁTICA. Uma linha por cobrança Pix gerada.
  -- O correlationId é nosso e é ele que liga o aviso de pagamento da Woovi de
  -- volta à instalação certa. É chave primária de propósito: aviso repetido
  -- não cria linha nova.
  CREATE TABLE IF NOT EXISTS cobrancas (
    correlationId TEXT PRIMARY KEY,
    instalacaoId  TEXT    NOT NULL,
    quantidade    INTEGER NOT NULL,
    valorCentavos INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'ABERTA',
    brCode        TEXT    NOT NULL DEFAULT '',
    qrCodeImage   TEXT    NOT NULL DEFAULT '',
    linkPagamento TEXT    NOT NULL DEFAULT '',
    criadoEm      INTEGER NOT NULL,
    pagoEm        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_cobrancas_instalacao ON cobrancas(instalacaoId, criadoEm DESC);
`)

const agora = () => Date.now()

/** Instalação desconhecida vira cadastro com saldo zero — assim ela aparece no painel. */
function garantirInstalacao (id) {
  const existente = bd.prepare('SELECT * FROM instalacoes WHERE id = ?').get(id)
  if (existente) return existente
  bd.prepare(
    'INSERT INTO instalacoes (id, criadoEm, vistoEm) VALUES (?, ?, ?)'
  ).run(id, agora(), agora())
  return bd.prepare('SELECT * FROM instalacoes WHERE id = ?').get(id)
}

/**
 * Registra a visita do app e o que ele relatou de consumo.
 * O consumo relatado só sobe: se chegar um número menor (reinstalação, banco
 * apagado, aparelho trocado), o servidor mantém o maior e não devolve crédito
 * que já foi usado.
 */
function registrarVisita (id, vendasRelatadas, versaoApp) {
  const inst = garantirInstalacao(id)
  const vendas = Number.isFinite(vendasRelatadas) && vendasRelatadas >= 0
    ? Math.max(inst.vendasConsumidas, Math.floor(vendasRelatadas))
    : inst.vendasConsumidas

  bd.prepare(
    'UPDATE instalacoes SET vistoEm = ?, vendasConsumidas = ?, versaoApp = ? WHERE id = ?'
  ).run(agora(), vendas, versaoApp || inst.versaoApp, id)

  return bd.prepare('SELECT * FROM instalacoes WHERE id = ?').get(id)
}

function saldoDe (inst) {
  return Math.max(0, inst.creditosComprados - inst.vendasConsumidas)
}

function listar () {
  const linhas = bd.prepare('SELECT * FROM instalacoes ORDER BY vistoEm DESC, criadoEm DESC').all()
  return linhas.map(l => ({ ...l, saldo: saldoDe(l) }))
}

function buscar (id) {
  const l = bd.prepare('SELECT * FROM instalacoes WHERE id = ?').get(id)
  return l ? { ...l, saldo: saldoDe(l) } : null
}

/** Creditar é a operação do dinheiro: sempre soma, nunca substitui, e fica no histórico. */
function creditar (id, quantidade, valorCentavos, observacao) {
  const inst = garantirInstalacao(id)
  const qtd = Math.floor(quantidade)
  if (!Number.isFinite(qtd) || qtd <= 0) throw new Error('Quantidade inválida.')

  const transacao = bd.transaction(() => {
    bd.prepare(
      'UPDATE instalacoes SET creditosComprados = creditosComprados + ?, bloqueado = 0 WHERE id = ?'
    ).run(qtd, id)
    bd.prepare(
      'INSERT INTO recargas (instalacaoId, quantidade, valorCentavos, observacao, criadoEm) VALUES (?,?,?,?,?)'
    ).run(id, qtd, Math.floor(valorCentavos || 0), observacao || '', agora())
  })
  transacao()
  return buscar(id)
}

function atualizarCadastro (id, campos) {
  garantirInstalacao(id)
  bd.prepare(
    'UPDATE instalacoes SET apelido = ?, plano = ?, mensagem = ?, bloqueado = ? WHERE id = ?'
  ).run(
    String(campos.apelido || ''),
    String(campos.plano || ''),
    String(campos.mensagem || ''),
    campos.bloqueado ? 1 : 0,
    id
  )
  return buscar(id)
}

function recargasDe (id, limite = 30) {
  return bd.prepare(
    'SELECT * FROM recargas WHERE instalacaoId = ? ORDER BY criadoEm DESC LIMIT ?'
  ).all(id, limite)
}

function resumo () {
  const linhas = listar()
  return {
    instalacoes: linhas.length,
    ativas30dias: linhas.filter(l => l.vistoEm > agora() - 30 * 24 * 3600 * 1000).length,
    creditosVendidos: linhas.reduce((s, l) => s + l.creditosComprados, 0),
    vendasProcessadas: linhas.reduce((s, l) => s + l.vendasConsumidas, 0),
    semSaldo: linhas.filter(l => l.saldo <= 0).length
  }
}

/**
 * CÓPIA DE SEGURANÇA ÍNTEGRA.
 *
 * O banco roda em modo WAL: copiar o arquivo com `cp` pode pegar um retrato
 * pela metade, com transações que ainda estão no diário e não no arquivo
 * principal. O `.backup` do próprio SQLite resolve isso — ele monta uma cópia
 * consistente mesmo com o servidor atendendo consulta no mesmo instante.
 *
 * Este arquivo é o faturamento: quem comprou quanto, quem está sem saldo,
 * todo o histórico de recarga. Perder isso é perder a cobrança de todos os
 * clientes de uma vez.
 */
async function copiarPara (destino) {
  fs.mkdirSync(path.dirname(destino), { recursive: true })
  await bd.backup(destino)
  return { arquivo: destino, bytes: fs.statSync(destino).size }
}

const PASTA_COPIAS = path.join(path.dirname(CAMINHO), 'copias')

/** Roda todo dia e guarda os últimos 14. Mais que isso é espaço à toa. */
async function copiaDoDia (manter = 14) {
  const dia = new Date().toISOString().slice(0, 10)
  const destino = path.join(PASTA_COPIAS, `licencas-${dia}.db`)
  const r = await copiarPara(destino)

  const antigas = fs.readdirSync(PASTA_COPIAS)
    .filter(n => n.startsWith('licencas-') && n.endsWith('.db'))
    .sort()
    .slice(0, -manter)
  antigas.forEach(n => { try { fs.unlinkSync(path.join(PASTA_COPIAS, n)) } catch (_) {} })

  return { ...r, apagadas: antigas.length }
}

function listarCopias () {
  if (!fs.existsSync(PASTA_COPIAS)) return []
  return fs.readdirSync(PASTA_COPIAS)
    .filter(n => n.endsWith('.db'))
    .map(n => {
      const st = fs.statSync(path.join(PASTA_COPIAS, n))
      return { nome: n, bytes: st.size, em: st.mtimeMs }
    })
    .sort((a, b) => b.em - a.em)
}

function lerConfig (chave) {
  const r = bd.prepare('SELECT valor FROM config WHERE chave = ?').get(chave)
  return r ? r.valor : null
}

function gravarConfig (chave, valor) {
  bd.prepare(
    'INSERT INTO config (chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'
  ).run(chave, valor)
}


// ---------------------------------------------------------------------------
// RECARGA AUTOMÁTICA
// ---------------------------------------------------------------------------

function registrarCobranca (c) {
  bd.prepare(
    `INSERT INTO cobrancas
       (correlationId, instalacaoId, quantidade, valorCentavos, status,
        brCode, qrCodeImage, linkPagamento, criadoEm)
     VALUES (?,?,?,?,'ABERTA',?,?,?,?)`
  ).run(
    c.correlationId, c.instalacaoId, Math.floor(c.quantidade),
    Math.floor(c.valorCentavos), c.brCode || '', c.qrCodeImage || '',
    c.linkPagamento || '', agora()
  )
  return buscarCobranca(c.correlationId)
}

function buscarCobranca (correlationId) {
  return bd.prepare('SELECT * FROM cobrancas WHERE correlationId = ?').get(correlationId) || null
}

function cobrancasDe (instalacaoId, limite = 20) {
  return bd.prepare(
    'SELECT * FROM cobrancas WHERE instalacaoId = ? ORDER BY criadoEm DESC LIMIT ?'
  ).all(instalacaoId, limite)
}

/**
 * CONFIRMA O PAGAMENTO E LIBERA O CRÉDITO — uma vez só.
 *
 * A Woovi reenvia o aviso quando não recebe 200 na primeira tentativa, e às
 * vezes reenvia mesmo tendo recebido. Se este trecho não fosse à prova de
 * repetição, o mesmo Pix creditaria duas, três vezes.
 *
 * A trava é o próprio UPDATE: ele só altera a linha se ela AINDA NÃO estiver
 * paga. Se mudou uma linha, este é o primeiro aviso e o crédito entra; se
 * mudou zero, alguém já processou e a gente responde ok sem creditar de novo.
 * Tudo dentro de uma transação, junto com o crédito.
 */
function confirmarPagamento (correlationId) {
  const transacao = bd.transaction(() => {
    const existe = bd.prepare('SELECT * FROM cobrancas WHERE correlationId = ?').get(correlationId)
    if (!existe) return { situacao: 'desconhecida' }

    const r = bd.prepare(
      "UPDATE cobrancas SET status = 'PAGA', pagoEm = ? WHERE correlationId = ? AND status <> 'PAGA'"
    ).run(agora(), correlationId)

    if (r.changes !== 1) return { situacao: 'repetida', cobranca: existe }

    creditar(
      existe.instalacaoId, existe.quantidade, existe.valorCentavos,
      'Recarga automática por Pix'
    )
    return { situacao: 'creditada', cobranca: buscarCobranca(correlationId) }
  })
  return transacao()
}

module.exports = {
  copiarPara, copiaDoDia, listarCopias, PASTA_COPIAS,
  lerConfig, gravarConfig,
  garantirInstalacao, registrarVisita, saldoDe, listar, buscar,
  creditar, atualizarCadastro, recargasDe, resumo, CAMINHO,
  registrarCobranca, buscarCobranca, cobrancasDe, confirmarPagamento
}
