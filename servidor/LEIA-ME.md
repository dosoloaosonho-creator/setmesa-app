# Servidor de licenças do SET Mesa

O app funciona 100% offline. Este servidor existe para uma coisa só: **guardar
quantas vendas cada cliente comprou**, para o Michel liberar crédito depois de
confirmar um Pix, sem depender de código digitado ou de boleto.

## A conta, em uma linha

```
saldo = vendas compradas − vendas já feitas
```

O **servidor** é dono do que foi comprado. Só cresce, e só o Michel mexe.
O **app** é dono do que foi vendido. Só cresce, e ele conta offline.

Isso resolve três coisas de uma vez:

- **Venda de graça, não.** Se o servidor devolvesse o total comprado, cada
  sincronização repunha o crédito gasto.
- **Cortesia se paga sozinha.** A venda feita na cortesia entra no total vendido
  e é cobrada na recarga seguinte. Ninguém precisa lembrar de descontar nada.
- **Reinstalar não zera a dívida.** Se o app voltar relatando menos vendas do que
  o servidor já viu, o servidor mantém o número maior.

## Subir na VPS

Ele foi feito para conviver com o que já roda lá — n8n, Evolution API — **sem
encostar em nada**: container próprio, volume próprio, banco em arquivo próprio.

```bash
cd servidor
cp .env.exemplo .env
nano .env                      # troque PAINEL_SENHA e SESSAO_SEGREDO
docker compose up -d --build
docker compose logs -f
```

Confira se subiu:

```bash
curl http://127.0.0.1:8081/saude
```

### HTTPS é obrigatório antes de usar de verdade

O compose publica só em `127.0.0.1:8081` de propósito. **Não abra essa porta na
internet direto**: o painel tem senha, e senha em HTTP viaja aberta na rede.

Ponha um proxy na frente (Nginx Proxy Manager, Traefik, Caddy — o que já estiver
na máquina), aponte um subdomínio para `127.0.0.1:8081` e ative o certificado
grátis do Let's Encrypt. Depois disso, o endereço do servidor é o subdomínio.

## Ligar o app nele

No app: **Administração → Meu plano → endereço do servidor**. Coloque a URL
completa, com `https://`. Exemplo: `https://licencas.seudominio.com.br`

O app monta sozinho o caminho `/licenca`.

## O dia a dia

1. O cliente faz o Pix e te avisa no WhatsApp.
2. Você abre `https://seu-endereco/painel` no celular.
3. Acha o cliente na lista, toca, digita quantas vendas e confirma.
4. O cliente toca em "Buscar créditos" no app — ou o app puxa sozinho quando
   pegar sinal.

Instalação nova aparece sozinha na lista na primeira vez que o app consultar,
com saldo zero. É assim que você descobre que alguém instalou.

## Endereços

| Endereço | Para quê |
|---|---|
| `GET /licenca?instalacao=X&vendas=N&versao=V` | o que o app consulta |
| `GET /saude` | conferir se está de pé, e os números do dia |
| `/painel` | onde você libera crédito |

## Guardar o banco

O banco é um arquivo dentro do volume `licencas-dados`. **É o seu faturamento.**
Cópia de segurança:

```bash
docker compose exec licencas sh -c 'cat /dados/setmesa-licencas.db' > backup-$(date +%F).db
```

Vale a pena colocar isso num cron diário e mandar para fora da VPS.

## Por que SQLite e não um banco separado

Um arquivo garante melhor do que qualquer configuração que este projeto não
encosta no da SEVEN AI: não há servidor de banco compartilhado, não há usuário
que possa ser confundido, não há como um derrubar o outro.

Para a escala disto — algumas centenas de instalações consultando poucas vezes
por dia — SQLite sobra. Se um dia precisar de PostgreSQL, só `src/banco.js` muda;
o resto do servidor não sabe qual banco está embaixo.

## O que ainda NÃO existe aqui

- Sincronização das vendas em si (o servidor só conhece o total, não cada venda).
- Painel do dono para ver o movimento do restaurante dele.
- Cobrança automática. Você continua confirmando o Pix na mão.

Essas três coisas são o caminho da nuvem, que ainda é decisão em aberto.
