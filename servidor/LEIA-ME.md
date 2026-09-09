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

## Trocar a senha do painel

Direto na tela, no fim do painel: senha atual, senha nova, repetir. Trocar
derruba todas as sessões abertas, inclusive em outros aparelhos — que é o que
você quer se desconfiar que alguém viu a senha.

A senha nova fica guardada no banco, como hash. O valor do `.env` deixa de
valer a partir da primeira troca.

**Esqueceu a senha nova?** Na VPS, isto faz voltar a valer a do `.env`:

```bash
cd /opt/setmesa-servidor/servidor
docker compose exec licencas node -e "require('./src/banco').gravarConfig('senha_hash','')"
```

## Recarga automática por Pix (Woovi)

**É isto que acaba com o trabalho manual.** Você manda UM link para o cliente,
uma vez na vida. Ele escolhe o pacote, paga o Pix, e o crédito entra sozinho.
Você não confere nada, não abre o painel, não é acordado no domingo.

### Ligar

1. Crie a conta na Woovi e gere um **AppID** (no painel deles, em Api/Plugins).
2. No `.env` da VPS, preencha:
   ```
   WOOVI_APPID=o-appid-que-voce-gerou
   PUBLICO_URL=https://licencas.setbot.tech
   PACOTES=500:3500,1000:7000,2000:14000,5000:35000
   ```
3. No painel da Woovi, cadastre o webhook apontando para:
   `https://SEU-ENDERECO/webhook/woovi`
4. `docker compose up -d --build`

Sem `WOOVI_APPID`, a recarga automática fica desligada e o painel manual
continua funcionando igual. Nada quebra por deixar em branco.

### Usar

Abra a instalação no painel: o **link de recarga do cliente** aparece lá em
cima, pronto para copiar. Mande no WhatsApp. Acabou.

### A trava que protege o faturamento

O aviso de pagamento chega num endereço aberto na internet — tem que ser
assim. **Todo aviso é conferido contra a assinatura da Woovi antes de creditar
qualquer coisa.** Sem isso, quem descobrisse o endereço mandava um "pago" e
ganhava crédito de graça.

Duas coisas que NÃO podem ser mexidas sem entender o que fazem:

- A rota `/webhook/woovi` usa `express.raw` e fica **antes** do
  `express.json`. A assinatura vale sobre os bytes brutos; se um parser de JSON
  passar na frente, a conferência falha sempre — e o conserto tentador seria
  desligar a conferência. Não desligue.
- O crédito entra dentro de uma transação que só roda se a cobrança **ainda não
  estava paga**. A Woovi reenvia aviso; sem essa trava, o mesmo Pix creditava
  duas ou três vezes.

Os pacotes vêm do servidor, nunca do formulário do cliente. Se o valor viesse
da tela, qualquer um pediria 5.000 vendas por um centavo.

### Conferir que continua de pé

```bash
cd servidor && npm run teste
```

Prova, sem tocar na Woovi de verdade: aviso sem assinatura é recusado, aviso
forjado é recusado, aviso com o corpo adulterado é recusado, aviso legítimo
credita uma vez, aviso repetido não credita de novo, e o app enxerga o saldo
novo. **Rode isso depois de qualquer mexida no servidor.**

## O dia a dia, quando a recarga automática está desligada

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
| `/recarga/<instalacao>` | a página que o cliente usa para recarregar sozinho |
| `POST /webhook/woovi` | por onde a Woovi avisa que o Pix caiu (assinatura conferida) |

## Guardar o banco

O banco é o seu faturamento: quem comprou quanto, quem está sem saldo, todo o
histórico de recarga. Perder isso é perder a cobrança de todos os clientes de
uma vez.

**O servidor já faz sozinho.** Uma cópia por dia, guardando as 14 últimas, em
`/dados/copias` dentro do volume. Ela usa o mecanismo próprio do SQLite, não
`cp` — o banco roda em modo WAL, e cópia feita com `cp` pode sair pela metade.

**Mas cópia na mesma máquina do original não é cópia de segurança.** Se o disco
da VPS for embora, os dois vão juntos. Por isso existe o botão **Baixar cópia
agora** no painel: leve o arquivo para o seu computador ou para a nuvem que você
usa, de tempos em tempos.

Para restaurar, é só parar o container, pôr o arquivo no lugar do banco e subir
de novo:

```bash
cd /opt/setmesa-servidor/servidor
docker compose down
docker run --rm -v licencas-dados:/dados -v $(pwd):/aqui alpine \
  sh -c 'cp /aqui/setmesa-licencas-AAAA-MM-DD.db /dados/setmesa-licencas.db'
docker compose up -d
```

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
- Plano com teto de R$ 249 (assinatura mensal que completa o saldo sozinho).
- Cartão recorrente (Asaas), para quem não quiser fazer Pix todo mês.

## Nunca testado

A recarga automática foi provada contra uma Woovi de mentira, no teste
automatizado. **Nenhum Pix de verdade passou por ela ainda.** O primeiro
precisa ser um seu, de valor pequeno, com você olhando o log:

```bash
docker compose logs -f licencas
```

O que tem que aparecer: `pix confirmado: setmesa-... -> +500 vendas para ...`
