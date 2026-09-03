'use strict'

const express = require('express')
const cookieParser = require('cookie-parser')
const rateLimit = require('express-rate-limit')
const crypto = require('crypto')

const banco = require('./banco')
const painel = require('./painel')

const PORTA = Number(process.env.PORTA || 8080)
const SENHA = process.env.PAINEL_SENHA || ''
const SEGREDO = process.env.SESSAO_SEGREDO || ''

if (!SENHA || !SEGREDO) {
  console.error(
    'Faltou configurar PAINEL_SENHA e SESSAO_SEGREDO. ' +
    'Copie o .env.exemplo para .env e preencha antes de subir.'
  )
  process.exit(1)
}

const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '32kb' }))
app.use(express.urlencoded({ extended: false, limit: '32kb' }))
app.use(cookieParser())

// ---------------------------------------------------------------------------
// O ENDEREÇO QUE O APP CONSULTA
// ---------------------------------------------------------------------------
//
// GET /licenca?instalacao=XXXXXXXX&vendas=123&versao=0.6
//
// Responde exatamente o que ai.seven.setmesa.rede.ServicoLicenca espera:
//   { creditos, plano, mensagem, bloqueado }
//
// "creditos" é o SALDO já descontado, não o total comprado. Se fosse o total,
// cada sincronização devolveria o crédito já gasto e a venda sairia de graça.
//
// Aberto de propósito: o app não tem login, e o identificador da instalação é
// aleatório. O limite de chamadas abaixo é o que segura abuso.
// ---------------------------------------------------------------------------

const limiteConsulta = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { creditos: 0, plano: '', mensagem: 'Muitas consultas. Tente em um minuto.', bloqueado: false }
})

app.get('/licenca', limiteConsulta, (req, res) => {
  const id = String(req.query.instalacao || '').trim()
  if (!id || id.length < 4 || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({
      creditos: 0, plano: '', mensagem: 'Identificação da instalação inválida.', bloqueado: false
    })
  }

  const vendas = Number(req.query.vendas)
  const versao = String(req.query.versao || '').slice(0, 16)
  const inst = banco.registrarVisita(id, vendas, versao)
  const saldo = banco.saldoDe(inst)

  res.json({
    creditos: saldo,
    plano: inst.plano || '',
    mensagem: inst.mensagem || '',
    bloqueado: inst.bloqueado === 1
  })
})

/** Para o Michel conferir se o servidor está de pé sem precisar do painel. */
app.get('/saude', (_req, res) => {
  res.json({ ok: true, agora: new Date().toISOString(), ...banco.resumo() })
})

// ---------------------------------------------------------------------------
// PAINEL — onde o Michel libera crédito depois de confirmar o Pix
// ---------------------------------------------------------------------------

function assinar (valor) {
  return crypto.createHmac('sha256', SEGREDO).update(valor).digest('hex')
}

function criarSessao () {
  const emitidoEm = String(Date.now())
  return `${emitidoEm}.${assinar(emitidoEm)}`
}

function sessaoValida (cookie) {
  if (!cookie || !cookie.includes('.')) return false
  const [emitidoEm, assinatura] = cookie.split('.')
  const esperada = assinar(emitidoEm)
  const a = Buffer.from(assinatura || '', 'utf8')
  const b = Buffer.from(esperada, 'utf8')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  // Uma semana de sessão: o suficiente para o dia a dia, curto para um roubo de cookie.
  return Date.now() - Number(emitidoEm) < 7 * 24 * 3600 * 1000
}

function exigirSessao (req, res, next) {
  if (sessaoValida(req.cookies.sessao)) return next()
  res.status(401).send(painel.telaLogin('Entre para ver o painel.'))
}

const limiteLogin = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10 })

app.get('/painel', (req, res) => {
  if (!sessaoValida(req.cookies.sessao)) return res.send(painel.telaLogin(''))
  res.send(painel.telaPainel(banco.listar(), banco.resumo()))
})

app.post('/painel/entrar', limiteLogin, (req, res) => {
  const enviada = Buffer.from(String(req.body.senha || ''), 'utf8')
  const correta = Buffer.from(SENHA, 'utf8')
  const confere = enviada.length === correta.length && crypto.timingSafeEqual(enviada, correta)
  if (!confere) return res.status(401).send(painel.telaLogin('Senha incorreta.'))

  res.cookie('sessao', criarSessao(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'producao',
    maxAge: 7 * 24 * 3600 * 1000
  })
  res.redirect('/painel')
})

app.post('/painel/sair', (req, res) => {
  res.clearCookie('sessao')
  res.redirect('/painel')
})

app.get('/painel/instalacao/:id', exigirSessao, (req, res) => {
  const inst = banco.buscar(req.params.id)
  if (!inst) return res.status(404).send(painel.telaPainel(banco.listar(), banco.resumo(), 'Instalação não encontrada.'))
  res.send(painel.telaInstalacao(inst, banco.recargasDe(inst.id)))
})

app.post('/painel/creditar', exigirSessao, (req, res) => {
  const id = String(req.body.id || '').trim()
  const quantidade = Number(req.body.quantidade)
  const valor = Math.round(Number(String(req.body.valor || '0').replace(',', '.')) * 100)
  try {
    banco.creditar(id, quantidade, valor, String(req.body.observacao || ''))
    res.redirect('/painel/instalacao/' + encodeURIComponent(id))
  } catch (e) {
    res.status(400).send(painel.telaInstalacao(banco.buscar(id), banco.recargasDe(id), e.message))
  }
})

app.post('/painel/cadastro', exigirSessao, (req, res) => {
  const id = String(req.body.id || '').trim()
  banco.atualizarCadastro(id, {
    apelido: req.body.apelido,
    plano: req.body.plano,
    mensagem: req.body.mensagem,
    bloqueado: req.body.bloqueado === 'on'
  })
  res.redirect('/painel/instalacao/' + encodeURIComponent(id))
})

app.get('/', (_req, res) => res.redirect('/painel'))

app.listen(PORTA, () => {
  console.log(`SET Mesa · servidor de licenças na porta ${PORTA}`)
  console.log(`Banco: ${banco.CAMINHO}`)
})
