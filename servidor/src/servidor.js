'use strict'

const express = require('express')
const cookieParser = require('cookie-parser')
const rateLimit = require('express-rate-limit')
const crypto = require('crypto')

const banco = require('./banco')
const painel = require('./painel')
const woovi = require('./woovi')
const recarga = require('./recarga')
const instalar = require('./instalar')
const demonstracao = require('./demonstracao')
const rotasNuvem = require('./nuvem/rotas-nuvem')

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

// ---------------------------------------------------------------------------
// AVISO DE PAGAMENTO DA WOOVI — precisa vir ANTES de qualquer parser de JSON
// ---------------------------------------------------------------------------
//
// A assinatura da Woovi vale sobre os BYTES BRUTOS do corpo. Se o express.json
// abrir e refazer o JSON antes, a conferência falha sempre — e a "solução"
// tentadora seria desligar a conferência, que é justamente o que não pode.
// Por isso esta rota fica aqui em cima, com express.raw, e só ela.
//
// Sem a conferência, quem descobrisse este endereço mandava um "pago" e ganhava
// crédito de graça. É a fechadura do faturamento.
// ---------------------------------------------------------------------------

app.post('/webhook/woovi', express.raw({ type: '*/*', limit: '64kb' }), (req, res) => {
  const assinatura = req.get('x-webhook-signature')

  if (!woovi.assinaturaConfere(req.body, assinatura)) {
    console.warn('webhook recusado: assinatura invalida ou ausente')
    return res.status(401).json({ ok: false })
  }

  let corpo
  try { corpo = JSON.parse(req.body.toString('utf8')) } catch (_) {
    return res.status(400).json({ ok: false })
  }

  // A Woovi manda um aviso de teste quando o webhook é cadastrado, e manda
  // outros eventos além do pagamento. Responder 200 a todos evita reenvio
  // eterno de coisa que a gente não trata.
  if (corpo.event !== 'OPENPIX:CHARGE_COMPLETED') {
    return res.json({ ok: true, ignorado: corpo.event || 'sem evento' })
  }

  const correlationId = String((corpo.charge && corpo.charge.correlationID) || '')
  if (!correlationId) return res.json({ ok: true, ignorado: 'sem correlationID' })

  try {
    const r = banco.confirmarPagamento(correlationId)
    if (r.situacao === 'creditada') {
      console.log(`pix confirmado: ${correlationId} -> +${r.cobranca.quantidade} vendas para ${r.cobranca.instalacaoId}`)
    } else if (r.situacao === 'repetida') {
      console.log(`pix repetido, ja creditado antes: ${correlationId}`)
    } else {
      console.warn(`pix de cobranca desconhecida: ${correlationId}`)
    }
    // Sempre 200 quando a assinatura confere: 200 é o que faz a Woovi parar de reenviar.
    res.json({ ok: true, situacao: r.situacao })
  } catch (e) {
    console.error('falhou ao confirmar pagamento:', e.message)
    res.status(500).json({ ok: false })
  }
})

app.use(express.json({ limit: '32kb' }))
app.use(express.urlencoded({ extended: false, limit: '32kb' }))
app.use(cookieParser())

// ---------------------------------------------------------------------------
// SET MESA NUVEM
// ---------------------------------------------------------------------------
//
// A linha de venda para quem nao tem Android: o dono entra por link, com senha,
// e o sistema inteiro roda aqui. Banco proprio, sessao propria, rotas proprias
// em ./nuvem — de proposito: o servidor de licencas nao pode cair porque a
// operacao de um restaurante deu errado.
// ---------------------------------------------------------------------------

app.use(rotasNuvem)

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

/**
 * A SENHA DO PAINEL PODE SER TROCADA PELA TELA (Michel, 05/09/2026).
 *
 * Antes ela só mudava editando arquivo na VPS por SSH. Isso é inaceitável para
 * algo que protege faturamento: se a senha vazar, a troca tem que levar trinta
 * segundos, do celular, e não depender de terminal.
 *
 * Enquanto ninguém trocar, vale a senha do .env. Depois da primeira troca, vale
 * a guardada no banco — e o .env deixa de importar.
 *
 * ESQUECEU A SENHA NOVA? Na VPS, isto volta a valer a do .env:
 *   docker compose exec licencas node -e "require('./src/banco').gravarConfig('senha_hash','')"
 */
function embaralhar (senha, salHex) {
  const sal = salHex || crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(senha, sal, 64).toString('hex')
  return `scrypt$${sal}$${hash}`
}

