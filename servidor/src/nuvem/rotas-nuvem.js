'use strict'

const express = require('express')
const rateLimit = require('express-rate-limit')

const bn = require('./banco-nuvem')
const contas = require('./contas')
const pagina = require('./pagina-nuvem')

/**
 * AS ROTAS DO SET MESA NUVEM.
 *
 * Tudo que vem depois de `exigirConta` só enxerga a conta do próprio dono: o
 * contaId sai SEMPRE da sessão, nunca do que o navegador mandou. Se viesse do
 * corpo do pedido, bastava trocar um número para abrir a mesa do vizinho.
 */

const COOKIE = 'setmesa_nuvem'
const rotas = express.Router()

const limiteLogin = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erro: 'Muitas tentativas. Espere alguns minutos.' }
})

function porHttps (req) {
  return req.secure || String(req.get('x-forwarded-proto') || '').startsWith('https')
}

function guardarCookie (req, res, token, ate) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: porHttps(req),
    expires: new Date(ate)
  })
}

function exigirConta (req, res, next) {
  const s = bn.sessaoValida(req.cookies[COOKIE])
  if (!s) return res.status(401).json({ ok: false, erro: 'Sessão encerrada. Entre de novo.', sair: true })
  const conta = bn.contaPorId(s.contaId)
  if (!conta) return res.status(401).json({ ok: false, erro: 'Conta não encontrada.', sair: true })
  req.conta = conta
  next()
}

/** Erro de regra vira mensagem legível; erro nosso vira 500 e fica no log. */
function responder (res, fn) {
  try {
    res.json({ ok: true, ...(fn() || {}) })
  } catch (e) {
    if (e && e.regra !== false && e.message) return res.status(400).json({ ok: false, erro: e.message })
    console.error('nuvem:', e)
    res.status(500).json({ ok: false, erro: 'Deu erro aqui no servidor.' })
  }
}

// ---------------------------------------------------------------------------
// TELAS
// ---------------------------------------------------------------------------

rotas.get('/entrar', (req, res) => {
  if (bn.sessaoValida(req.cookies[COOKIE])) return res.redirect('/sistema')
  res.send(pagina.telaDeEntrada())
})

rotas.get('/sistema', (req, res) => {
  if (!bn.sessaoValida(req.cookies[COOKIE])) return res.redirect('/entrar')
  res.send(pagina.telaDoSistema())
})

// ---------------------------------------------------------------------------
// CONTA
// ---------------------------------------------------------------------------

rotas.post('/nuvem/criar-conta', limiteLogin, (req, res) => {
  try {
    contas.criar(req.body || {})
    const { token, ate } = contas.entrar(req.body.email, req.body.senha)
    guardarCookie(req, res, token, ate)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ ok: false, erro: e.message })
  }
})

rotas.post('/nuvem/entrar', limiteLogin, (req, res) => {
  try {
    const { token, ate } = contas.entrar((req.body || {}).email, (req.body || {}).senha)
    guardarCookie(req, res, token, ate)
    res.json({ ok: true })
  } catch (e) {
    res.status(401).json({ ok: false, erro: e.message })
  }
})

