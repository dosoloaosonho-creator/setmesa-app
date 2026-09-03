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

module.exports = {
  garantirInstalacao, registrarVisita, saldoDe, listar, buscar,
  creditar, atualizarCadastro, recargasDe, resumo, CAMINHO
}