function senhaConfere (senha) {
  const guardada = banco.lerConfig('senha_hash')
  if (guardada && guardada.startsWith('scrypt$')) {
    const [, sal, esperado] = guardada.split('$')
    const calculado = crypto.scryptSync(senha, sal, 64).toString('hex')
    const a = Buffer.from(calculado, 'hex')
    const b = Buffer.from(esperado, 'hex')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  // Ainda na senha original do .env.
  const a = Buffer.from(String(senha), 'utf8')
  const b = Buffer.from(SENHA, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
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
  res.send(painel.telaPainel(banco.listar(), banco.resumo(), null, banco.listarCopias()))
})

app.post('/painel/entrar', limiteLogin, (req, res) => {
  if (!senhaConfere(String(req.body.senha || ''))) {
    return res.status(401).send(painel.telaLogin('Senha incorreta.'))
  }

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

/** Trocar a senha do painel. Exige a atual — cookie roubado não troca senha sozinho. */
app.post('/painel/senha', exigirSessao, limiteLogin, (req, res) => {
  const atual = String(req.body.atual || '')
  const nova = String(req.body.nova || '')
  const repetida = String(req.body.repetida || '')

  const erro =
    !senhaConfere(atual) ? 'Senha atual incorreta.'
    : nova.length < 10 ? 'A senha nova precisa ter pelo menos 10 caracteres.'
    : nova !== repetida ? 'A confirmação não bateu com a senha nova.'
    : null

  if (erro) return res.status(400).send(painel.telaPainel(banco.listar(), banco.resumo(), erro))

  banco.gravarConfig('senha_hash', embaralhar(nova))
  // Derruba a sessão: quem trocou entra de novo com a senha nova, e qualquer
  // outra sessão aberta em outro aparelho perde a validade junto.
  res.clearCookie('sessao')
  res.send(painel.telaLogin('Senha trocada. Entre com a nova.'))
})

// ---------------------------------------------------------------------------
// CÓPIA DE SEGURANÇA
// ---------------------------------------------------------------------------
//
// Roda sozinha todo dia e guarda 14. Mas cópia que só existe na mesma máquina
// do original não é cópia de segurança de verdade: se o disco da VPS for
// embora, os dois vão juntos. Por isso o botão de baixar no painel — leve o
// arquivo para fora, para o seu computador ou para a nuvem que você usa.

const UM_DIA = 24 * 60 * 60 * 1000

async function rotinaDeCopia () {
  try {
    const r = await banco.copiaDoDia()
    console.log(`copia do dia: ${r.arquivo} (${r.bytes} bytes)`)
  } catch (e) {
    console.error('falhou a copia do dia:', e.message)
  }
}
setTimeout(rotinaDeCopia, 30 * 1000)   // uma logo depois de subir
setInterval(rotinaDeCopia, UM_DIA)

app.get('/painel/backup', exigirSessao, async (_req, res) => {
  const dia = new Date().toISOString().slice(0, 10)
  const temporario = require('path').join(require('os').tmpdir(), `licencas-${Date.now()}.db`)
  try {
    await banco.copiarPara(temporario)
    res.download(temporario, `setmesa-licencas-${dia}.db`, () => {
      try { require('fs').unlinkSync(temporario) } catch (_) {}
    })
  } catch (e) {
    res.status(500).send(painel.telaPainel(banco.listar(), banco.resumo(),
      'Não consegui gerar a cópia: ' + e.message))
  }
})

// ---------------------------------------------------------------------------
// PÁGINA DE RECARGA DO CLIENTE
// ---------------------------------------------------------------------------
//
// Aberta de propósito: o identificador da instalação já é o segredo, o mesmo
// que protege /licenca. O pior que alguém com o link consegue fazer é pagar
// crédito para o cliente.
//
// O valor NUNCA vem do formulário — só o número de vendas, e ele tem que bater
// com um pacote cadastrado no servidor. Senão qualquer um pediria 5.000 vendas
// por um centavo.
// ---------------------------------------------------------------------------

const limiteRecarga = rateLimit({ windowMs: 60 * 1000, limit: 20 })

function instalacaoDaUrl (req, res) {
  const id = String(req.params.id || '').trim()
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) { res.status(400).send('Endereço inválido.'); return null }
  const inst = banco.buscar(id)
  if (!inst) {
    res.status(404).send(painel.pagina('Não encontrado',
      '<h1>Link não encontrado</h1><p class="sub">Confira o endereço com quem te enviou.</p>'))
    return null
  }
  return inst
}

app.get('/recarga/:id', limiteRecarga, (req, res) => {
  const inst = instalacaoDaUrl(req, res)
  if (!inst) return
  if (!woovi.configurado()) {
    return res.send(painel.pagina('Recarga',
      '<h1>Recarga automática indisponível</h1>' +
      '<p class="sub">Fale com o suporte para recarregar por enquanto.</p>'))
  }
  res.send(recarga.telaEscolha(inst, req.query.erro ? String(req.query.erro).slice(0, 200) : null))
})

app.post('/recarga/:id/criar', limiteRecarga, async (req, res) => {
  const inst = instalacaoDaUrl(req, res)
  if (!inst) return

  const pacote = recarga.acharPacote(req.body.vendas)
  if (!pacote) {
    return res.redirect(`/recarga/${encodeURIComponent(inst.id)}?erro=` +
      encodeURIComponent('Pacote inválido. Escolha um da lista.'))
  }

  const correlationId = `setmesa-${inst.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`

  try {
    const cobranca = await woovi.criarCobranca({
      correlationID: correlationId,
      valorCentavos: pacote.centavos,
      comentario: `SET Mesa · ${pacote.vendas} vendas`
    })
    banco.registrarCobranca({
      correlationId: cobranca.correlationID,
      instalacaoId: inst.id,
      quantidade: pacote.vendas,
      valorCentavos: pacote.centavos,
      brCode: cobranca.brCode,
      qrCodeImage: cobranca.qrCodeImage,
      linkPagamento: cobranca.linkPagamento
    })
    res.redirect(`/recarga/${encodeURIComponent(inst.id)}/c/${encodeURIComponent(cobranca.correlationID)}`)
  } catch (e) {
    console.error('falhou ao criar cobranca:', e.message)
    res.redirect(`/recarga/${encodeURIComponent(inst.id)}?erro=` +
      encodeURIComponent('Não consegui gerar o Pix agora. Tente de novo em um minuto.'))
  }
})

app.get('/recarga/:id/c/:cid', limiteRecarga, (req, res) => {
  const inst = instalacaoDaUrl(req, res)
  if (!inst) return
  const cob = banco.buscarCobranca(String(req.params.cid || ''))
  if (!cob || cob.instalacaoId !== inst.id) {
    return res.redirect(`/recarga/${encodeURIComponent(inst.id)}`)
  }
  res.send(recarga.telaCobranca(inst, cob))
})

// Página que o cliente abre no celular para instalar o app. Sem senha de
// propósito: o endereço precisa ser curto o bastante para ditar no telefone.
app.get('/instalar', (req, res) => res.send(instalar.tela(instalar.apple(req))))

// A VITRINE. Link para mandar no WhatsApp de quem ainda não é cliente: ele
// abre no celular dele, de qualquer marca, e mexe no sistema sem instalar nada
// e sem precisar de uma central por perto. Dados de exemplo, nada é gravado.
app.get('/demo', (_req, res) => res.send(demonstracao.tela()))

// O ARQUIVO SAI PELO DOMÍNIO DO MICHEL, NÃO PELO DO FORNECEDOR.
//
// O APK mora num repositório público do GitHub porque é lá que a compilação
// publica sozinha. Mas mandar esse endereço para um dono de restaurante é ruim
// por três motivos: é enorme, mostra a marca de outra empresa, e prende o
// produto a um fornecedor — se um dia o depósito mudar, todo link já entregue
// a cliente quebra. Aqui o servidor busca o arquivo e entrega com a cara da
// casa. O endereço que o cliente recebe nunca muda.
app.get('/baixar', async (_req, res) => {
  const origem = instalar.enderecoApk()
  if (!origem) return res.status(503).send('O aplicativo ainda nao foi configurado neste servidor.')
  try {
    const r = await fetch(origem, { redirect: 'follow' })
    if (!r.ok || !r.body) {
      console.error('baixar: origem respondeu', r.status)
      return res.status(502).send('Nao foi possivel buscar o aplicativo agora. Tente de novo em alguns minutos.')
    }
    res.setHeader('Content-Type', 'application/vnd.android.package-archive')
    res.setHeader('Content-Disposition', 'attachment; filename="SET-Mesa.apk"')
    const tamanho = r.headers.get('content-length')
    if (tamanho) res.setHeader('Content-Length', tamanho)
    console.log('download do app entregue')
    require('stream').Readable.fromWeb(r.body).pipe(res)
  } catch (erro) {
    console.error('baixar: falhou', erro.message)
    res.status(502).send('Nao foi possivel buscar o aplicativo agora. Tente de novo em alguns minutos.')
  }
})

// A RAIZ DEPENDE DE POR ONDE ENTRARAM.
// app.setbot.tech e o endereco do CLIENTE: quem digita isso quer instalar, e
// nao pode cair numa tela de senha. licencas.setbot.tech e o endereco do
// MICHEL, e continua indo direto para o painel.
app.get('/', (req, res) => {
  const host = String(req.headers.host || '').toLowerCase()
  if (host.startsWith('app.')) return res.send(instalar.tela(instalar.apple(req)))
  res.redirect('/painel')
})

app.listen(PORTA, () => {
  console.log(`SET Mesa · servidor de licenças na porta ${PORTA}`)
  console.log(`Banco: ${banco.CAMINHO}`)
  console.log(`Recarga automática: ${woovi.configurado() ? 'ligada (Woovi)' : 'DESLIGADA — falta WOOVI_APPID'}`)
  console.log('SET Mesa Nuvem: /entrar e /sistema')
})