rotas.post('/nuvem/sair', (req, res) => {
  const t = req.cookies[COOKIE]
  if (t) bn.fecharSessao(t)
  res.clearCookie(COOKIE)
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// O QUE A TELA LÊ
// ---------------------------------------------------------------------------

rotas.get('/nuvem/dados', exigirConta, (req, res) => responder(res, () => {
  const c = req.conta
  const abertas = bn.comandasAbertas(c.id).map(cm => {
    const conta = bn.contaDaComanda(c.id, cm.id)
    return {
      id: cm.id, mesaId: cm.mesaId, mesa: conta.mesa,
      total: conta.total, pago: conta.pago, falta: conta.falta,
      pessoas: conta.porCliente.length, abertaEm: cm.abertaEm
    }
  })
  return {
    eu: { nome: c.nome, restaurante: c.restaurante, email: c.email },
    credito: contas.saldoDe(c),
    categorias: bn.categoriasDe(c.id),
    itens: bn.itensDe(c.id),
    mesas: bn.mesasDe(c.id),
    abertas
  }
}))

rotas.get('/nuvem/comanda/:id', exigirConta, (req, res) => responder(res, () => {
  const conta = bn.contaDaComanda(req.conta.id, Number(req.params.id))
  if (!conta) throw new Error('Comanda não encontrada.')
  return { conta }
}))

rotas.get('/nuvem/caixa', exigirConta, (req, res) => responder(res, () => {
  // O dia começa às 5h da manhã: o turno da noite de sábado termina no
  // domingo de madrugada e tem que cair no caixa de sábado.
  const base = new Date()
  if (base.getHours() < 5) base.setDate(base.getDate() - 1)
  base.setHours(5, 0, 0, 0)
  const inicio = base.getTime()
  return { caixa: bn.caixaDoDia(req.conta.id, inicio, inicio + 24 * 3600 * 1000), desde: inicio }
}))

// ---------------------------------------------------------------------------
// CADASTROS
// ---------------------------------------------------------------------------

rotas.post('/nuvem/restaurante', exigirConta, (req, res) =>
  responder(res, () => ({ conta: bn.salvarRestaurante(req.conta.id, (req.body || {}).nome) })))

rotas.post('/nuvem/categoria', exigirConta, (req, res) => responder(res, () => {
  const nome = String((req.body || {}).nome || '').trim()
  if (!nome) throw new Error('Escreva o nome da categoria.')
  return { categoria: bn.criarCategoria(req.conta.id, nome) }
}))

rotas.post('/nuvem/item', exigirConta, (req, res) => responder(res, () => {
  const b = req.body || {}
  const nome = String(b.nome || '').trim()
  if (!nome) throw new Error('Escreva o nome do item.')
  const preco = Math.round(Number(b.preco) * 100)
  if (!Number.isFinite(preco) || preco < 0) throw new Error('Preço inválido.')
  return { item: bn.criarItem(req.conta.id, Number(b.categoriaId), nome, preco) }
}))

rotas.post('/nuvem/item/remover', exigirConta, (req, res) =>
  responder(res, () => { bn.desativarItem(req.conta.id, Number((req.body || {}).id)); return {} }))

rotas.post('/nuvem/mesa', exigirConta, (req, res) => responder(res, () => {
  const nome = String((req.body || {}).nome || '').trim()
  if (!nome) throw new Error('Escreva o nome da mesa.')
  return { mesa: bn.criarMesa(req.conta.id, nome) }
}))

rotas.post('/nuvem/mesa/remover', exigirConta, (req, res) =>
  responder(res, () => { bn.desativarMesa(req.conta.id, Number((req.body || {}).id)); return {} }))

// ---------------------------------------------------------------------------
// O TURNO
// ---------------------------------------------------------------------------

rotas.post('/nuvem/comanda/abrir', exigirConta, (req, res) => responder(res, () => {
  const c = req.conta
  const mesaId = Number((req.body || {}).mesaId)
  // De quem é a mesa vem PRIMEIRO. Conferir crédito antes faria o sistema
  // responder "créditos esgotados" para uma mesa que nem é desta conta — uma
  // mensagem que manda o dono comprar crédito para resolver outra coisa.
  if (!bn.mesaDe(c.id, mesaId)) throw new Error('Mesa não é desta conta.')

  // O crédito é conferido ao ABRIR, nunca ao fechar: ninguém fica com a mesa
  // presa e o cliente esperando porque o saldo acabou no meio do jantar.
  const jaAberta = bn.comandaAbertaDaMesa(c.id, mesaId)
  if (!jaAberta) {
    const cr = contas.saldoDe(c)
    if (cr.bloqueado) throw new Error('Conta bloqueada. Fale com a SEVEN AI.')
    if (cr.saldo !== null && cr.saldo <= 0) {
      throw new Error('Créditos esgotados. Compre créditos para abrir novas mesas — as abertas continuam.')
    }
  }
  return { comanda: bn.abrirComanda(c.id, mesaId) }
}))

rotas.post('/nuvem/comanda/:id/pedido', exigirConta, (req, res) => responder(res, () => {
  const b = req.body || {}
  bn.lancarPedido(req.conta.id, Number(req.params.id), Number(b.itemId), Number(b.quantidade || 1), b.cliente)
  return { conta: bn.contaDaComanda(req.conta.id, Number(req.params.id)) }
}))

rotas.post('/nuvem/comanda/:id/remover-pedido', exigirConta, (req, res) => responder(res, () => {
  bn.removerPedido(req.conta.id, Number(req.params.id), Number((req.body || {}).pedidoId))
  return { conta: bn.contaDaComanda(req.conta.id, Number(req.params.id)) }
}))

rotas.post('/nuvem/comanda/:id/receber', exigirConta, (req, res) => responder(res, () => {
  const b = req.body || {}
  const centavos = Math.round(Number(b.valor) * 100)
  bn.receber(req.conta.id, Number(req.params.id), centavos, b.forma, b.cliente)
  return { conta: bn.contaDaComanda(req.conta.id, Number(req.params.id)) }
}))

rotas.post('/nuvem/comanda/:id/cancelar', exigirConta, (req, res) => responder(res, () => {
  bn.cancelarComandaVazia(req.conta.id, Number(req.params.id))
  return {}
}))

rotas.post('/nuvem/comanda/:id/fechar', exigirConta, (req, res) => {
  try {
    const conta = bn.fecharComanda(req.conta.id, Number(req.params.id))
    contas.informarConsumo(bn.contaPorId(req.conta.id))
    res.json({ ok: true, conta })
  } catch (e) {
    res.status(400).json({ ok: false, erro: e.message, falta: e.falta })
  }
})

// A cada hora joga fora sessão vencida. Não precisa de precisão nenhuma.
setInterval(() => { try { bn.limparSessoes() } catch (_) {} }, 3600 * 1000).unref()

module.exports = rotas
