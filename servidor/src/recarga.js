'use strict'

const painel = require('./painel')

/**
 * A PÁGINA DE RECARGA DO CLIENTE.
 *
 * É aqui que o trabalho manual do Michel acaba. Antes: o cliente mandava Pix,
 * avisava no WhatsApp, o Michel conferia e liberava na mão, de madrugada, no
 * domingo. Agora ele manda UM link para o cliente, uma vez na vida, e o cliente
 * recarrega sozinho para sempre.
 *
 * Por que a página é aberta, sem senha: o endereço da instalação já é um
 * identificador aleatório que só o dono daquele aparelho conhece — é o mesmo
 * segredo que protege /licenca. E o pior que alguém de posse do link consegue
 * fazer é PAGAR crédito para o cliente. Não há nada a roubar aqui.
 *
 * O que a página NUNCA faz: aceitar valor livre. Os pacotes são fixos e vêm do
 * servidor. Se o valor viesse do formulário, qualquer um pediria 5.000 vendas
 * por um centavo.
 */

const PADRAO = '500:3500,1000:7000,2000:14000,5000:35000'

/** Lê PACOTES do .env no formato "vendas:centavos,vendas:centavos". */
function pacotes () {
  return String(process.env.PACOTES || PADRAO)
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const [vendas, centavos] = p.split(':')
      return { vendas: parseInt(vendas, 10), centavos: parseInt(centavos, 10) }
    })
    .filter(p => Number.isFinite(p.vendas) && Number.isFinite(p.centavos) &&
                 p.vendas > 0 && p.centavos > 0)
    .sort((a, b) => a.vendas - b.vendas)
}

function acharPacote (vendas) {
  return pacotes().find(p => p.vendas === parseInt(vendas, 10)) || null
}

const e = painel.e
const reais = painel.reais

const ESTILO_EXTRA = `
  .pacotes{display:grid;gap:10px;margin:18px 0 0}
  .pacote{display:flex;align-items:center;justify-content:space-between;gap:14px;
          background:var(--papel);border:1px solid var(--linha);border-radius:6px;
          padding:14px 16px}
  .pacote b{font-size:1.15rem}
  .pacote small{display:block;color:var(--tinta2);font-size:.85rem;font-weight:400}
  .pacote button{margin:0;white-space:nowrap}
  .qr{display:block;margin:0 auto;max-width:260px;width:100%;height:auto;
      background:#fff;padding:10px;border-radius:6px}
  .codigo{word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:12px;
          background:var(--fundo);border:1px solid var(--linha);border-radius:5px;
          padding:12px;margin:14px 0 0;line-height:1.5}
  .esperando{display:flex;align-items:center;gap:10px;color:var(--aviso);
             font-weight:600;margin:0}
  .pago{background:rgba(26,111,79,.12);border:1px solid var(--ok);color:var(--ok);
        padding:16px 18px;border-radius:6px;font-weight:600;margin:0 0 14px}
`

const pagina = (titulo, corpo, cabecaExtra = '') =>
  painel.pagina(titulo, `<style>${ESTILO_EXTRA}</style>${corpo}`)
    .replace('</head>', `${cabecaExtra}</head>`)

function telaEscolha (inst, erro) {
  const lista = pacotes().map(p => `
    <form method="post" action="/recarga/${encodeURIComponent(inst.id)}/criar" class="pacote">
      <input type="hidden" name="vendas" value="${p.vendas}">
      <span><b>${p.vendas.toLocaleString('pt-BR')} vendas</b>
        <small>${reais(p.centavos)} · ${(p.centavos / p.vendas).toFixed(2).replace('.', ',')} centavos por venda</small></span>
      <button type="submit">Gerar Pix</button>
    </form>`).join('')

  return pagina('Recarregar', `
    <h1>Recarregar vendas</h1>
    <p class="sub">${e(inst.apelido || 'Seu SET Mesa')}</p>
    ${erro ? `<div class="erro">${e(erro)}</div>` : ''}

    <div class="cartao">
      <div class="linha"><span>Saldo agora</span><span>${inst.saldo} venda(s)</span></div>
    </div>

    <h2>Escolha o pacote</h2>
    <div class="pacotes">${lista}</div>

    <p class="sub" style="margin-top:22px">O crédito entra sozinho assim que o Pix
    for confirmado. Não precisa mandar comprovante para ninguém.</p>`)
}

function telaCobranca (inst, cob) {
  const paga = cob.status === 'PAGA'

  // Enquanto não pagou, a página se recarrega sozinha. Sem JavaScript: é um
  // celular no meio do salão, e menos peça é menos coisa para quebrar.
  const recarregar = paga ? '' : '<meta http-equiv="refresh" content="6">'

  return pagina('Pague o Pix', `
    <p class="sub"><a href="/recarga/${encodeURIComponent(inst.id)}">&larr; Escolher outro pacote</a></p>
    <h1>${cob.quantidade.toLocaleString('pt-BR')} vendas</h1>
    <p class="sub">${reais(cob.valorCentavos)}</p>

    ${paga
      ? `<p class="pago">Pagamento confirmado. As ${cob.quantidade.toLocaleString('pt-BR')} vendas
         já estão liberadas.</p>
         <div class="cartao">
           <div class="linha"><span>Saldo agora</span><span>${inst.saldo} venda(s)</span></div>
         </div>
         <p class="sub">No aplicativo, toque em <b>Administração &rsaquo; Meu plano &rsaquo;
         Buscar créditos</b> para o saldo novo aparecer no aparelho.</p>`
      : `<div class="cartao">
           ${cob.qrCodeImage
             ? `<img class="qr" src="${e(cob.qrCodeImage)}" alt="QR Code do Pix">`
             : ''}
           <p class="sub" style="text-align:center;margin:14px 0 0">
             Abra o banco, escolha Pix e leia o código acima.</p>
           <p class="sub" style="text-align:center;margin:6px 0 0">
             Ou copie e cole:</p>
           <div class="codigo">${e(cob.brCode)}</div>
           ${cob.linkPagamento
             ? `<a href="${e(cob.linkPagamento)}"><button type="button" class="secundario"
                  style="width:100%">Abrir página de pagamento</button></a>`
             : ''}
         </div>
         <p class="esperando">Esperando o pagamento… esta página avisa sozinha.</p>`}`,
    recarregar)
}

module.exports = { pacotes, acharPacote, telaEscolha, telaCobranca }
