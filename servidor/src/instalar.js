'use strict'

const painel = require('./painel')
const e = painel.e

/**
 * A PÁGINA DE INSTALAÇÃO.
 *
 * Nasceu de um problema real do teste de rua: em vários celulares o APK não
 * baixava ou não instalava. As causas não são falha do app — são as travas do
 * Android contra aplicativo de fora da Play Store, e ninguém que não é técnico
 * passa por elas sozinho.
 *
 * Esta página existe para o cliente conseguir instalar sem o Michel do lado.
 * Endereço curto, sem senha, no domínio dele: dá para ditar no telefone.
 */

const APK = process.env.APK_URL || ''

const PASSOS = [
  {
    titulo: 'Toque em Baixar o aplicativo',
    texto: 'O download leva alguns segundos. Se o navegador perguntar se você quer ' +
           'mesmo baixar este tipo de arquivo, responda que sim.'
  },
  {
    titulo: 'Abra o arquivo baixado',
    texto: 'Ele aparece na barra de notificações ou na pasta Downloads, com o nome ' +
           'SET-Mesa.apk.'
  },
  {
    titulo: 'Se aparecer "instalação bloqueada"',
    texto: 'O celular pede permissão para instalar aplicativos que não vieram da loja. ' +
           'Toque em Configurações, ligue a chave "Permitir desta fonte" e volte. ' +
           'Isso vale só para este aplicativo.'
  },
  {
    titulo: 'Se aparecer "app não verificado" ou "app prejudicial"',
    texto: 'É o Play Protect avisando que não conhece o aplicativo — ele avisa isso de ' +
           'qualquer app que não venha da loja. Toque em "Mais detalhes" e depois em ' +
           '"Instalar mesmo assim".'
  },
  {
    titulo: 'Pronto',
    texto: 'O SET Mesa aparece na lista de aplicativos. Da segunda vez em diante, a ' +
           'atualização instala por cima, sem desinstalar nada.'
  }
]

const ESTILO_EXTRA = `
  .passos{counter-reset:p;display:grid;gap:10px;margin:20px 0 0;padding:0;list-style:none}
  .passos li{counter-increment:p;background:var(--papel);border:1px solid var(--linha);
             border-radius:6px;padding:14px 16px 14px 50px;position:relative}
  .passos li::before{content:counter(p);position:absolute;left:16px;top:14px;
    width:22px;height:22px;border-radius:50%;background:var(--mar);color:var(--papel);
    display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
  @media (prefers-color-scheme: dark){ .passos li::before{color:#101615} }
  .passos b{display:block;margin-bottom:3px}
  .passos span{color:var(--tinta2);font-size:.94rem;line-height:1.5}
  .baixar{display:block;text-align:center;background:var(--mar);color:var(--papel);
          text-decoration:none;padding:16px;border-radius:6px;font-weight:700;
          font-size:1.12rem;margin:20px 0 0}
  @media (prefers-color-scheme: dark){ .baixar{color:#101615} }
  .naoserve{background:rgba(138,91,18,.12);border:1px solid var(--aviso);color:var(--aviso);
            padding:14px 16px;border-radius:6px;margin:22px 0 0;font-size:.94rem}
`

function tela () {
  const passos = PASSOS.map(p =>
    `<li><b>${e(p.titulo)}</b><span>${e(p.texto)}</span></li>`).join('')

  return painel.pagina('Instalar o SET Mesa', `
    <style>${ESTILO_EXTRA}</style>
    <h1>Instalar o SET Mesa</h1>
    <p class="sub">Funciona em celular e tablet Android, do Android 5 para cima.</p>

    ${APK
      ? `<a class="baixar" href="${e(APK)}">Baixar o aplicativo</a>`
      : `<div class="erro">O endereço do aplicativo ainda não foi configurado
         neste servidor (APK_URL).</div>`}

    <h2>Se o celular reclamar</h2>
    <p class="sub">Ele vai reclamar. É normal: todo aplicativo instalado fora da
       loja passa por isso. Siga na ordem.</p>
    <ol class="passos">${passos}</ol>

    <div class="naoserve">
      <b>iPhone não instala.</b> O SET Mesa é um aplicativo Android. Em iPhone e
      iPad ele não abre — nem baixando, nem por link. Use um aparelho Android.
    </div>

    <p class="sub" style="margin-top:24px">Deu errado mesmo assim? Chame o suporte
       e diga em que passo parou.</p>`)
}

module.exports = { tela, configurado: () => APK.length > 0 }
