'use strict'
/**
 * PROVA DA RECARGA AUTOMÁTICA.
 * Não testa a Woovi — testa o que é NOSSO e o que quebra dinheiro:
 *   1. aviso sem assinatura ou com assinatura forjada é RECUSADO e não credita;
 *   2. aviso legítimo credita exatamente uma vez;
 *   3. o mesmo aviso repetido NÃO credita de novo;
 *   4. o app enxerga o saldo novo em /licenca.
 */
const crypto = require('crypto')
const http = require('http')
const fs = require('fs')

const TMP = '/tmp/setmesa-prova.db'
try { fs.unlinkSync(TMP) } catch (_) {}
try { fs.unlinkSync(TMP + '-wal') } catch (_) {}
try { fs.unlinkSync(TMP + '-shm') } catch (_) {}

// Par de chaves só do teste: com ele conseguimos ASSINAR como a Woovi assinaria,
// e assim provar que a verificação aceita o legítimo e recusa o forjado.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const pubPem = publicKey.export({ type: 'spki', format: 'pem' })

// Woovi de mentira: devolve uma cobrança como a de verdade devolveria.
const stub = http.createServer((req, res) => {
  let corpo = ''
  req.on('data', d => { corpo += d })
  req.on('end', () => {
    const pedido = JSON.parse(corpo || '{}')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      charge: {
        value: pedido.value,
        correlationID: pedido.correlationID,
        status: 'ACTIVE',
        brCode: '00020101021226880014br.gov.bcb.pix-TESTE',
        qrCodeImage: 'https://exemplo/qr.png',
        paymentLinkUrl: 'https://exemplo/pay/123'
      }
    }))
  })
})

process.env.BANCO = TMP
process.env.PAINEL_SENHA = 'senha-de-teste-longa'
process.env.SESSAO_SEGREDO = 'segredo-de-teste-longo'
process.env.PORTA = '8899'
process.env.WOOVI_APPID = 'appid-de-teste'
process.env.WOOVI_API = 'http://127.0.0.1:9999/api/v1'
process.env.WOOVI_CHAVE_PUBLICA = Buffer.from(pubPem).toString('base64')
process.env.PUBLICO_URL = 'https://exemplo.test'

const B = 'http://127.0.0.1:8899'
const INST = 'teste-instalacao-01'

const assinar = (texto) => {
  const s = crypto.createSign('sha256'); s.write(texto); s.end()
  return s.sign(privateKey, 'base64')
}

let falhas = 0
const ok = (cond, texto) => {
  console.log(`${cond ? '  OK  ' : ' FALHA'} · ${texto}`)
  if (!cond) falhas++
}

const saldo = async () => {
  const r = await fetch(`${B}/licenca?instalacao=${INST}&vendas=0&versao=teste`)
  return (await r.json()).creditos
}

