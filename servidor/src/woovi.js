'use strict'

const crypto = require('crypto')

/**
 * RECARGA AUTOMÁTICA — INTEGRAÇÃO COM A WOOVI (OpenPix).
 *
 * O que este arquivo faz, e só isso:
 *   1. pede uma cobrança Pix à Woovi e devolve o QR e o copia-e-cola;
 *   2. confere a assinatura do aviso de pagamento que a Woovi manda de volta.
 *
 * A CONFERÊNCIA DA ASSINATURA É A FECHADURA DO FATURAMENTO.
 * O endereço do webhook fica aberto na internet, como tem que ficar. Sem
 * conferir quem assinou, qualquer pessoa que descobrisse esse endereço mandava
 * um "pago" e ganhava crédito de graça. A Woovi assina o corpo com a chave
 * privada dela; aqui a gente confere com a chave pública. Sem a chave privada
 * dela, ninguém consegue forjar.
 *
 * ATENÇÃO DE MANUTENÇÃO: a assinatura vale sobre os BYTES BRUTOS do corpo, não
 * sobre o JSON reserializado. Se algum dia alguém puser express.json() na
 * frente desta rota, a verificação passa a falhar sempre — e o jeito errado de
 * "consertar" isso é desligar a conferência. Não desligue.
 */

const BASE = (process.env.WOOVI_API || 'https://api.woovi.com/api/v1').replace(/\/+$/, '')
const APPID = process.env.WOOVI_APPID || ''

// Chave pública da Woovi em base64, como publicada na documentação deles.
// WOOVI_CHAVE_PUBLICA permite trocar sem gerar imagem nova, caso eles girem a
// chave um dia — e é o que os testes usam para provar que a conferência funciona.
const CHAVE_PADRAO =
  'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlHZk1BMEdDU3FHU0liM0RRRUJBUVVBQTRHTkFEQ0Jp' +
  'UUtCZ1FDLytOdElranpldnZxRCtJM01NdjNiTFhEdApwdnhCalk0QnNSclNkY2EzcnRBd01jUllZdnhT' +
  'bmQ3amFnVkxwY3RNaU94UU84aWVVQ0tMU1dIcHNNQWpPL3paCldNS2Jxb0c4TU5waS91M2ZwNnp6MG1j' +
  'SENPU3FZc1BVVUcxOWJ1VzhiaXM1WloySVpnQk9iV1NwVHZKMGNuajYKSEtCQUE4MkpsbitsR3dTMU13' +
  'SURBUUFCCi0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo='

function chavePublica () {
  const b64 = process.env.WOOVI_CHAVE_PUBLICA || CHAVE_PADRAO
  return Buffer.from(b64, 'base64').toString('utf8')
}

/** Sem AppID no .env, a recarga automática fica desligada e o painel manual continua. */
function configurado () {
  return APPID.trim().length > 0
}

/**
 * Confere a assinatura do webhook.
 * @param corpoBruto Buffer com os bytes exatos que chegaram.
 * @param assinatura conteúdo do header x-webhook-signature (base64).
 */
function assinaturaConfere (corpoBruto, assinatura) {
  if (!corpoBruto || !assinatura) return false
  try {
    const v = crypto.createVerify('sha256')
    v.write(Buffer.isBuffer(corpoBruto) ? corpoBruto : Buffer.from(corpoBruto))
    v.end()
    return v.verify(chavePublica(), String(assinatura), 'base64')
  } catch (_) {
    // Assinatura malformada não é erro de servidor: é tentativa recusada.
    return false
  }
}

/**
 * Cria a cobrança Pix. O valor vai em CENTAVOS, como o resto do sistema.
 * correlationID é nosso, e é ele que liga a cobrança à instalação quando o
 * aviso de pagamento voltar.
 */
async function criarCobranca ({ correlationID, valorCentavos, comentario }) {
  if (!configurado()) {
    throw new Error('Recarga automática não configurada: falta WOOVI_APPID no .env do servidor.')
  }

  let resposta
  try {
    resposta = await fetch(`${BASE}/charge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: APPID
      },
      body: JSON.stringify({
        correlationID,
        value: Math.round(valorCentavos),
        comment: String(comentario || '').slice(0, 140)
      }),
      signal: AbortSignal.timeout(20000)
    })
  } catch (e) {
    throw new Error('Não consegui falar com a Woovi agora: ' + e.message)
  }

  const texto = await resposta.text()
  if (!resposta.ok) {
    throw new Error(`A Woovi recusou a cobrança (${resposta.status}): ${texto.slice(0, 300)}`)
  }

  let json
  try { json = JSON.parse(texto) } catch (_) {
    throw new Error('A Woovi devolveu uma resposta que não é JSON.')
  }

  const c = json.charge || {}
  const brCode = c.brCode || json.brCode || ''
  if (!brCode) throw new Error('A Woovi respondeu sem o código Pix. Cobrança não criada.')

  return {
    correlationID: c.correlationID || correlationID,
    brCode,
    qrCodeImage: c.qrCodeImage || '',
    linkPagamento: c.paymentLinkUrl || '',
    status: c.status || 'ACTIVE'
  }
}

module.exports = { configurado, assinaturaConfere, criarCobranca, BASE }
