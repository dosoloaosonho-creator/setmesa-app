# Subir o servidor na VPS — passo a passo

Copie e cole um bloco de cada vez. Se algum passo devolver erro, pare e me mande
o que apareceu na tela.

---

## 1. Entrar na VPS

Pelo terminal do seu computador, ou pelo terminal do navegador no painel da
Hostinger (hPanel → VPS → Terminal):

```bash
ssh root@SEU-IP-DA-VPS
```

---

## 2. Descobrir o que já está rodando

Isto não muda nada — só olha. **Me mande a saída inteira**, é ela que diz como
vamos publicar o endereço com HTTPS depois.

```bash
echo "=== CONTAINERS ==="
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
echo
echo "=== PORTAS OCUPADAS ==="
ss -tlnp | grep -E ':(80|443|8080|8081|5678) ' || echo "80, 443 e 8081 livres"
echo
echo "=== ESPAÇO ==="
df -h / | tail -1
```

Se a porta 8081 aparecer ocupada, me avise — escolho outra.

---

## 3. Baixar o código

O código do servidor é público. Não há segredo nele: a senha do painel fica no
arquivo `.env`, que você cria na VPS e nunca sai de lá.

```bash
mkdir -p /opt && cd /opt
git clone --depth 1 https://github.com/dosoloaosonho-creator/setmesa-app.git setmesa-servidor
cd setmesa-servidor/servidor
ls
```

Você deve ver: `Dockerfile`, `docker-compose.yml`, `src`, `package.json`.

---

## 4. Criar as senhas

```bash
cp .env.exemplo .env
sed -i "s|^PAINEL_SENHA=.*|PAINEL_SENHA=$(openssl rand -base64 18)|" .env
sed -i "s|^SESSAO_SEGREDO=.*|SESSAO_SEGREDO=$(openssl rand -base64 32)|" .env
grep PAINEL_SENHA .env
```

**Anote a senha que apareceu.** É com ela que você entra no painel. Ela está
guardada no `.env` da VPS, então dá para consultar depois com o mesmo `grep`.

---

## 5. Subir

```bash
docker compose up -d --build
docker compose logs --tail 20
```

Deve aparecer `SET Mesa · servidor de licenças na porta 8080`.

A primeira vez demora alguns minutos: ele compila uma peça do banco de dados.

---

## 6. Conferir que está de pé

```bash
curl -s http://127.0.0.1:8081/saude
```

Resposta esperada, com os números zerados:

```json
{"ok":true,"agora":"...","instalacoes":0,"ativas30dias":0,...}
```

Agora pelo IP, que é o que o celular vai usar:

```bash
curl -s http://$(curl -s ifconfig.me):8081/saude
```

Se este segundo comando não responder, é o firewall da VPS. Libere a porta:

```bash
ufw allow 8081/tcp && ufw status
```

---

## 7. Abrir o painel

No navegador do celular ou do computador:

```
http://SEU-IP-DA-VPS:8081/painel
```

Entre com a senha do passo 4. A lista vai estar vazia — é o esperado.

---

## 8. Ligar o app

No app, versão 0.7 ou maior:

**Administração → Meu plano → endereço do servidor**

```
http://SEU-IP-DA-VPS:8081
```

Sem barra no fim. O app monta o caminho sozinho.

Toque em **Buscar créditos**. Duas coisas devem acontecer:

- o app diz que consultou (saldo zero, e está certo);
- **a instalação aparece sozinha no painel**, com um código tipo `A7K2M9QX`.

É esse aparecer sozinho que prova que os dois estão conversando.

---

## 9. O teste que fecha o assunto

No painel, abra a instalação que apareceu e libere **100 vendas**. No app, toque
em **Buscar créditos** de novo: o saldo tem que virar 100.

Depois faça algumas vendas no app, volte e busque créditos outra vez. O saldo
tem que cair pelo número de vendas que você fez, e o painel tem que mostrar
essas vendas na coluna "Vendido".

---

## Antes do primeiro cliente pagante

Este passo a passo usa HTTP puro, sem certificado, porque ainda não há domínio.
**Serve para testar, não para operar.** Em HTTP, a senha do painel viaja aberta
na rede.

Quando você tiver um domínio ou subdomínio apontando para a VPS, me avise: eu
monto o Caddy no mesmo compose, que tira certificado do Let's Encrypt sozinho e
renova sem ninguém mexer. Aí o `BIND=0.0.0.0` sai do `.env`, a porta volta a
ficar fechada, e o endereço do app passa a ser `https://`.

---

## Comandos do dia a dia

```bash
cd /opt/setmesa-servidor/servidor

docker compose logs -f          # ver o que está acontecendo
docker compose restart          # reiniciar
docker compose down             # parar (o banco continua guardado)
git pull && docker compose up -d --build    # atualizar quando eu mandar versão nova
```

## Cópia de segurança do banco

O banco é o seu faturamento. Antes do primeiro cliente pagante, ponha isto num
cron diário e mande o arquivo para fora da VPS:

```bash
cd /opt/setmesa-servidor/servidor
docker compose exec -T licencas sh -c 'cat /dados/setmesa-licencas.db' > ~/backup-licencas-$(date +%F).db
ls -lh ~/backup-licencas-*.db
```