const mandarWebhook = (corpoTexto, assinatura) =>
  fetch(`${B}/webhook/woovi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(assinatura ? { 'x-webhook-signature': assinatura } : {}) },
    body: corpoTexto
  })

;(async () => {
  stub.listen(9999)
  require('../src/servidor.js')
  await new Promise(r => setTimeout(r, 700))

  console.log('\n=== 1. instalação nova aparece com saldo zero ===')
  ok(await saldo() === 0, 'saldo inicial é 0')

  console.log('\n=== 2. cliente abre o link e gera o Pix de 500 vendas ===')
  const criar = await fetch(`${B}/recarga/${INST}/criar`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'vendas=500',
    redirect: 'manual'
  })
  ok(criar.status === 302, `redirecionou para a tela do Pix (status ${criar.status})`)
  const destino = criar.headers.get('location') || ''
  const correlationId = decodeURIComponent(destino.split('/c/')[1] || '')
  ok(correlationId.startsWith('setmesa-'), `cobrança criada: ${correlationId}`)

  const tela = await (await fetch(B + destino)).text()
  ok(tela.includes('br.gov.bcb.pix-TESTE'), 'a tela mostra o copia-e-cola do Pix')
  ok(tela.includes('Esperando o pagamento'), 'a tela diz que está esperando')

  console.log('\n=== 3. o cliente não escolhe o preço ===')
  const foraDaTabela = await fetch(`${B}/recarga/${INST}/criar`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'vendas=99999', redirect: 'manual'
  })
  ok((foraDaTabela.headers.get('location') || '').includes('erro='), 'pacote fora da tabela recusado')

  // Pacote válido, mas com um valor colado no formulário: o servidor tem que
  // ignorar o valor do cliente e cobrar o da tabela.
  const tentaPrecoProprio = await fetch(`${B}/recarga/${INST}/criar`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'vendas=5000&valor=1&centavos=1&valorCentavos=1', redirect: 'manual'
  })
  const cidGolpe = decodeURIComponent((tentaPrecoProprio.headers.get('location') || '').split('/c/')[1] || '')
  const bancoTeste = require('../src/banco.js')
  const cobGolpe = bancoTeste.buscarCobranca(cidGolpe)
  ok(cobGolpe && cobGolpe.valorCentavos === 35000,
     `valor mandado pelo cliente ignorado: cobrança saiu por R$ ${(cobGolpe ? cobGolpe.valorCentavos : 0) / 100} (tabela), não R$ 0,01`)
  ok(cobGolpe && cobGolpe.quantidade === 5000, 'quantidade veio da tabela do servidor')

  const aviso = JSON.stringify({
    event: 'OPENPIX:CHARGE_COMPLETED',
    charge: { correlationID: correlationId, status: 'COMPLETED', value: 3500 }
  })

  console.log('\n=== 4. A FECHADURA: aviso sem assinatura e com assinatura forjada ===')
  const semAssinatura = await mandarWebhook(aviso, null)
  ok(semAssinatura.status === 401, `sem assinatura → recusado (${semAssinatura.status})`)
  ok(await saldo() === 0, 'não creditou nada')

  const forjada = await mandarWebhook(aviso, Buffer.from('assinatura-inventada').toString('base64'))
  ok(forjada.status === 401, `assinatura forjada → recusada (${forjada.status})`)
  ok(await saldo() === 0, 'não creditou nada')

  const outraChave = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const s2 = crypto.createSign('sha256'); s2.write(aviso); s2.end()
  const deOutraChave = await mandarWebhook(aviso, s2.sign(outraChave.privateKey, 'base64'))
  ok(deOutraChave.status === 401, `assinado por outra chave → recusado (${deOutraChave.status})`)
  ok(await saldo() === 0, 'não creditou nada')

  const adulterado = aviso.replace('3500', '999999')
  const comAssinaturaDoOriginal = await mandarWebhook(adulterado, assinar(aviso))
  ok(comAssinaturaDoOriginal.status === 401, `corpo adulterado → recusado (${comAssinaturaDoOriginal.status})`)

  console.log('\n=== 5. aviso legítimo credita ===')
  const bom = await mandarWebhook(aviso, assinar(aviso))
  const respostaBoa = await bom.json()
  ok(bom.status === 200 && respostaBoa.situacao === 'creditada', `aceito e creditado (${JSON.stringify(respostaBoa)})`)
  ok(await saldo() === 500, `saldo virou 500 (está ${await saldo()})`)

  console.log('\n=== 6. o MESMO aviso repetido não credita de novo ===')
  const rep1 = await mandarWebhook(aviso, assinar(aviso))
  const rep2 = await mandarWebhook(aviso, assinar(aviso))
  ok(rep1.status === 200 && (await rep1.json()).situacao === 'repetida', 'segundo aviso: marcado como repetido')
  ok(rep2.status === 200, 'terceiro aviso: respondeu 200 (para a Woovi parar de reenviar)')
  ok(await saldo() === 500, `saldo continua 500 (está ${await saldo()})`)

  console.log('\n=== 7. cobrança que não existe não quebra o servidor ===')
  const fantasma = JSON.stringify({ event: 'OPENPIX:CHARGE_COMPLETED', charge: { correlationID: 'nao-existe-123' } })
  const rf = await mandarWebhook(fantasma, assinar(fantasma))
  ok(rf.status === 200 && (await rf.json()).situacao === 'desconhecida', 'cobrança desconhecida tratada sem erro')

  console.log('\n=== 8. a tela do cliente mostra pago, e o app enxerga o saldo ===')
  const telaPaga = await (await fetch(B + destino)).text()
  ok(telaPaga.includes('Pagamento confirmado'), 'a tela virou "Pagamento confirmado"')
  const r = await fetch(`${B}/licenca?instalacao=${INST}&vendas=12&versao=0.7`)
  const j = await r.json()
  ok(j.creditos === 488, `app relatou 12 vendas feitas e recebeu saldo 488 (recebeu ${j.creditos})`)

  console.log(`\n${falhas === 0 ? 'TUDO PASSOU' : falhas + ' FALHA(S)'}\n`)
  process.exit(falhas === 0 ? 0 : 1)
})().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1) })
