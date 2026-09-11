'use strict'

const crypto = require('crypto')
const bn = require('./banco-nuvem')
const licencas = require('../banco')

/**
 * CONTA DO DONO — cadastro, senha e sessão.
 *
 * A senha nunca é guardada. Guarda-se o scrypt dela com sal próprio por conta.
 * Dois donos com a mesma senha têm hash diferente, e uma cópia do banco não
 * entrega a senha de ninguém.
 *
 * Isto é senha de verdade, que viaja pela internet — diferente do PIN de
 * funcionário do app local, que anda só dentro do restaurante. Por isso aqui é
 * scrypt com sal por conta, e não o SHA-256 de sal fixo que o app usa.
 */

const HORAS_DE_SESSAO = 14 // cobre o turno inteiro e vence antes do dia seguinte

/**
 * CORTESIA DE ABERTURA.
 *
 * Conta nova com saldo zero não abre nem a primeira mesa — o dono entraria no
 * sistema e encontraria uma porta trancada, que é a pior primeira impressão
 * possível. Nasce com um bloco de vendas por conta da casa, igual ao app.
 */
const CORTESIA = Number(process.env.NUVEM_CREDITOS_INICIAIS || 10)

function embaralhar (senha, salt) {
  return crypto.scryptSync(String(senha), salt, 64).toString('hex')
}

function conferir (senha, conta) {
  const tentativa = Buffer.from(embaralhar(senha, conta.salt), 'hex')
  const correta = Buffer.from(conta.senhaHash, 'hex')
  if (tentativa.length !== correta.length) return false
  return crypto.timingSafeEqual(tentativa, correta)
}

const emailLimpo = e => String(e || '').trim().toLowerCase()

function emailParece (e) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)
}

function criar ({ nome, email, senha, restaurante }) {
  const mail = emailLimpo(email)
  if (!String(nome || '').trim()) throw new Error('Escreva o seu nome.')
  if (!emailParece(mail)) throw new Error('Esse e-mail não parece certo.')
  if (String(senha || '').length < 6) throw new Error('A senha precisa de pelo menos 6 letras ou números.')
  if (bn.contaPorEmail(mail)) throw new Error('Já existe uma conta com este e-mail.')

  const salt = crypto.randomBytes(16).toString('hex')
  // O identificador da instalação é o que liga esta conta ao painel de
  // créditos que já existe. Nasce aqui e não muda mais.
  const instalacaoId = 'NUVEM-' + crypto.randomBytes(6).toString('hex').toUpperCase()

  const conta = bn.criarConta({
    id: crypto.randomUUID(),
    nome: String(nome).trim(),
    email: mail,
    senhaHash: embaralhar(senha, salt),
    salt,
    restaurante: String(restaurante || '').trim(),
    instalacaoId
  })

  // Aparece no painel do Michel já no cadastro, com saldo zero e apelido
  // legível — senão só apareceria depois da primeira venda.
  try {
    licencas.atualizarCadastro(instalacaoId, {
      apelido: `${conta.restaurante || conta.nome} (nuvem)`,
      plano: 'NUVEM',
      mensagem: '',
      bloqueado: 0
    })
    if (CORTESIA > 0) {
      licencas.creditar(instalacaoId, CORTESIA, 0, 'cortesia de abertura — conta nuvem')
    }
  } catch (_) { /* painel indisponível não pode impedir o cadastro */ }

  return conta
}

function entrar (email, senha) {
  const conta = bn.contaPorEmail(emailLimpo(email))
  // Mesma resposta para e-mail que não existe e senha errada: quem tenta
  // adivinhar não descobre quais e-mails têm conta.
  if (!conta || !conferir(senha, conta)) throw new Error('E-mail ou senha não conferem.')
  const token = crypto.randomBytes(24).toString('base64url')
  const ate = bn.abrirSessao(token, conta.id, HORAS_DE_SESSAO)
  bn.marcarAcesso(conta.id)
  return { token, ate, conta }
}

/** Saldo de créditos desta conta, lido no banco de licenças. */
function saldoDe (conta) {
  try {
    const inst = licencas.buscar(conta.instalacaoId)
    if (!inst) return { saldo: 0, bloqueado: false }
    return { saldo: inst.saldo, bloqueado: !!inst.bloqueado }
  } catch (_) {
    // Falha na leitura do saldo não pode parar o restaurante no meio do turno.
    return { saldo: null, bloqueado: false }
  }
}

/**
 * Conta o consumo no painel de créditos.
 *
 * O número enviado é o TOTAL acumulado, nunca "mais um": se uma chamada se
 * perder, a próxima corrige sozinha, porque do outro lado o valor só sobe.
 */
function informarConsumo (conta) {
  try { licencas.registrarVisita(conta.instalacaoId, conta.vendas, 'nuvem') } catch (_) {}
}

module.exports = { criar, entrar, saldoDe, informarConsumo, HORAS_DE_SESSAO }
