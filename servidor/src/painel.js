'use strict'

/**
 * O PAINEL, EM HTML SERVIDO PRONTO.
 *
 * Sem framework e sem build: é uma ferramenta de trabalho que o Michel abre no
 * celular depois de confirmar um Pix, libera o crédito e fecha. Quanto menos
 * peça, menos coisa para quebrar num domingo à noite.
 */

const e = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const reais = (centavos) =>
  'R$ ' + (Number(centavos || 0) / 100).toFixed(2).replace('.', ',')

const quando = (ms) => {
  if (!ms) return 'nunca'
  const d = new Date(Number(ms))
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

const ESTILO = `
  :root {
    --fundo:#eef1f0; --papel:#fff; --linha:#d3dad8; --tinta:#16211f; --tinta2:#5a6b68;
    --mar:#0f5c52; --alerta:#9c2f22; --ok:#1a6f4f; --aviso:#8a5b12;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fundo:#101615; --papel:#18211f; --linha:#2c3937; --tinta:#e6ebea; --tinta2:#a3b2af;
            --mar:#63c7b4; --alerta:#f09287; --ok:#67cba0; --aviso:#e0ac52; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--fundo);color:var(--tinta);
       font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
  .folha{max-width:900px;margin:0 auto;padding:22px 16px 70px}
  h1{font-size:1.5rem;margin:0 0 4px}
  h2{font-size:1.1rem;margin:28px 0 10px}
  .sub{color:var(--tinta2);margin:0 0 20px;font-size:.95rem}
  a{color:var(--mar)}
  .cartao{background:var(--papel);border:1px solid var(--linha);border-radius:6px;
          padding:16px 18px;margin-bottom:12px}
  .grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .kpi{background:var(--papel);border:1px solid var(--linha);border-radius:6px;padding:14px}
  .kpi b{display:block;font-size:1.4rem;font-variant-numeric:tabular-nums}
  .kpi span{color:var(--tinta2);font-size:.85rem}
  table{width:100%;border-collapse:collapse;background:var(--papel);
        border:1px solid var(--linha);border-radius:6px;overflow:hidden}
  th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--linha);font-size:.93rem}
  th{background:var(--fundo);font-size:.78rem;text-transform:uppercase;letter-spacing:.07em;
     color:var(--tinta2)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  tr:last-child td{border-bottom:none}
  .rolagem{overflow-x:auto}
  label{display:block;font-size:.85rem;color:var(--tinta2);margin:10px 0 4px}
  input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--linha);
    border-radius:5px;background:var(--papel);color:var(--tinta);font:inherit}
  button{margin-top:14px;padding:11px 18px;border:none;border-radius:5px;
    background:var(--mar);color:var(--papel);font:inherit;font-weight:600;cursor:pointer}
  @media (prefers-color-scheme: dark){ button{color:#101615} }
  .secundario{background:transparent;color:var(--mar);border:1px solid var(--mar)}
  .selo{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.76rem;font-weight:600}
  .selo.ok{background:rgba(26,111,79,.14);color:var(--ok)}
  .selo.zero{background:rgba(156,47,34,.14);color:var(--alerta)}
  .selo.bloq{background:rgba(138,91,18,.16);color:var(--aviso)}
  .erro{background:rgba(156,47,34,.12);border:1px solid var(--alerta);color:var(--alerta);
        padding:12px 14px;border-radius:5px;margin-bottom:14px}
  .linha{display:flex;justify-content:space-between;gap:12px;padding:6px 0}
  .linha span:last-child{font-variant-numeric:tabular-nums;font-weight:600}
  code{background:var(--fundo);padding:2px 6px;border-radius:4px;font-size:.9em}
`

const pagina = (titulo, corpo) => `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(titulo)} · SET Mesa</title><style>${ESTILO}</style>
</head><body><div class="folha">${corpo}</div></body></html>`

function telaLogin (erro) {
  return pagina('Entrar', `
    <h1>SET Mesa</h1>
    <p class="sub">Painel de licenças e créditos</p>
    ${erro ? `<div class="erro">${e(erro)}</div>` : ''}
    <form method="post" action="/painel/entrar" class="cartao">
      <label for="senha">Senha do painel</label>
      <input id="senha" name="senha" type="password" autocomplete="current-password" autofocus>
      <button type="submit">Entrar</button>
    </form>`)
}

function selo (inst) {
  if (inst.bloqueado === 1) return '<span class="selo bloq">bloqueado</span>'
  if (inst.saldo <= 0) return '<span class="selo zero">sem saldo</span>'
  return `<span class="selo ok">${inst.saldo} venda(s)</span>`
}

function telaPainel (lista, resumo, erro) {
  const linhas = lista.map(i => `
    <tr>
      <td><a href="/painel/instalacao/${encodeURIComponent(i.id)}">${e(i.apelido || i.id)}</a>
          <div style="color:var(--tinta2);font-size:.82rem"><code>${e(i.id)}</code></div></td>
      <td>${selo(i)}</td>
      <td class="num">${i.creditosComprados}</td>
      <td class="num">${i.vendasConsumidas}</td>
      <td style="color:var(--tinta2);font-size:.85rem">${e(quando(i.vistoEm))}</td>
    </tr>`).join('')

  return pagina('Painel', `
    <h1>Licenças</h1>
    <p class="sub">Confirmou o Pix? Abra a instalação e libere as vendas.</p>
    ${erro ? `<div class="erro">${e(erro)}</div>` : ''}

    <div class="grade">
      <div class="kpi"><b>${resumo.instalacoes}</b><span>instalações</span></div>
      <div class="kpi"><b>${resumo.ativas30dias}</b><span>ativas em 30 dias</span></div>
      <div class="kpi"><b>${resumo.creditosVendidos}</b><span>vendas vendidas</span></div>
      <div class="kpi"><b>${resumo.vendasProcessadas}</b><span>vendas processadas</span></div>
      <div class="kpi"><b>${resumo.semSaldo}</b><span>sem saldo agora</span></div>
    </div>

    <h2>Instalações</h2>
    ${lista.length === 0
      ? `<div class="cartao">Nenhuma instalação ainda. Elas aparecem sozinhas aqui na
         primeira vez que o app consultar o servidor.</div>`
      : `<div class="rolagem"><table>
          <tr><th>Cliente</th><th>Saldo</th><th class="num">Comprado</th>
              <th class="num">Vendido</th><th>Última consulta</th></tr>
          ${linhas}
         </table></div>`}

    <form method="post" action="/painel/sair"><button class="secundario" type="submit">Sair</button></form>`)
}

function telaInstalacao (inst, recargas, erro) {
  const historico = recargas.map(r => `
    <tr>
      <td>${e(quando(r.criadoEm))}</td>
      <td class="num">+${r.quantidade}</td>
      <td class="num">${e(reais(r.valorCentavos))}</td>
      <td style="color:var(--tinta2)">${e(r.observacao)}</td>
    </tr>`).join('')

  return pagina(inst.apelido || inst.id, `
    <p class="sub"><a href="/painel">&larr; Todas as instalações</a></p>
    <h1>${e(inst.apelido || 'Sem nome ainda')}</h1>
    <p class="sub"><code>${e(inst.id)}</code></p>
    ${erro ? `<div class="erro">${e(erro)}</div>` : ''}

    <div class="cartao">
      <div class="linha"><span>Vendas compradas</span><span>${inst.creditosComprados}</span></div>
      <div class="linha"><span>Vendas já feitas</span><span>${inst.vendasConsumidas}</span></div>
      <div class="linha" style="border-top:1px solid var(--linha);margin-top:6px;padding-top:10px">
        <span><b>Saldo agora</b></span><span>${inst.saldo}</span></div>
      <div class="linha"><span>Última consulta do app</span><span>${e(quando(inst.vistoEm))}</span></div>
      ${inst.versaoApp ? `<div class="linha"><span>Versão do app</span><span>${e(inst.versaoApp)}</span></div>` : ''}
    </div>

    <h2>Liberar vendas</h2>
    <form method="post" action="/painel/creditar" class="cartao">
      <input type="hidden" name="id" value="${e(inst.id)}">
      <label for="q">Quantas vendas liberar</label>
      <input id="q" name="quantidade" type="number" min="1" step="1" value="100" required>
      <label for="v">Valor recebido (R$) — só para o seu controle</label>
      <input id="v" name="valor" type="text" inputmode="decimal" placeholder="0,00">
      <label for="o">Observação</label>
      <input id="o" name="observacao" type="text" placeholder="Pix confirmado em 03/09">
      <button type="submit">Liberar vendas</button>
    </form>

    <h2>Cadastro</h2>
    <form method="post" action="/painel/cadastro" class="cartao">
      <input type="hidden" name="id" value="${e(inst.id)}">
      <label for="a">Nome do cliente</label>
      <input id="a" name="apelido" type="text" value="${e(inst.apelido)}" placeholder="Quiosque do Zé">
      <label for="p">Plano</label>
      <select id="p" name="plano">
        <option value=""                ${inst.plano === '' ? 'selected' : ''}>não definido</option>
        <option value="SEM_IMPRESSORA"  ${inst.plano === 'SEM_IMPRESSORA' ? 'selected' : ''}>sem impressora · R$ 0,07</option>
        <option value="COM_IMPRESSORA"  ${inst.plano === 'COM_IMPRESSORA' ? 'selected' : ''}>com impressora · R$ 0,13</option>
      </select>
      <label for="m">Recado que aparece no app</label>
      <textarea id="m" name="mensagem" rows="2" placeholder="Vazio = nenhum recado">${e(inst.mensagem)}</textarea>
      <label style="display:flex;align-items:center;gap:8px;margin-top:14px">
        <input type="checkbox" name="bloqueado" style="width:auto" ${inst.bloqueado === 1 ? 'checked' : ''}>
        Bloquear este cliente
      </label>
      <button type="submit">Salvar cadastro</button>
    </form>

    <h2>Histórico de liberações</h2>
    ${recargas.length === 0
      ? '<div class="cartao">Nenhuma liberação ainda.</div>'
      : `<div class="rolagem"><table>
          <tr><th>Quando</th><th class="num">Vendas</th><th class="num">Valor</th><th>Observação</th></tr>
          ${historico}
         </table></div>`}`)
}

module.exports = { telaLogin, telaPainel, telaInstalacao }
